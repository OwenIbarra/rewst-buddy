/**
 * Pure exportObjects subscription handling. This module owns the GraphQL
 * document and stream state machine; cookie and websocket wiring live in
 * exportClient.ts so the terminal-event rules can be exercised independently.
 */

export const EXPORT_OBJECTS_SUBSCRIPTION = `
subscription RewstBuddyExportObjects($objects: [ExportRequestObject!]!) {
  exportObjects(objects: $objects) {
    __typename
    ... on ExportObjectsStreamMessage {
      isFinished
      failed
      errors
      identity { type id displayName isSignificant }
      progress { totalCount queuedCount processedCount hasEncounteredErrors }
      object { contentHash fields isSignificant name nonfunctionalFields serializableKey type }
    }
    ... on ExportObjectsStreamSuccessResponse {
      isFinished
      didSucceed
      recommendedFilename
      bundle { version exportedAt signing objects }
    }
    ... on ExportObjectsStreamFailureResponse {
      isFinished
      didSucceed
      error
      code
      failures {
        type
        id
        errors
        dependents { type id displayName isSignificant }
        paths { type id displayName isSignificant }
      }
    }
  }
}
`.trim();

export const DEFAULT_EXPORT_INACTIVITY_TIMEOUT_MS = 300_000;
export const MIN_EXPORT_INACTIVITY_TIMEOUT_MS = 1_000;
export const MAX_EXPORT_INACTIVITY_TIMEOUT_MS = 900_000;

/** The signed payload returned by Rewst. It must be retained without rewriting. */
export interface ExportBundle {
	version: number;
	exportedAt: string;
	signing: unknown;
	objects: unknown;
}

export interface ExportObjectsSuccess {
	recommendedFilename: string;
	bundle: ExportBundle;
}

export interface ExportProgress {
	isFinished?: boolean;
	failed?: boolean;
	errors?: string[];
	object?: Record<string, unknown>;
	identity?: {
		type?: string;
		id?: string;
		displayName?: string;
		isSignificant?: boolean;
	};
	progress?: {
		totalCount?: number;
		queuedCount?: number;
		processedCount?: number;
		hasEncounteredErrors?: boolean;
	};
}

interface RawExportFailure {
	type?: unknown;
	id?: unknown;
	errors?: unknown;
}

interface RawExportEvent {
	__typename?: unknown;
	isFinished?: unknown;
	didSucceed?: unknown;
	recommendedFilename?: unknown;
	bundle?: unknown;
	failed?: unknown;
	errors?: unknown;
	error?: unknown;
	code?: unknown;
	object?: unknown;
	identity?: unknown;
	progress?: unknown;
	failures?: unknown;
}

type ClassifiedExportEvent =
	| { kind: 'progress'; value: ExportProgress }
	| ({ kind: 'success' } & ExportObjectsSuccess)
	| { kind: 'failure'; message: string };

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	// graphql-ws and ws failures often surface as plain objects (CloseEvent,
	// { code, reason }, { message }) — String(value) would collapse to
	// "[object Object]" and hide the real cause.
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const parts = [
			typeof record.message === 'string' ? record.message : undefined,
			typeof record.reason === 'string' ? record.reason : undefined,
			typeof record.code !== 'undefined' ? `code=${String(record.code)}` : undefined,
		].filter(Boolean);
		if (parts.length > 0) return parts.join(' ');
		try {
			const json = JSON.stringify(value);
			if (json && json !== '{}') return json;
		} catch {
			// fall through to String(value) below
		}
	}
	return String(value);
}

/**
 * Keeps server-provided failures useful without reflecting credentials, long
 * transport dumps, or control characters into an MCP result.
 */
export function redactExportError(value: unknown, secrets: readonly string[] = []): string {
	let message = toErrorMessage(value);
	for (const secret of secrets) {
		if (!secret) continue;
		message = message.split(secret).join('[REDACTED]');
		const equals = secret.indexOf('=');
		if (equals >= 0 && equals < secret.length - 1) {
			message = message.split(secret.slice(equals + 1)).join('[REDACTED]');
		}
	}
	message = message
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED]')
		.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
		.replace(
			/\b[\w.-]*(?:authorization|cookie|session|token|secret|password|signature|certificate|privatekey|private-key|signing)[\w.-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			match => `${match.slice(0, Math.max(match.indexOf('='), match.indexOf(':')) + 1)}[REDACTED]`,
		)
		.replace(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, '[REDACTED]');
	message = [...message]
		.map(character => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 31 || codePoint === 127 ? ' ' : character;
		})
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
	return (message || 'Unknown server error.').slice(0, 1_000);
}

function errorStrings(value: unknown, secrets: readonly string[]): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(error => redactExportError(error, secrets)).filter(Boolean);
}

function describeFailures(value: unknown, secrets: readonly string[]): string {
	if (!Array.isArray(value) || value.length === 0) return '';
	return value
		.map(raw => {
			const failure = (raw ?? {}) as RawExportFailure;
			const identity = [optionalString(failure.type), optionalString(failure.id)].filter(Boolean).join(' ');
			const errors = errorStrings(failure.errors, secrets);
			return `${identity || 'unknown object'}: ${errors.join('; ') || 'no error details'}`;
		})
		.join(' | ');
}

/** Classifies one payload without retaining or reconstructing its bundle. */
export function classifyExportEvent(
	payload: unknown,
	redactionSecrets: readonly string[] = [],
): ClassifiedExportEvent | undefined {
	if (payload === null || typeof payload !== 'object') return undefined;
	const event = payload as RawExportEvent;

	// Failure-shaped and success-shaped payloads may be emitted while work is
	// still in progress. Never stop until the server marks an event finished.
	if (event.isFinished !== true) {
		return {
			kind: 'progress',
			value: {
				isFinished: typeof event.isFinished === 'boolean' ? event.isFinished : undefined,
				failed: typeof event.failed === 'boolean' ? event.failed : undefined,
				errors: Array.isArray(event.errors) ? errorStrings(event.errors, redactionSecrets) : undefined,
				object:
					event.object && typeof event.object === 'object'
						? (event.object as ExportProgress['object'])
						: undefined,
				identity:
					event.identity && typeof event.identity === 'object'
						? (event.identity as ExportProgress['identity'])
						: undefined,
				progress:
					event.progress && typeof event.progress === 'object'
						? (event.progress as ExportProgress['progress'])
						: undefined,
			},
		};
	}

	if (
		event.__typename === 'ExportObjectsStreamSuccessResponse' &&
		event.didSucceed === true &&
		event.bundle != null
	) {
		return {
			kind: 'success',
			recommendedFilename: optionalString(event.recommendedFilename) ?? 'rewst-workflows-export.json',
			bundle: event.bundle as ExportBundle,
		};
	}

	if (event.__typename === 'ExportObjectsStreamFailureResponse') {
		const details = [
			event.code != null ? `[${redactExportError(event.code, redactionSecrets)}]` : undefined,
			event.error != null ? redactExportError(event.error, redactionSecrets) : undefined,
			describeFailures(event.failures, redactionSecrets),
		].filter(Boolean);
		return {
			kind: 'failure',
			message: details.join(' ') || 'The server did not provide failure details.',
		};
	}
	if (event.__typename === 'ExportObjectsStreamMessage' && event.failed === true) {
		const errors = errorStrings(event.errors, redactionSecrets);
		return {
			kind: 'failure',
			message: errors.join('; ') || 'The export stream reported a failed object without error details.',
		};
	}
	if (event.__typename === 'ExportObjectsStreamSuccessResponse') {
		return {
			kind: 'failure',
			message: 'The export success response was incomplete or did not report a successful finished export.',
		};
	}
	return { kind: 'failure', message: 'The export stream finished without succeeding.' };
}

const TIMED_OUT = Symbol('timed-out');
const CANCELLED = Symbol('cancelled');

async function nextWithControls<T>(
	promise: Promise<T>,
	ms: number,
	signal?: AbortSignal,
): Promise<T | typeof TIMED_OUT | typeof CANCELLED> {
	if (signal?.aborted) return CANCELLED;
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<typeof TIMED_OUT>(resolve => {
				timer = setTimeout(() => resolve(TIMED_OUT), ms);
			}),
			new Promise<typeof CANCELLED>(resolve => {
				if (!signal) return;
				onAbort = () => resolve(CANCELLED);
				signal.addEventListener('abort', onAbort, { once: true });
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener('abort', onAbort);
	}
}

export interface CollectExportOptions {
	/** Resets after every subscription payload, including unrecognized payloads. */
	inactivityTimeoutMs?: number;
	/** Tears down the underlying websocket when collection stops early. */
	abort?: () => void;
	signal?: AbortSignal;
	redactionSecrets?: readonly string[];
	onProgress?: (progress: ExportProgress) => void;
}

/** Consumes export events until strict terminal success or a useful failure. */
export async function collectExportOutcome(
	payloads: AsyncIterable<unknown>,
	options: CollectExportOptions = {},
): Promise<ExportObjectsSuccess> {
	const timeoutMs = options.inactivityTimeoutMs ?? DEFAULT_EXPORT_INACTIVITY_TIMEOUT_MS;
	const iterator = payloads[Symbol.asyncIterator]();
	try {
		for (;;) {
			if (options.signal?.aborted) throw new Error('Workflow export was cancelled.');
			const step = iterator.next();
			let next: IteratorResult<unknown> | typeof TIMED_OUT | typeof CANCELLED;
			try {
				next = await nextWithControls(step, timeoutMs, options.signal);
			} catch (error) {
				if (options.signal?.aborted) throw new Error('Workflow export was cancelled.');
				throw error;
			}
			if (next === TIMED_OUT || next === CANCELLED) {
				step.catch(() => {});
				options.abort?.();
				if (next === CANCELLED) throw new Error('Workflow export was cancelled.');
				throw new Error(`No workflow export progress for ${Math.round(timeoutMs / 1000)}s; gave up.`);
			}
			if (options.signal?.aborted) throw new Error('Workflow export was cancelled.');
			if (next.done) {
				throw new Error('The workflow export stream ended without reporting success.');
			}

			const event = classifyExportEvent(next.value, options.redactionSecrets);
			if (event === undefined) continue;
			if (event.kind === 'success') {
				return { recommendedFilename: event.recommendedFilename, bundle: event.bundle };
			}
			if (event.kind === 'failure') {
				throw new Error(`Workflow export failed: ${event.message}`);
			}
			options.onProgress?.(event.value);
		}
	} finally {
		options.abort?.();
		Promise.resolve(iterator.return?.(undefined)).catch(() => {});
	}
}
