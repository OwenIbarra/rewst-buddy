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
	signal?: AbortSignal,
): AsyncIterable<unknown> {
	for await (const result of results) {
		if (signal?.aborted) throw new Error('Workflow export was cancelled.');
		if (result.errors?.length) {
			const messages = result.errors.map(error => redactExportError(error.message, secrets));
			throw new Error(`GraphQL error: ${messages.join('; ')}`);
		}
		yield result.data?.exportObjects;
	}
}

export interface ExportTransportOptions {
	session: Session;
	workflowIds: readonly string[];
	inactivityTimeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (progress: ExportProgress) => void;
}

/** Runs the authenticated Rewst exportObjects subscription to strict success. */
export async function runExportObjects(options: ExportTransportOptions): Promise<ExportObjectsSuccess> {
	if (options.signal?.aborted) throw new Error('Workflow export was cancelled before it started.');

	const { url, webSocketImpl, redactionSecrets } = await createAuthenticatedWebSocketTransport(
		options.session,
		options.signal,
	);
	if (options.signal?.aborted) throw new Error('Workflow export was cancelled before it started.');

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
		workflowCount: options.workflowIds.length,
	});

	try {
		if (options.signal?.aborted) throw new Error('Workflow export was cancelled before it started.');
		const results = client.iterate<SubscriptionResult['data']>({
			query: EXPORT_OBJECTS_SUBSCRIPTION,
			variables: {
				objects: options.workflowIds.map(id => ({ type: 'workflow', id })),
			},
		});
		return await collectExportOutcome(payloadsOf(results, redactionSecrets, options.signal), {
			inactivityTimeoutMs: options.inactivityTimeoutMs,
			signal: options.signal,
			redactionSecrets,
			abort: dispose,
			onProgress: options.onProgress,
		});
	} catch (error) {
		if (options.signal?.aborted) throw new Error('Workflow export was cancelled.');
		const message = redactExportError(error, redactionSecrets);
		if (message.startsWith('Workflow export') || message.startsWith('GraphQL error:')) throw new Error(message);
		throw new Error(`Workflow export subscription failed: ${message}`);
	} finally {
		options.signal?.removeEventListener('abort', dispose);
		dispose();
	}
}
