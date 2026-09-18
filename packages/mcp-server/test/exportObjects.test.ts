import { readFileSync } from 'node:fs';
import { buildASTSchema, Kind, parse, print, validate, visit } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyVerifiedExportContract } from '../../../src/verifiedExportSchema';
import {
	classifyExportEvent,
	collectExportOutcome,
	EXPORT_OBJECTS_SUBSCRIPTION,
	redactExportError,
} from '../src/export/exportObjects';

const bundle = {
	version: 2,
	exportedAt: '2026-09-17T20:46:23.000Z',
	signing: { cert: 'fixture-cert', hash: 'sha256', signature: 'fixture-signature' },
	objects: [{ type: 'workflow', fields: { id: 'wf', notes: '{{ CTX.value }}' } }],
};
const success = {
	__typename: 'ExportObjectsStreamSuccessResponse',
	isFinished: true,
	didSucceed: true,
	recommendedFilename: 'workflow.bundle.json',
	bundle,
};

async function* events(...values: unknown[]): AsyncIterable<unknown> {
	for (const value of values) yield value;
}

afterEach(() => vi.useRealTimers());

describe('verified export subscription contract', () => {
	it('validates against the offline export overlay and selects object paths, error, and code', () => {
		const snapshot = parse(
			readFileSync(new URL('../src/sessions/graphql/schema.graphql', import.meta.url), 'utf8'),
		);
		const document = parse(EXPORT_OBJECTS_SUBSCRIPTION);
		expect(validate(buildASTSchema(applyVerifiedExportContract(snapshot)), document)).toEqual([]);
		const operation = document.definitions[0];
		if (operation.kind !== Kind.OPERATION_DEFINITION) throw new Error('Expected subscription');
		expect(operation.operation).toBe('subscription');
		expect(operation.variableDefinitions?.map(variable => print(variable))).toEqual([
			'$objects: [ExportRequestObject!]!',
		]);
		const selections: string[] = [];
		visit(document, {
			Field(node) {
				selections.push(node.name.value);
				if (node.name.value === 'paths') {
					expect(
						node.selectionSet?.selections.map(selection =>
							selection.kind === Kind.FIELD ? selection.name.value : null,
						),
					).toEqual(expect.arrayContaining(['type', 'id']));
				}
				if (node.name.value === 'exportObjects') {
					expect(node.arguments?.map(argument => print(argument))).toEqual(['objects: $objects']);
				}
			},
		});
		expect(selections).toEqual(
			expect.arrayContaining(['error', 'code', 'failures', 'paths', 'recommendedFilename']),
		);
		expect(selections).not.toContain('orgId');
	});

	it('keeps the export overlay idempotent and leaves unrelated schema definitions alone', () => {
		const snapshot = parse(
			readFileSync(new URL('../src/sessions/graphql/schema.graphql', import.meta.url), 'utf8'),
		);
		const updated = applyVerifiedExportContract(snapshot);
		expect(print(applyVerifiedExportContract(updated))).toBe(print(updated));
		const changed = new Set([
			'Subscription',
			'ExportRequestObject',
			'ExportBundle',
			'ExportObjectsStreamSuccessResponse',
			'ExportObjectsStreamFailureResponse',
			'ExportErrorObject',
			'Unknown',
		]);
		const unrelated = (document: typeof snapshot) =>
			document.definitions.filter(
				definition => !('name' in definition) || !changed.has(definition.name?.value ?? ''),
			);
		expect(unrelated(updated)).toEqual(unrelated(snapshot));
		const subscription = updated.definitions.find(
			definition => definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === 'Subscription',
		);
		const original = snapshot.definitions.find(
			definition => definition.kind === Kind.OBJECT_TYPE_DEFINITION && definition.name.value === 'Subscription',
		);
		if (subscription?.kind !== Kind.OBJECT_TYPE_DEFINITION || original?.kind !== Kind.OBJECT_TYPE_DEFINITION) {
			throw new Error('Missing Subscription');
		}
		expect(subscription.fields?.filter(field => field.name.value !== 'exportObjects')).toEqual(
			original.fields?.filter(field => field.name.value !== 'exportObjects'),
		);
	});
});

describe('export error redaction', () => {
	it('conceals the full value when an equals-separated secret contains colons', () => {
		const redacted = redactExportError('request failed: api_token= secret:with:colons');
		expect(redacted).toBe('request failed: api_token= [REDACTED]');
		expect(redacted).not.toContain('secret');
	});

	it('conceals the full value when a colon-separated secret contains colons', () => {
		const redacted = redactExportError('request failed: session: abc:def:ghi');
		expect(redacted).toBe('request failed: session: [REDACTED]');
		expect(redacted).not.toContain('abc');
	});

	it('conceals quoted values containing colons while preserving the key prefix', () => {
		const redacted = redactExportError('denied for authorization="bearer:abc:123"');
		expect(redacted).toBe('denied for authorization=[REDACTED]');
		expect(redacted).not.toContain('bearer');
	});
});

describe('export stream outcomes', () => {
	it('ignores unfinished response shapes and returns the original signed bundle on terminal success', async () => {
		const abort = vi.fn();
		const onProgress = vi.fn();
		const result = await collectExportOutcome(
			events(
				{ ...success, isFinished: false },
				{ __typename: 'ExportObjectsStreamFailureResponse', isFinished: false, didSucceed: false },
				success,
			),
			{ abort, onProgress },
		);
		expect(result.bundle).toBe(bundle);
		expect(result.recommendedFilename).toBe('workflow.bundle.json');
		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(abort).toHaveBeenCalled();
	});

	it('reports terminal failure details and redacts credentials', async () => {
		const abort = vi.fn();
		await expect(
			collectExportOutcome(
				events({
					__typename: 'ExportObjectsStreamFailureResponse',
					isFinished: true,
					didSucceed: false,
					error: 'Denied fixture-private-cookie',
					code: 'EXPORT_DENIED',
					failures: [{ type: 'workflow', id: 'wf', errors: ['Dependency unavailable'], paths: [['opaque']] }],
				}),
				{ abort, redactionSecrets: ['fixture-private-cookie'] },
			),
		).rejects.toThrow('[EXPORT_DENIED] Denied [REDACTED] workflow wf: Dependency unavailable');
		expect(abort).toHaveBeenCalled();
	});

	it.each([
		{ ...success, didSucceed: false },
		{ ...success, bundle: null },
		{ __typename: 'ExportObjectsStreamMessage', isFinished: true, failed: true, errors: ['bad object'] },
		{ __typename: 'UnknownEvent', isFinished: true },
	])('rejects a terminal payload that does not establish success: %j', async event => {
		expect(classifyExportEvent(event)?.kind).toBe('failure');
		await expect(collectExportOutcome(events(event))).rejects.toThrow('Workflow export failed:');
	});

	it('rejects an exhausted stream without terminal success', async () => {
		await expect(collectExportOutcome(events(null, { isFinished: false }))).rejects.toThrow(
			'ended without reporting success',
		);
	});

	it('cancels a pending subscription read and releases the iterator', async () => {
		const controller = new AbortController();
		const abort = vi.fn();
		const iterator = {
			next: vi.fn(() => new Promise<IteratorResult<unknown>>(() => {})),
			return: vi.fn(async () => ({ done: true as const, value: undefined })),
		};
		const pending = collectExportOutcome(
			{ [Symbol.asyncIterator]: () => iterator },
			{
				signal: controller.signal,
				abort,
			},
		);
		const rejected = expect(pending).rejects.toThrow('cancelled');
		controller.abort();
		await rejected;
		expect(abort).toHaveBeenCalled();
		expect(iterator.return).toHaveBeenCalled();
	});

	it('times out an inactive subscription using a deterministic clock', async () => {
		vi.useFakeTimers();
		const abort = vi.fn();
		const iterator = { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
		const pending = collectExportOutcome(
			{ [Symbol.asyncIterator]: () => iterator },
			{
				inactivityTimeoutMs: 1000,
				abort,
			},
		);
		const rejected = expect(pending).rejects.toThrow('No workflow export progress for 1s');
		await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		expect(abort).toHaveBeenCalled();
	});
});
