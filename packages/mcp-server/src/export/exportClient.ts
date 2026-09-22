import { createClient } from 'graphql-ws';
import { log } from '../host';
import { createAuthenticatedWebSocketTransport } from '../sessions/graphqlWsTransport';
import type { Session } from '../sessions/index';
import {
	collectExportOutcome,
	EXPORT_OBJECTS_SUBSCRIPTION,
	redactExportError,
	type ExportObjectsSuccess,
	type ExportProgress,
} from './exportObjects';

interface SubscriptionResult {
	data?: { exportObjects?: unknown } | null;
	errors?: readonly { message?: unknown }[];
}

async function* payloadsOf(
	results: AsyncIterable<SubscriptionResult>,
	secrets: readonly string[],
	operationName: string,
	signal?: AbortSignal,
): AsyncIterable<unknown> {
	for await (const result of results) {
		if (signal?.aborted) throw new Error(`${operationName} was cancelled.`);
		if (result.errors?.length) {
			const messages = result.errors.map(error => redactExportError(error.message, secrets));
			throw new Error(`GraphQL error: ${messages.join('; ')}`);
		}
		yield result.data?.exportObjects;
	}
}

export interface ExportTransportOptions {
	session: Session;
	/** Generic exportObjects requests. Preferred for new object types. */
	objects?: readonly ExportRequestObject[];
	/** Backward-compatible workflow-only shorthand. */
	workflowIds?: readonly string[];
	inactivityTimeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (progress: ExportProgress) => void;
	operationName?: string;
	fallbackFilename?: string;
}

export interface ExportRequestObject {
	type: 'workflow' | 'template' | 'form';
	id: string;
}

function requestsFrom(options: ExportTransportOptions): readonly ExportRequestObject[] {
	if (options.objects) return options.objects;
	return (options.workflowIds ?? []).map(id => ({ type: 'workflow', id }));
}

function defaultOperationName(objects: readonly ExportRequestObject[]): string {
	const types = new Set(objects.map(object => object.type));
	if (types.size !== 1) return 'Rewst export';
	const type = objects[0]?.type;
	return `${type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Rewst'} export`;
}

function defaultFallbackFilename(objects: readonly ExportRequestObject[]): string {
	const types = new Set(objects.map(object => object.type));
	if (types.size !== 1) return 'rewst-export.json';
	const type = objects[0]?.type;
	return type ? `rewst-${type}s-export.json` : 'rewst-export.json';
}

/** Runs the authenticated Rewst exportObjects subscription to strict success. */
export async function runExportObjects(options: ExportTransportOptions): Promise<ExportObjectsSuccess> {
	const objects = requestsFrom(options);
	const operationName = options.operationName ?? defaultOperationName(objects);
	const fallbackFilename = options.fallbackFilename ?? defaultFallbackFilename(objects);
	if (options.signal?.aborted) throw new Error(`${operationName} was cancelled before it started.`);

	const { url, webSocketImpl, redactionSecrets } = await createAuthenticatedWebSocketTransport(
		options.session,
		options.signal,
	);
	if (options.signal?.aborted) throw new Error(`${operationName} was cancelled before it started.`);

	const client = createClient({
		url,
		webSocketImpl,
		retryAttempts: 0,
		lazy: true,
		on: {
			connected: () => log.debug('exportObjects: ws connected', { url }),
			closed: () => log.debug('exportObjects: ws closed'),
			error: error => log.debug('exportObjects: ws error', redactExportError(error, redactionSecrets)),
		},
	});

	const dispose = () => {
		Promise.resolve(client.dispose()).catch(() => {});
	};
	options.signal?.addEventListener('abort', dispose, { once: true });

	log.debug('exportObjects: starting subscription', {
		objectCount: objects.length,
		objectTypes: [...new Set(objects.map(object => object.type))],
	});

	try {
		if (options.signal?.aborted) throw new Error(`${operationName} was cancelled before it started.`);
		const results = client.iterate<SubscriptionResult['data']>({
			query: EXPORT_OBJECTS_SUBSCRIPTION,
			variables: {
				objects,
			},
		});
		return await collectExportOutcome(payloadsOf(results, redactionSecrets, operationName, options.signal), {
			inactivityTimeoutMs: options.inactivityTimeoutMs,
			signal: options.signal,
			redactionSecrets,
			abort: dispose,
			onProgress: options.onProgress,
			operationName,
			fallbackFilename,
		});
	} catch (error) {
		if (options.signal?.aborted) throw new Error(`${operationName} was cancelled.`);
		const message = redactExportError(error, redactionSecrets);
		if (message.startsWith(operationName) || message.startsWith('GraphQL error:')) throw new Error(message);
		throw new Error(`${operationName} subscription failed: ${message}`);
	} finally {
		options.signal?.removeEventListener('abort', dispose);
		dispose();
	}
}
