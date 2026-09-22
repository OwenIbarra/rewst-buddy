import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildASTSchema, parse, validate } from 'graphql';
vi.mock('../src/crates/unpackClient', () => ({ runUnpackCrate: vi.fn() }));
vi.mock('../src/export/exportStorage', async importOriginal => {
	const actual = await importOriginal<typeof import('../src/export/exportStorage')>();
	return { ...actual, ensureDefaultExportDir: vi.fn(async () => '/abs/default-exports') };
});
import {
	editorDataOperations,
	clearEditorDataCachesForTesting,
	setEditorExportCapabilityRunnerForTesting,
} from '../src/editorData';
import { runUnpackCrate } from '../src/crates/unpackClient';
import { SessionManager } from '../src/sessions/index';
import { _setWorkflowExportDependenciesForTesting } from '../src/capabilities/workflowExportCapability';

function installSession(
	rawGraphql: (
		query: string,
		variables?: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	) => Promise<unknown>,
): void {
	SessionManager.sessionMap.clear();
	SessionManager.sessionMap.set('user-1', {
		profile: {
			user: { id: 'user-1' },
			org: { id: 'org-1', name: 'Org One' },
			allManagedOrgs: [{ id: 'org-1', name: 'Org One' }],
			region: { graphqlUrl: 'https://api.rewst.io/graphql' },
		},
		ensureValid: vi.fn(async () => true),
		getCookies: vi.fn(async () => 'appSession=fixture-token'),
		rawGraphql,
	} as never);
}

describe('editor data operations', () => {
	beforeEach(() => {
		clearEditorDataCachesForTesting();
		setEditorExportCapabilityRunnerForTesting();
		_setWorkflowExportDependenciesForTesting();
		SessionManager.sessionMap.clear();
	});

	it('exposes the bounded editor operation names and requires an active session', async () => {
		expect(Object.keys(editorDataOperations).sort()).toEqual([
			'crates.detail',
			'crates.list',
			'crates.unpack',
			'exports.forms.list',
			'exports.objects.run',
			'exports.run',
			'exports.templates.list',
			'jinja.filters',
			'jinja.render',
			'preview.context',
			'preview.executions',
			'preview.workflows',
			'workflows.export.catalog',
			'workflows.export.defaultDirectory',
			'workflows.export.run',
		]);
		await expect(
			editorDataOperations['preview.workflows'](
				{ sessionId: 'missing', orgId: 'org-1' },
				{
					signal: new AbortController().signal,
					emit: async () => {},
				},
			),
		).rejects.toThrow(/active session/i);
	});

	it.each([
		{
			kind: 'template',
			operation: 'exports.templates.list',
			responseField: 'templates',
			rows: [
				{
					id: 'template-1',
					name: 'Welcome template',
					orgId: 'org-1',
					createdAt: '2026-09-01T10:00:00Z',
					updatedAt: '2026-09-20T10:00:00Z',
					tags: [{ id: 'customer', name: 'Customer' }],
				},
			],
		},
		{
			kind: 'form',
			operation: 'exports.forms.list',
			responseField: 'forms',
			rows: [
				{
					id: 'form-1',
					name: 'Employee form',
					orgId: 'org-1',
					createdAt: '2026-09-02T10:00:00Z',
					updatedAt: '2026-09-19T10:00:00Z',
					tags: [{ id: 'employee', name: 'Employee' }],
				},
			],
		},
	])('lists $kind rows with schema-valid metadata fields, pagination, and cancellation', async testCase => {
		const queries: string[] = [];
		const rawGraphql = vi.fn(async (query: string) => {
			queries.push(query);
			return { data: { [testCase.responseField]: testCase.rows } };
		});
		installSession(rawGraphql);
		const controller = new AbortController();

		await expect(
			editorDataOperations[testCase.operation](
				{ sessionId: 'user-1', orgId: 'org-1' },
				{ signal: controller.signal, emit: async () => {} },
			),
		).resolves.toEqual(testCase.rows);
		expect(rawGraphql).toHaveBeenCalledWith(
			expect.stringMatching(
				new RegExp(
					`${testCase.responseField}\\(where: \\{ orgId: \\$orgId \\}, limit: \\$limit, offset: \\$offset, order: \\[\\["name", "asc"\\]\\]\\)[\\s\\S]*id name orgId createdAt updatedAt tags \\{ id name \\}`,
				),
			),
			{ orgId: 'org-1', limit: 500, offset: 0 },
			{ signal: controller.signal },
		);

		const schema = buildASTSchema(
			parse(readFileSync(new URL('../src/sessions/graphql/schema.graphql', import.meta.url), 'utf8')),
		);
		expect(validate(schema, parse(queries[0]!))).toEqual([]);
	});

	it('continues catalog pagination based on the raw page size when nullable rows are discarded', async () => {
		const firstPage = Array.from({ length: 500 }, (_, index) =>
			index === 250 ? null : { id: `form-${index}`, name: `Form ${index}`, orgId: 'org-1' },
		);
		const finalRow = { id: 'form-500', name: 'Form 500', orgId: 'org-1' };
		const rawGraphql = vi.fn(async (_query: string, variables?: Record<string, unknown>) => ({
			data: { forms: variables?.offset === 0 ? firstPage : [finalRow] },
		}));
		installSession(rawGraphql);

		const rows = await editorDataOperations['exports.forms.list'](
			{ sessionId: 'user-1', orgId: 'org-1' },
			{ signal: new AbortController().signal, emit: async () => {} },
		);

		expect(rawGraphql).toHaveBeenCalledTimes(2);
		expect(rawGraphql.mock.calls.map(call => call[1]?.offset)).toEqual([0, 500]);
		expect(rows).toHaveLength(500);
		expect(rows).toContainEqual(finalRow);
	});

	it('runs only the registered object exporters with the selected session context', async () => {
		const rawGraphql = vi.fn(async () => ({ data: {} }));
		installSession(rawGraphql);
		const runner = vi.fn(async () => JSON.stringify({ status: 'saved', outputPath: '/tmp/export.json' }));
		setEditorExportCapabilityRunnerForTesting(runner);

		await expect(
			editorDataOperations['exports.run'](
				{
					sessionId: 'user-1',
					orgId: 'org-1',
					name: 'buddy_export_forms',
					arguments: { formIds: ['form-1'], outputPath: '/tmp' },
				},
				{ signal: new AbortController().signal, emit: async () => {} },
			),
		).resolves.toContain('export.json');

		expect(runner).toHaveBeenCalledTimes(1);
		const [capability, args, context] = runner.mock.calls[0];
		expect(capability.spec.name).toBe('buddy_export_forms');
		expect(args).toEqual({ formIds: ['form-1'], outputPath: '/tmp', orgId: 'org-1' });
		expect(context.orgId).toBe('org-1');
		expect(context.session).toBe(SessionManager.sessionMap.get('user-1'));
		expect(context.sessions).toEqual([context.session]);

		const workflowResult = {
			status: 'saved',
			orgId: 'org-1',
			workflowIds: ['workflow-1'],
			outputPath: '/tmp/workflow.json',
		};
		runner.mockResolvedValueOnce(JSON.stringify(workflowResult));
		await expect(
			editorDataOperations['workflows.export.run'](
				{
					sessionId: 'user-1',
					orgId: 'org-1',
					workflowIds: ['workflow-1'],
					outputPath: '/tmp/workflow.json',
				},
				{ signal: new AbortController().signal, emit: async () => {} },
			),
		).resolves.toEqual(workflowResult);
		expect(runner.mock.calls[1]?.[0].spec.name).toBe('buddy_export_workflows');
		expect(runner.mock.calls[1]?.[1]).toEqual({
			workflowIds: ['workflow-1'],
			outputPath: '/tmp/workflow.json',
			includeBundle: false,
			orgId: 'org-1',
		});

		await expect(
			editorDataOperations['exports.run'](
				{
					sessionId: 'user-1',
					orgId: 'org-1',
					name: 'buddy_delete_template',
					arguments: {},
				},
				{ signal: new AbortController().signal, emit: async () => {} },
			),
		).rejects.toThrow(/unsupported editor export capability/i);
	});

	it.each([
		{ objectType: 'template' as const, capabilityName: 'buddy_export_templates', idsField: 'templateIds' },
		{ objectType: 'form' as const, capabilityName: 'buddy_export_forms', idsField: 'formIds' },
	])('dispatches shared $objectType exports and normalizes their editor result', async testCase => {
		const rawGraphql = vi.fn(async () => ({ data: {} }));
		installSession(rawGraphql);
		const controller = new AbortController();
		const runner = vi.fn(async () =>
			JSON.stringify({
				status: 'saved',
				orgId: 'org-1',
				[testCase.idsField]: [`${testCase.objectType}-1`],
				outputPath: `/exports/${testCase.objectType}.json`,
			}),
		);
		setEditorExportCapabilityRunnerForTesting(runner);

		await expect(
			editorDataOperations['exports.objects.run'](
				{
					sessionId: 'user-1',
					orgId: 'org-1',
					objectType: testCase.objectType,
					objectIds: [`${testCase.objectType}-1`],
					outputPath: `/exports/${testCase.objectType}.json`,
				},
				{ signal: controller.signal, emit: async () => {} },
			),
		).resolves.toMatchObject({
			status: 'saved',
			orgId: 'org-1',
			objectType: testCase.objectType,
			objectIds: [`${testCase.objectType}-1`],
			outputPath: `/exports/${testCase.objectType}.json`,
		});

		expect(runner).toHaveBeenCalledTimes(1);
		const [capability, args, context] = runner.mock.calls[0];
		expect(capability.spec.name).toBe(testCase.capabilityName);
		expect(args).toEqual({
			[testCase.idsField]: [`${testCase.objectType}-1`],
			outputPath: `/exports/${testCase.objectType}.json`,
			includeBundle: false,
			orgId: 'org-1',
		});
		expect(context.signal).toBe(controller.signal);
	});

	it('rejects unsupported object types before invoking an exporter', async () => {
		installSession(async () => ({ data: {} }));
		const runner = vi.fn(async () => '{}');
		setEditorExportCapabilityRunnerForTesting(runner);
		await expect(
			editorDataOperations['exports.objects.run'](
				{ sessionId: 'user-1', orgId: 'org-1', objectType: 'workflow', objectIds: ['workflow-1'] },
				{ signal: new AbortController().signal, emit: async () => {} },
			),
		).rejects.toThrow(/unsupported editor export object type/i);
		expect(runner).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: 'non-saved status',
			result: { status: 'failed', templateIds: ['template-1'] },
			error: /unexpected result/i,
		},
		{ label: 'missing ids', result: { status: 'saved' }, error: /unexpected object ids/i },
		{ label: 'non-string ids', result: { status: 'saved', templateIds: [123] }, error: /unexpected object ids/i },
	])('rejects $label from the object exporter', async ({ result, error }) => {
		installSession(async () => ({ data: {} }));
		const runner = vi.fn(async () => JSON.stringify(result));
		setEditorExportCapabilityRunnerForTesting(runner);
		await expect(
			editorDataOperations['exports.objects.run'](
				{ sessionId: 'user-1', orgId: 'org-1', objectType: 'template', objectIds: ['template-1'] },
				{ signal: new AbortController().signal, emit: async () => {} },
			),
		).rejects.toThrow(error);
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it('returns workflow metadata through the cancellable export catalog operation', async () => {
		const workflows = [
			{
				id: 'workflow-1',
				name: 'Daily Sync',
				orgId: 'org-1',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-02-01T00:00:00.000Z',
				tags: [{ id: 'tag-1', name: 'Operations' }],
			},
		];
		const rawGraphql = vi.fn(async () => ({ data: { workflows } }));
		installSession(rawGraphql);
		const signal = new AbortController().signal;

		await expect(
			editorDataOperations['workflows.export.catalog'](
				{ sessionId: 'user-1', orgId: 'org-1' },
				{ signal, emit: async () => {} },
			),
		).resolves.toEqual(workflows);
		expect(rawGraphql).toHaveBeenCalledWith(
			expect.stringMatching(/createdAt[\s\S]*updatedAt[\s\S]*tags \{ id name \}/),
			{ orgId: 'org-1', limit: 500, offset: 0 },
			{ signal },
		);
	});

	it('returns a structured catalog and delegates exports to buddy_export_workflows', async () => {
		const rawGraphql = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
			if (query.includes('RewstBuddyPreviewWorkflows')) {
				return {
					data: {
						workflows: [
							{
								id: 'wf-1',
								name: 'Workflow One',
								orgId: 'org-1',
								createdAt: '2026-01-01T00:00:00.000Z',
								updatedAt: '2026-02-01T00:00:00.000Z',
								tags: [{ id: 'tag-1', name: 'Production' }],
							},
						],
					},
				};
			}
			if (query.includes('RewstBuddyWorkflowOwner')) {
				return { data: { workflow: { id: variables?.id, name: 'Workflow One', orgId: 'org-1' } } };
			}
			return { data: {} };
		});
		installSession(rawGraphql);
		const transport = vi.fn(async () => ({
			recommendedFilename: 'workflow-one.json',
			bundle: {
				version: 2,
				exportedAt: '2026-09-18T00:00:00.000Z',
				signing: { signature: 'fixture' },
				objects: [{ type: 'workflow', id: 'wf-1' }],
			},
		}));
		const storage = {
			save: vi.fn(async () => ({ outputPath: '/abs/exports/workflow-one.json', bytes: 123 })),
		};
		_setWorkflowExportDependenciesForTesting({ transport, storage });
		const operationContext = { signal: new AbortController().signal, emit: async () => {} };

		await expect(
			editorDataOperations['workflows.export.catalog']({ sessionId: 'user-1', orgId: 'org-1' }, operationContext),
		).resolves.toEqual([
			{
				id: 'wf-1',
				name: 'Workflow One',
				orgId: 'org-1',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-02-01T00:00:00.000Z',
				tags: [{ id: 'tag-1', name: 'Production' }],
			},
		]);

		const result = await editorDataOperations['workflows.export.run'](
			{
				sessionId: 'user-1',
				orgId: 'org-1',
				workflowIds: ['wf-1'],
				outputPath: '/abs/exports',
			},
			operationContext,
		);

		expect(result).toMatchObject({
			status: 'saved',
			orgId: 'org-1',
			workflowIds: ['wf-1'],
			outputPath: '/abs/exports/workflow-one.json',
			signingPresent: true,
		});
		expect(transport).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ workflowIds: ['wf-1'], signal: operationContext.signal }),
		);
		expect(rawGraphql).toHaveBeenCalledWith(
			expect.stringContaining('RewstBuddyPreviewWorkflows'),
			{ orgId: 'org-1', limit: 500, offset: 0 },
			{ signal: operationContext.signal },
		);
		expect(rawGraphql.mock.calls[0]?.[0]).toContain('tags { id name }');
		expect(storage.save).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ outputPath: '/abs/exports', overwrite: false, signal: operationContext.signal }),
		);
	});

	it('continues workflow pagination after a full page containing a null row', async () => {
		const firstPage = Array.from({ length: 500 }, (_, index) =>
			index === 250
				? null
				: {
						id: `wf-${index}`,
						name: `Workflow ${index}`,
						orgId: 'org-1',
					},
		);
		const rawGraphql = vi.fn(async (_query: string, variables?: Record<string, unknown>) => ({
			data: {
				workflows:
					variables?.offset === 0
						? firstPage
						: variables?.offset === 500
							? [{ id: 'wf-second-page', name: 'Second Page', orgId: 'org-1' }]
							: [],
			},
		}));
		installSession(rawGraphql);

		const rows = await editorDataOperations['workflows.export.catalog'](
			{ sessionId: 'user-1', orgId: 'org-1' },
			{ signal: new AbortController().signal, emit: async () => {} },
		);

		expect(rows).toHaveLength(500);
		expect(rows).toContainEqual({ id: 'wf-second-page', name: 'Second Page', orgId: 'org-1' });
		expect(rawGraphql.mock.calls.map(call => call[1]?.offset)).toEqual([0, 500]);
	});

	it('supplies the default destination and does not allow inline bundle output', async () => {
		const rawGraphql = vi.fn(async (query: string, variables?: Record<string, unknown>) =>
			query.includes('RewstBuddyWorkflowOwner')
				? { data: { workflow: { id: variables?.id, name: 'Workflow One', orgId: 'org-1' } } }
				: { data: {} },
		);
		installSession(rawGraphql);
		const transport = vi.fn(async () => ({
			recommendedFilename: 'workflow-one.json',
			bundle: {
				version: 2,
				exportedAt: '2026-09-18T00:00:00.000Z',
				signing: { signature: 'fixture' },
				objects: [{ type: 'workflow', id: 'wf-1' }],
			},
		}));
		const storage = {
			save: vi.fn(async () => ({ outputPath: '/abs/default-exports/workflow-one.json', bytes: 123 })),
		};
		_setWorkflowExportDependenciesForTesting({ transport, storage });
		const operationContext = { signal: new AbortController().signal, emit: async () => {} };

		const result = await editorDataOperations['workflows.export.run'](
			{
				sessionId: 'user-1',
				orgId: 'org-1',
				workflowIds: ['wf-1'],
				includeBundle: true,
			},
			operationContext,
		);

		expect(result).toMatchObject({ outputPath: '/abs/default-exports/workflow-one.json' });
		expect(result).not.toHaveProperty('bundle');
		expect(storage.save).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ outputPath: '/abs/default-exports', signal: operationContext.signal }),
		);
	});

	it('validates organization ownership before running a workflow picker query', async () => {
		const rawGraphql = vi.fn(async () => ({ data: { workflows: [] } }));
		installSession(rawGraphql);
		await expect(
			editorDataOperations['preview.workflows'](
				{ sessionId: 'user-1', orgId: 'other-org' },
				{
					signal: new AbortController().signal,
					emit: async () => {},
				},
			),
		).rejects.toThrow(/does not manage organization/i);
		expect(rawGraphql).not.toHaveBeenCalled();
	});

	it('renders through the session operation and preserves the structured result', async () => {
		const rawGraphql = vi.fn(async (query: string) =>
			query.includes('RewstBuddyRenderJinja')
				? { data: { renderJinja: { result: { answer: 42 } } } }
				: { data: {} },
		);
		installSession(rawGraphql);
		const result = await editorDataOperations['jinja.render'](
			{ sessionId: 'user-1', orgId: 'org-1', template: '{{ CTX.answer }}', vars: {} },
			{ signal: new AbortController().signal, emit: async () => {} },
		);
		expect(result).toEqual({ ok: true, value: { answer: 42 }, hasControlCharacter: false });
		expect(rawGraphql).toHaveBeenCalledWith(expect.stringContaining('RewstBuddyRenderJinja'), {
			orgId: 'org-1',
			template: '{{ CTX.answer }}',
			vars: {},
		});
	});

	it.each([
		{ kind: 'leading and trailing whitespace', template: ' \t{{ CTX.answer }}\r\n ' },
		{ kind: 'whitespace-only text', template: ' \t\r\n ' },
		{ kind: 'empty text', template: '' },
	])('preserves $kind when rendering a template', async ({ template }) => {
		const rawGraphql = vi.fn(async (_query: string, variables?: Record<string, unknown>) => ({
			data: { renderJinja: { result: variables?.template } },
		}));
		installSession(rawGraphql);
		const result = await editorDataOperations['jinja.render'](
			{ sessionId: 'user-1', orgId: 'org-1', template, vars: {} },
			{ signal: new AbortController().signal, emit: async () => {} },
		);
		expect(rawGraphql).toHaveBeenCalledWith(expect.stringContaining('RewstBuddyRenderJinja'), {
			orgId: 'org-1',
			template,
			vars: {},
		});
		expect(result).toEqual({ ok: true, value: template, hasControlCharacter: false });
	});

	it.each([undefined, null, 42, false, {}, []])('rejects a non-string template: %j', async template => {
		const rawGraphql = vi.fn(async () => ({ data: {} }));
		installSession(rawGraphql);
		await expect(
			editorDataOperations['jinja.render'](
				{ sessionId: 'user-1', orgId: 'org-1', template, vars: {} },
				{ signal: new AbortController().signal, emit: async () => {} },
			),
		).rejects.toThrow(/template/);
		expect(rawGraphql).not.toHaveBeenCalled();
	});

	it('requires preview context executions to belong to the requested organization', async () => {
		const rawGraphql = vi.fn(async (query: string) => {
			if (query.includes('RewstBuddyExecutionOwner')) {
				return { data: { workflowExecution: { id: 'exec-1', orgId: 'org-1' } } };
			}
			if (query.includes('RewstBuddyExecutionContexts')) {
				return { data: { workflowExecutionContexts: [{ answer: 42 }] } };
			}
			return { data: {} };
		});
		installSession(rawGraphql);
		await expect(
			editorDataOperations['preview.context'](
				{ sessionId: 'user-1', orgId: 'org-1', executionId: 'exec-1' },
				{ signal: new AbortController().signal, emit: async () => {} },
			),
		).resolves.toEqual({ answer: 42 });

		rawGraphql.mockImplementation(async (query: string) =>
			query.includes('RewstBuddyExecutionOwner')
				? { data: { workflowExecution: { id: 'exec-1', orgId: 'other-org' } } }
				: { data: { workflowExecutionContexts: [{ leaked: true }] } },
		);
		await expect(
			editorDataOperations['preview.context'](
				{ sessionId: 'user-1', orgId: 'org-1', executionId: 'exec-1' },
				{ signal: new AbortController().signal, emit: async () => {} },
			),
		).rejects.toThrow(/not available in organization/i);
		expect(rawGraphql).not.toHaveBeenLastCalledWith(
			expect.stringContaining('RewstBuddyExecutionContexts'),
			expect.anything(),
		);
	});

	it('correlates crate unpack progress with the caller stream', async () => {
		const rawGraphql = vi.fn(async (query: string) =>
			query.includes('RewstBuddyCrateDetail')
				? {
						data: {
							crate: {
								id: 'crate-1',
								name: 'Starter',
								requiredOrgVariables: [],
								tokens: [],
								crateTriggers: [],
								workflow: { name: 'Starter workflow', humanSecondsSaved: 0 },
							},
						},
					}
				: { data: {} },
		);
		installSession(rawGraphql);
		const run = vi.mocked(runUnpackCrate);
		run.mockImplementation(async options => {
			options.onProgress?.('exporting');
			return { id: 'workflow-1' };
		});
		const events: unknown[] = [];
		const result = await editorDataOperations['crates.unpack'](
			{
				sessionId: 'user-1',
				orgId: 'org-1',
				crateId: 'crate-1',
				streamId: 'stream-123',
				tokenValues: {},
				enableTriggers: false,
			},
			{ signal: new AbortController().signal, emit: async event => void events.push(event) },
		);

		expect(result).toEqual({ id: 'workflow-1' });
		expect(events).toEqual([{ type: 'progress', streamId: 'stream-123', label: 'exporting' }]);
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ input: expect.objectContaining({ crateId: 'crate-1', orgId: 'org-1' }) }),
		);
	});
});
