import { createAuthenticatedWebSocketTransport } from '../sessions/graphqlWsTransport';
import type { Session } from '../sessions/index';
import { log } from '../host';
import { createClient } from 'graphql-ws';
import {
	collectUnpackOutcome,
	UNPACK_CRATE_SUBSCRIPTION,
	type UnpackCrateInput,
	type UnpackSuccess,
} from './crateUnpack';
import { redactExportError } from '../export/exportObjects';

/**
 * Transport wiring for the unpackCrate subscription. Unpacking a crate is a
 * GraphQL *subscription*, not a mutation — the server streams export/import
 * progress and finishes with a success or failure event — so this rides the
 * same graphql-ws + cookie websocket stack as the Rewst AI conversation client.
 * All decision logic lives in crateUnpack.ts; this file only moves bytes.
 */

interface SubscriptionResult {
	data?: { unpackCrate?: unknown } | null;
	errors?: readonly { message: string }[];
}

async function* payloadsOf(
	results: AsyncIterable<SubscriptionResult>,
	secrets: readonly string[],
	signal?: AbortSignal,
): AsyncIterable<unknown> {
	for await (const result of results) {
		if (signal?.aborted) throw new Error('Crate unpack was cancelled.');
		if (result.errors?.length) {
			throw new Error(
				`GraphQL error: ${result.errors.map(e => redactExportError(e.message, secrets)).join('; ')}`,
			);
		}
		yield result.data?.unpackCrate;
	}
}

export interface UnpackTransportOptions {
	session: Session;
	input: UnpackCrateInput;
	onProgress?: (label: string) => void;
	inactivityTimeoutMs?: number;
	/** Aborting tears down the websocket, ending the stream early. */
	signal?: AbortSignal;
}

/**
 * Runs one unpackCrate subscription to completion: resolves with the unpacked
 * object (its id is the new workflow) or throws with the server's failure.
 */
export async function runUnpackCrate(options: UnpackTransportOptions): Promise<UnpackSuccess> {
	if (options.signal?.aborted) {
		throw new Error('Crate unpack was cancelled before it started.');
	}

	const { session } = options;
	const { url, webSocketImpl, redactionSecrets } = await createAuthenticatedWebSocketTransport(
		session,
		options.signal,
	);
	if (options.signal?.aborted) throw new Error('Crate unpack was cancelled before it started.');

	const client = createClient({
		url,
		webSocketImpl,
		retryAttempts: 0,
		lazy: true,
		on: {
			connected: () => log.debug('unpackCrate: ws connected', { url }),
			closed: () => log.debug('unpackCrate: ws closed'),
			error: err => log.debug('unpackCrate: ws error', redactExportError(err, redactionSecrets)),
		},
	});

	const dispose = () => {
		Promise.resolve(client.dispose()).catch(() => {});
	};

	if (options.signal?.aborted) {
		dispose();
		throw new Error('Crate unpack was cancelled before it started.');
	}
	options.signal?.addEventListener('abort', dispose, { once: true });

	log.debug('unpackCrate: starting subscription', {
		crateId: options.input.crateId,
		orgId: options.input.orgId,
		workflowName: options.input.workflow.name,
	});

	try {
		if (options.signal?.aborted) throw new Error('Crate unpack was cancelled before it started.');
		const results = client.iterate<SubscriptionResult['data']>({
			query: UNPACK_CRATE_SUBSCRIPTION,
			variables: { unpackingArguments: options.input },
		});
		return await collectUnpackOutcome(payloadsOf(results, redactionSecrets, options.signal), {
			inactivityTimeoutMs: options.inactivityTimeoutMs,
			abort: dispose,
			signal: options.signal,
			redactionSecrets,
			onProgress: options.onProgress,
		});
	} catch (error) {
		if (options.signal?.aborted) throw new Error('Crate unpack was cancelled.');
		const message = redactExportError(error, redactionSecrets);
		if (message.startsWith('Crate unpack') || message.startsWith('GraphQL error:')) throw new Error(message);
		throw new Error(`Crate unpack subscription failed: ${message}`);
	} finally {
		options.signal?.removeEventListener('abort', dispose);
		dispose();
	}
}
