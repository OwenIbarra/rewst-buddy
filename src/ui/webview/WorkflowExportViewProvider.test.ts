import { SessionManager } from '@sessions';
import { createMockSession, initTestEnvironment, stub } from '@test';
import { join } from 'node:path';
import * as assert from 'assert';
import * as Mocha from 'mocha';
import vscode from 'vscode';
import { editorDataClient } from '../../backend/editorDataClient';
import { createWorkflowExporterHarness, FakeWorkflowExporterElement } from '../../test/helpers/workflowExporterHarness';
import { WORKFLOW_EXPORT_BOOTSTRAP_PAYLOAD } from '../../../packages/mcp-server/src/capabilities/workflowExportCapability';
import {
	WorkflowExportViewProvider,
	workflowExportOrganizations,
	workflowExportTargetExists,
} from './WorkflowExportViewProvider';

const { suite, test, setup, teardown } = Mocha;

function fakeView(): {
	view: vscode.WebviewView;
	state: {
		html: string;
		options: vscode.WebviewOptions;
		listener?: (message: unknown) => Promise<void>;
		messages: unknown[];
	};
} {
	const state: {
		html: string;
		options: vscode.WebviewOptions;
		listener?: (message: unknown) => Promise<void>;
		messages: unknown[];
	} = {
		html: '',
		options: {},
		messages: [],
	};
	const webview = {
		get html() {
			return state.html;
		},
		set html(value: string) {
			state.html = value;
		},
		get options() {
			return state.options;
		},
		set options(value: vscode.WebviewOptions) {
			state.options = value;
		},
		cspSource: 'vscode-webview://workflow-export-test',
		asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`vscode-webview://test${uri.path}`),
		onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
			state.listener = listener;
			return new vscode.Disposable(() => {});
		},
		postMessage: async (message: unknown) => {
			state.messages.push(message);
			return true;
		},
	} as unknown as vscode.Webview;
	return { view: { webview } as unknown as vscode.WebviewView, state };
}

suite('Unit: WorkflowExportViewProvider', () => {
	const restores: (() => void)[] = [];

	setup(() => {
		initTestEnvironment();
		SessionManager._resetForTesting();
	});

	teardown(() => {
		while (restores.length) restores.pop()!();
		SessionManager._resetForTesting();
	});

	function stubClient<K extends keyof typeof editorDataClient>(key: K, value: (typeof editorDataClient)[K]): void {
		const original = editorDataClient[key];
		Object.defineProperty(editorDataClient, key, { configurable: true, writable: true, value });
		restores.push(() =>
			Object.defineProperty(editorDataClient, key, { configurable: true, writable: true, value: original }),
		);
	}

	function setActiveOrganization(orgId = 'org-1', orgName = 'Org One'): void {
		const { session } = createMockSession({
			profile: {
				org: { id: orgId, name: orgName },
				allManagedOrgs: [{ id: orgId, name: orgName }],
			},
		});
		SessionManager._setSessionsForTesting([session], false);
	}

	function workflowRows(count: number): {
		id: string;
		name: string;
		orgId: string;
		createdAt: string;
		updatedAt: string;
		tags: never[];
	}[] {
		return Array.from({ length: count }, (_, index) => ({
			id: `wf-${index + 1}`,
			name: `Workflow ${index + 1}`,
			orgId: 'org-1',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-02-01T00:00:00.000Z',
			tags: [],
		}));
	}

	function exportResult(workflowIds: string[], outputPath: string | null = null) {
		return {
			status: 'saved' as const,
			orgId: 'org-1',
			workflowIds,
			recommendedFilename: 'export.json',
			outputPath,
			bytes: 10,
			version: 2,
			exportedAt: '2026-01-01T00:00:00.000Z',
			objectCount: workflowIds.length,
			signingPresent: true,
		};
	}

	async function loadProviderCatalog(rows: ReturnType<typeof workflowRows>): Promise<{
		provider: WorkflowExportViewProvider;
		fake: ReturnType<typeof fakeView>;
	}> {
		setActiveOrganization();
		stubClient(
			'getWorkflowExportDefaultDirectory',
			(async () => '/exports') as typeof editorDataClient.getWorkflowExportDefaultDirectory,
		);
		stubClient('listExportWorkflows', (async () => rows) as typeof editorDataClient.listExportWorkflows);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);
		await fake.state.listener?.({ type: 'ready' });
		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1' });
		return { provider, fake };
	}

	function messagesOfType(fake: ReturnType<typeof fakeView>, type: string): Record<string, unknown>[] {
		return fake.state.messages.filter((message): message is Record<string, unknown> =>
			Boolean(message && typeof message === 'object' && (message as { type?: unknown }).type === type),
		);
	}

	test('builds a stable, deduplicated organization catalog from active sessions', () => {
		const { session } = createMockSession({
			profile: {
				org: { id: 'org-main', name: 'Main Org' },
				allManagedOrgs: [
					{ id: 'org-main', name: 'Main Org' },
					{ id: 'org-z', name: 'Zulu Org' },
					{ id: 'org-a', name: 'Alpha Org' },
				],
			},
		});

		assert.deepStrictEqual(
			workflowExportOrganizations([session]).map(org => ({ id: org.id, name: org.name })),
			[
				{ id: 'org-a', name: 'Alpha Org' },
				{ id: 'org-main', name: 'Main Org' },
				{ id: 'org-z', name: 'Zulu Org' },
			],
		);
	});

	test('renders a script-enabled persistent Rewst Exporter without embedding credentials', () => {
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		assert.strictEqual(fake.state.options.enableScripts, true);
		assert.deepStrictEqual(
			fake.state.options.localResourceRoots?.map(uri => uri.fsPath),
			[vscode.Uri.joinPath(vscode.Uri.file('/extension'), 'media', 'workflow-exporter').fsPath],
		);
		assert.match(fake.state.html, /<title>Rewst Exporter<\/title>/);
		assert.match(fake.state.html, /<h2>Rewst Exporter<\/h2>/);
		assert.match(fake.state.html, /id="workflowSearch"/);
		assert.match(fake.state.html, /data-object-type="workflow"[^>]*>Workflows<\/button>/);
		assert.match(fake.state.html, /data-object-type="template"[^>]*>Templates<\/button>/);
		assert.match(fake.state.html, /data-object-type="form"[^>]*>Forms<\/button>/);
		assert.doesNotMatch(fake.state.html, /runDelegatedExport|delegatedExporter/);
		assert.match(fake.state.html, /id="organizationList"/);
		assert.match(fake.state.html, /id="changeOrganization"/);
		assert.doesNotMatch(fake.state.html, /<select id="organization"/);
		assert.match(fake.state.html, /id="tagList"/);
		assert.doesNotMatch(fake.state.html, /<select id="tags" multiple/);
		assert.match(fake.state.html, /id="useWorkflowNames"/);
		assert.match(fake.state.html, /media\/workflow-exporter\/main\.js/);
		const nonce = fake.state.html.match(/script-src 'nonce-([A-Za-z0-9_-]{43})'/)?.[1];
		assert.ok(nonce);
		assert.match(fake.state.html, new RegExp(`<script nonce="${nonce}"`));
		assert.doesNotMatch(fake.state.html, /appSession|cookie=|test-token/i);
		provider.dispose();
	});

	test('ignores malformed and unknown webview messages', async () => {
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		await assert.doesNotReject(() => fake.state.listener?.(null) ?? Promise.resolve());
		await assert.doesNotReject(() => fake.state.listener?.({ type: 'unknown' }) ?? Promise.resolve());
		provider.dispose();
	});

	test('defaults omitted object types to workflow and rejects unsupported types', async () => {
		setActiveOrganization();
		let workflowLoads = 0;
		stubClient('listExportWorkflows', (async () => {
			workflowLoads++;
			return workflowRows(1);
		}) as typeof editorDataClient.listExportWorkflows);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1' });
		assert.strictEqual(messagesOfType(fake, 'catalogLoaded').at(-1)?.objectType, 'workflow');
		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1', objectType: 'unknown' });
		await fake.state.listener?.({ type: 'applyFilters', orgId: 'org-1', objectType: 'unknown', filters: {} });
		await fake.state.listener?.({ type: 'chooseFolder', objectType: 'unknown' });
		await fake.state.listener?.({ type: 'chooseFile', objectType: 'unknown', objectCount: 1 });
		await fake.state.listener?.({
			type: 'startExport',
			orgId: 'org-1',
			objectType: 'unknown',
			objectIds: ['wf-1'],
		});

		assert.strictEqual(workflowLoads, 1);
		assert.strictEqual(messagesOfType(fake, 'catalogLoaded').length, 1);
		assert.strictEqual(messagesOfType(fake, 'exportComplete').length, 0);
		assert.deepStrictEqual(
			messagesOfType(fake, 'error').map(message => message.message),
			Array(5).fill('Choose a supported export object type.'),
		);
		provider.dispose();
	});

	test('includes the authoritative workflow limit in its bootstrap message', async () => {
		stubClient(
			'getWorkflowExportDefaultDirectory',
			(async () => '/exports') as typeof editorDataClient.getWorkflowExportDefaultDirectory,
		);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		await fake.state.listener?.({ type: 'ready' });

		assert.strictEqual(
			messagesOfType(fake, 'bootstrap').at(-1)?.maxWorkflowsPerExport,
			WORKFLOW_EXPORT_BOOTSTRAP_PAYLOAD.maxWorkflowsPerExport,
		);
		provider.dispose();
	});

	test('webview clears stale catalog state, reapplies filters, and honors the host bundle limit', () => {
		const harness = createWorkflowExporterHarness({
			organizations: [{ id: 'org-1', name: 'Org One' }],
			selectedOrgId: 'org-1',
			workflows: [{ id: 'wf-1' }, { id: 'wf-2' }, { id: 'wf-3' }],
			visibleIds: ['wf-1', 'wf-2', 'wf-3'],
			selectedIds: ['wf-1', 'wf-2', 'wf-3'],
			tags: [],
			filters: { search: 'daily', tagIds: [], tagMatch: 'any' },
			mode: 'bundle',
		});
		const { element } = harness;
		harness.send({
			type: 'bootstrap',
			organizations: [{ id: 'org-1', name: 'Org One' }],
			maxWorkflowsPerExport: 2,
		});
		assert.strictEqual(element('chooseFile').disabled, true);
		assert.strictEqual(element('workflowSearch').getAttribute('aria-label'), 'Search workflows');
		assert.strictEqual(element('tagList').getAttribute('aria-label'), 'Workflows tags');
		harness.postedMessages.length = 0;
		harness.send({ type: 'catalogLoaded', workflows: [{ id: 'wf-1' }], tags: [] });
		assert.strictEqual((harness.postedMessages.at(-1) as { type?: string })?.type, 'applyFilters');
		assert.strictEqual(
			(harness.postedMessages.at(-1) as { filters?: { search?: string } })?.filters?.search,
			'daily',
		);
		assert.strictEqual(element('tagFilters').hidden, false);
		assert.strictEqual(element('tagFiltersUnavailable').hidden, true);
		harness.send({ type: 'organizations', organizations: [{ id: 'org-2', name: 'Org Two' }] });
		assert.strictEqual(harness.savedState?.selectedOrgId, '');
		assert.strictEqual((harness.savedState?.workflows as unknown[])?.length, 0);
		assert.strictEqual((harness.savedState?.visibleIds as unknown[])?.length, 0);
		assert.strictEqual((harness.savedState?.selectedIds as unknown[])?.length, 0);
	});

	test('reports bootstrap failures without posting a partial bootstrap payload', async () => {
		stubClient('getWorkflowExportDefaultDirectory', (async () =>
			Promise.reject(
				new Error('directory unavailable'),
			)) as typeof editorDataClient.getWorkflowExportDefaultDirectory);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		await fake.state.listener?.({ type: 'ready' });

		assert.deepStrictEqual(messagesOfType(fake, 'bootstrap'), []);
		assert.deepStrictEqual(
			messagesOfType(fake, 'error').map(message => message.message),
			['Unable to initialize Rewst Exporter: directory unavailable'],
		);
		provider.dispose();
	});

	test('only treats ENOENT as an available workflow export target', async () => {
		const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
		const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });

		assert.strictEqual(
			await workflowExportTargetExists('/exports/new.json', async () => Promise.reject(missing)),
			false,
		);
		await assert.rejects(
			() => workflowExportTargetExists('/exports/blocked.json', async () => Promise.reject(denied)),
			/permission denied/,
		);
	});

	test('rehydrates persisted webview controls and clears stale export state on bootstrap', () => {
		const persistedState = {
			objectType: 'form',
			organizations: [],
			selectedOrgId: 'org-1',
			catalogOrgId: 'org-1',
			catalogObjectType: 'form',
			objects: [
				{
					id: 'form-old',
					name: 'Old form',
					orgId: 'org-1',
					orgName: 'Org One',
					tags: [],
				},
			],
			visibleIds: ['form-old'],
			selectedIds: ['form-old'],
			tags: [{ id: 'onboarding', name: 'Onboarding' }],
			filters: {
				search: 'daily',
				tagIds: [],
				tagMatch: 'all',
				createdFrom: '2026-01-01',
				createdTo: '2026-01-31',
				updatedFrom: '2026-02-01',
				updatedTo: '2026-02-28',
			},
			mode: 'bundle',
			useWorkflowNames: true,
			exporting: true,
		};
		const harness = createWorkflowExporterHarness(persistedState);
		const { element, modeRadios, objectButtons, createdFilters, updatedFilters, postedMessages } = harness;

		assert.strictEqual(element('workflowSearch').value, 'daily');
		assert.strictEqual(element('createdFrom').value, '2026-01-01');
		assert.strictEqual(element('createdTo').value, '2026-01-31');
		assert.strictEqual(element('updatedFrom').value, '2026-02-01');
		assert.strictEqual(element('updatedTo').value, '2026-02-28');
		assert.strictEqual(modeRadios.find(radio => radio.value === 'bundle')?.checked, true);
		assert.strictEqual(element('useWorkflowNames').checked, true);
		assert.strictEqual(element('filters-heading').textContent, 'Forms');
		assert.strictEqual(element('selectionCount').textContent, '1 selected · 1 visible');
		assert.strictEqual(element('filenameOptionLabel').textContent, 'Use form names for filenames');
		assert.ok(createdFilters.every(section => !section.hidden));
		assert.ok(updatedFilters.every(section => !section.hidden));
		element('organizationSearch').oninput?.({
			target: Object.assign(new FakeWorkflowExporterElement(), { value: 'org' }),
		});
		element('workflowSearch').oninput?.({
			target: Object.assign(new FakeWorkflowExporterElement(), { value: 'work' }),
		});
		element('tagSearch').oninput?.({ target: Object.assign(new FakeWorkflowExporterElement(), { value: 'tag' }) });
		assert.strictEqual(harness.saveCount, 0);

		harness.send({
			type: 'bootstrap',
			organizations: [{ id: 'org-1', name: 'Org One' }],
			defaultDirectory: '/exports',
		});
		assert.strictEqual(harness.savedState?.exporting, false);
		assert.ok(!postedMessages.some(message => (message as { type?: string }).type === 'loadCatalog'));
		objectButtons
			.find(button => button.dataset.objectType === 'template')
			?.onclick?.({
				currentTarget: objectButtons.find(button => button.dataset.objectType === 'template')!,
				target: objectButtons.find(button => button.dataset.objectType === 'template')!,
			});
		assert.strictEqual((harness.savedState?.selectedIds as unknown[] | undefined)?.length, 0);
		assert.strictEqual(harness.savedState?.catalogOrgId, '');
		assert.strictEqual(harness.savedState?.catalogObjectType, '');
		assert.ok(
			postedMessages.some(
				message =>
					(message as { type?: string; objectType?: string }).type === 'loadCatalog' &&
					(message as { objectType?: string }).objectType === 'template',
			),
		);
		harness.send({
			type: 'catalogLoaded',
			objectType: 'template',
			orgId: 'org-1',
			objects: [{ id: 'template-1', name: 'Welcome', tags: [] }],
			tags: [],
			fieldSupport: { tags: true, createdAt: true, updatedAt: true },
			maxObjectsPerExport: 25,
		});
		assert.strictEqual((harness.savedState?.selectedIds as unknown[] | undefined)?.length, 0);
		assert.strictEqual(harness.savedState?.catalogObjectType, 'template');
		assert.strictEqual(element('status').textContent, 'Loaded 1 templates.');
		element('refreshCatalog').disabled = true;
		harness.send({
			type: 'error',
			objectType: 'template',
			orgId: 'org-1',
			message: 'Unable to load templates: failed',
		});
		assert.strictEqual(element('refreshCatalog').disabled, false);
		assert.strictEqual((harness.savedState?.filters as { search?: string } | undefined)?.search, '');
	});

	test('cancels stale catalog requests across organization and object-type switches', async () => {
		const { session } = createMockSession({
			profile: {
				org: { id: 'org-1', name: 'Org One' },
				allManagedOrgs: [
					{ id: 'org-1', name: 'Org One' },
					{ id: 'org-2', name: 'Org Two' },
				],
			},
		});
		SessionManager._setSessionsForTesting([session], false);
		let resolveWorkflowRows!: (rows: ReturnType<typeof workflowRows>) => void;
		const pendingWorkflows = new Promise<ReturnType<typeof workflowRows>>(resolve => {
			resolveWorkflowRows = resolve;
		});
		let staleSignal: AbortSignal | undefined;
		stubClient('listExportWorkflows', ((_input, options) => {
			staleSignal = options?.signal;
			return pendingWorkflows;
		}) as typeof editorDataClient.listExportWorkflows);
		stubClient('listExportTemplates', (async () => [
			{ id: 'template-2', name: 'Current template', orgId: 'org-2' },
		]) as typeof editorDataClient.listExportTemplates);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		const staleLoad = fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1', objectType: 'workflow' });
		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-2', objectType: 'template' });
		assert.strictEqual(staleSignal?.aborted, true);
		resolveWorkflowRows(workflowRows(1));
		await staleLoad;

		assert.deepStrictEqual(
			messagesOfType(fake, 'catalogLoaded').map(message => ({
				orgId: message.orgId,
				objectType: message.objectType,
				ids: (message.objects as { id: string }[]).map(item => item.id),
			})),
			[{ orgId: 'org-2', objectType: 'template', ids: ['template-2'] }],
		);
		assert.deepStrictEqual(messagesOfType(fake, 'error'), []);
		provider.dispose();
	});

	test('loads, filters, and dispatches template and form exports through the shared provider', async () => {
		setActiveOrganization();
		const activeSession = SessionManager.getActiveSessions()[0]!;
		const sessionId = activeSession.sessionId ?? activeSession.profile.user.id!;
		stubClient(
			'getWorkflowExportDefaultDirectory',
			(async () => '/exports') as typeof editorDataClient.getWorkflowExportDefaultDirectory,
		);
		stubClient('listExportTemplates', (async () => [
			{
				id: 'template-1',
				name: 'Welcome / template',
				orgId: 'org-1',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-31T00:00:00.000Z',
				tags: [{ id: 'customer', name: 'Customer' }],
			},
		]) as typeof editorDataClient.listExportTemplates);
		stubClient('listExportForms', (async () => [
			{
				id: 'form-1',
				name: 'Employee / intake',
				orgId: 'org-1',
				createdAt: '2026-02-01T00:00:00.000Z',
				updatedAt: '2026-02-28T00:00:00.000Z',
				tags: [{ id: 'employee', name: 'Employee' }],
			},
		]) as typeof editorDataClient.listExportForms);
		const exportCalls: Parameters<typeof editorDataClient.exportObjects>[0][] = [];
		const exportSignals: (AbortSignal | undefined)[] = [];
		stubClient('exportObjects', (async (input, options) => {
			exportCalls.push(input);
			exportSignals.push(options?.signal);
			return {
				status: 'saved',
				orgId: input.orgId,
				objectType: input.objectType,
				objectIds: input.objectIds,
				outputPath: input.outputPath ?? null,
			};
		}) as typeof editorDataClient.exportObjects);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);
		await fake.state.listener?.({ type: 'ready' });

		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1', objectType: 'template' });
		await fake.state.listener?.({
			type: 'applyFilters',
			objectType: 'template',
			orgId: 'org-1',
			filters: { search: 'welcome', tagIds: ['customer'], tagMatch: 'all', createdFrom: '2026-01-01' },
		});
		await fake.state.listener?.({
			type: 'startExport',
			objectType: 'template',
			orgId: 'org-1',
			objectIds: ['template-1'],
			mode: 'bundle',
		});

		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1', objectType: 'form' });
		await fake.state.listener?.({
			type: 'startExport',
			objectType: 'form',
			orgId: 'org-1',
			objectIds: ['form-1'],
			mode: 'separate',
			useObjectNames: true,
		});

		assert.deepStrictEqual(exportCalls, [
			{
				sessionId,
				orgId: 'org-1',
				objectType: 'template',
				objectIds: ['template-1'],
				outputPath: '/exports/rewst-templates-batch-001-of-001.json',
			},
			{
				sessionId,
				orgId: 'org-1',
				objectType: 'form',
				objectIds: ['form-1'],
				outputPath: '/exports/Employee - intake--form-1.json',
			},
		]);
		assert.strictEqual(exportSignals.length, 2);
		assert.ok(exportSignals.every(signal => signal instanceof AbortSignal && !signal.aborted));
		assert.deepStrictEqual(messagesOfType(fake, 'filterResult').at(-1), {
			type: 'filterResult',
			objectType: 'template',
			orgId: 'org-1',
			objectIds: ['template-1'],
		});
		assert.ok(
			messagesOfType(fake, 'exportProgress').some(message =>
				String(message.message).includes('Bundling 1 template'),
			),
		);
		assert.deepStrictEqual(
			messagesOfType(fake, 'exportComplete').map(message => ({
				objectType: message.objectType,
				exportedObjectCount: message.exportedObjectCount,
				fileCount: message.fileCount,
			})),
			[
				{ objectType: 'template', exportedObjectCount: 1, fileCount: 1 },
				{ objectType: 'form', exportedObjectCount: 1, fileCount: 1 },
			],
		);
		provider.dispose();
	});

	test('uses object-specific UI errors for template and form catalog and destination failures', async () => {
		setActiveOrganization();
		stubClient('getWorkflowExportDefaultDirectory', (async () =>
			process.cwd()) as typeof editorDataClient.getWorkflowExportDefaultDirectory);
		stubClient('listExportTemplates', (async () => {
			throw new Error('template catalog unavailable');
		}) as typeof editorDataClient.listExportTemplates);
		stubClient('listExportForms', (async () => []) as typeof editorDataClient.listExportForms);
		restores.push(
			stub(vscode.window, 'showSaveDialog', (async () =>
				vscode.Uri.file(join(process.cwd(), 'package.json'))) as typeof vscode.window.showSaveDialog),
		);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1', objectType: 'template' });
		await fake.state.listener?.({ type: 'chooseFile', objectType: 'form', objectCount: 1 });

		assert.deepStrictEqual(
			messagesOfType(fake, 'error').map(message => message.message),
			[
				'Unable to load templates: template catalog unavailable',
				'Choose a new file name; form exports never overwrite files.',
			],
		);
		assert.ok(messagesOfType(fake, 'error').every(message => !String(message.message).includes('workflow')));
		provider.dispose();
	});

	test('loads metadata, applies filters, and exports separate files through the shared name-based engine', async () => {
		const { session } = createMockSession({
			profile: {
				org: { id: 'org-1', name: 'Org One' },
				allManagedOrgs: [{ id: 'org-1', name: 'Org One' }],
			},
		});
		SessionManager._setSessionsForTesting([session], false);
		const exportCalls: { workflowIds: string[]; outputPath?: string }[] = [];
		stubClient(
			'getWorkflowExportDefaultDirectory',
			(async () => '/exports') as typeof editorDataClient.getWorkflowExportDefaultDirectory,
		);
		stubClient('listExportWorkflows', (async () => [
			{
				id: 'wf-1',
				name: 'Daily / Sync',
				orgId: 'org-1',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-02-01T00:00:00.000Z',
				tags: [{ id: 'ops', name: 'Operations' }],
			},
		]) as typeof editorDataClient.listExportWorkflows);
		stubClient('exportWorkflows', (async input => {
			exportCalls.push(input);
			return {
				status: 'saved',
				orgId: input.orgId,
				workflowIds: input.workflowIds,
				recommendedFilename: 'export.json',
				outputPath: input.outputPath ?? null,
				bytes: 10,
				version: 2,
				exportedAt: '2026-01-01T00:00:00.000Z',
				objectCount: 1,
				signingPresent: true,
			};
		}) as typeof editorDataClient.exportWorkflows);

		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);
		await fake.state.listener?.({ type: 'ready' });
		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1' });
		await fake.state.listener?.({
			type: 'applyFilters',
			filters: { search: 'daily', tagIds: ['ops'], tagMatch: 'all', updatedFrom: '2026-02-01' },
		});
		(provider as unknown as { destination: { kind: 'file'; outputPath: string } }).destination = {
			kind: 'file',
			outputPath: '/exports/previous-bundle.json',
		};
		await fake.state.listener?.({
			type: 'startExport',
			orgId: 'org-1',
			workflowIds: ['wf-1'],
			mode: 'separate',
			useWorkflowNames: true,
		});

		assert.deepStrictEqual(
			exportCalls.map(({ workflowIds, outputPath }) => ({ workflowIds, outputPath })),
			[{ workflowIds: ['wf-1'], outputPath: '/exports/Daily - Sync--wf-1.json' }],
		);
		assert.ok(
			fake.state.messages.some(
				message =>
					(message as { type?: string; kind?: string; isDefault?: boolean }).type === 'destination' &&
					(message as { kind?: string }).kind === 'directory' &&
					(message as { isDefault?: boolean }).isDefault === true,
			),
		);
		assert.ok(
			fake.state.messages.some(
				message =>
					(message as { type?: string; workflowIds?: string[] }).type === 'filterResult' &&
					(message as { workflowIds?: string[] }).workflowIds?.[0] === 'wf-1',
			),
		);
		assert.ok(
			fake.state.messages.some(
				message =>
					(message as { type?: string; exportedWorkflowCount?: number }).type === 'exportComplete' &&
					(message as { exportedWorkflowCount?: number }).exportedWorkflowCount === 1,
			),
		);
		provider.dispose();
	});

	test('rejects invalid catalog organizations and stale organization exports without backend calls', async () => {
		setActiveOrganization();
		let listCalls = 0;
		let exportCalls = 0;
		stubClient(
			'getWorkflowExportDefaultDirectory',
			(async () => '/exports') as typeof editorDataClient.getWorkflowExportDefaultDirectory,
		);
		stubClient('listExportWorkflows', (async () => {
			listCalls++;
			return workflowRows(1);
		}) as typeof editorDataClient.listExportWorkflows);
		stubClient('exportWorkflows', (async input => {
			exportCalls++;
			return exportResult(input.workflowIds, input.outputPath ?? null);
		}) as typeof editorDataClient.exportWorkflows);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-missing' });
		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1' });
		await fake.state.listener?.({
			type: 'startExport',
			orgId: 'org-missing',
			workflowIds: ['wf-1'],
			mode: 'bundle',
		});

		assert.strictEqual(listCalls, 1);
		assert.strictEqual(exportCalls, 0);
		assert.deepStrictEqual(
			messagesOfType(fake, 'error').map(message => message.message),
			['Choose an active Rewst organization.', 'Reload the selected organization before exporting.'],
		);
		provider.dispose();
	});

	test('rejects unknown workflow ids from a loaded catalog', async () => {
		let exportCalls = 0;
		stubClient('exportWorkflows', (async input => {
			exportCalls++;
			return exportResult(input.workflowIds, input.outputPath ?? null);
		}) as typeof editorDataClient.exportWorkflows);
		const { provider, fake } = await loadProviderCatalog(workflowRows(1));

		await fake.state.listener?.({
			type: 'startExport',
			orgId: 'org-1',
			workflowIds: ['wf-1', 'wf-unknown'],
			mode: 'bundle',
		});

		assert.strictEqual(exportCalls, 0);
		assert.deepStrictEqual(
			messagesOfType(fake, 'error').map(message => message.message),
			['Select at least one workflow from the current catalog.'],
		);
		provider.dispose();
	});

	test('rejects a concurrent export while the first export is still running', async () => {
		let resolveExport!: (value: ReturnType<typeof exportResult>) => void;
		let notifyStarted!: () => void;
		const started = new Promise<void>(resolve => (notifyStarted = resolve));
		const pending = new Promise<ReturnType<typeof exportResult>>(resolve => (resolveExport = resolve));
		let exportCalls = 0;
		stubClient('exportWorkflows', (async input => {
			exportCalls++;
			notifyStarted();
			return pending.then(value => ({ ...value, outputPath: input.outputPath ?? null }));
		}) as typeof editorDataClient.exportWorkflows);
		const { provider, fake } = await loadProviderCatalog(workflowRows(1));
		const message = { type: 'startExport', orgId: 'org-1', workflowIds: ['wf-1'], mode: 'bundle' };

		const firstExport = fake.state.listener?.(message);
		await started;
		await fake.state.listener?.(message);

		assert.strictEqual(exportCalls, 1);
		assert.ok(
			messagesOfType(fake, 'error').some(message => message.message === 'A workflow export is already running.'),
		);
		resolveExport(exportResult(['wf-1']));
		await firstExport;
		assert.strictEqual(messagesOfType(fake, 'exportComplete').length, 1);
		provider.dispose();
	});

	test('claims the export slot before asynchronous destination initialization', async () => {
		setActiveOrganization();
		let resolveDirectory!: (value: string) => void;
		const pendingDirectory = new Promise<string>(resolve => (resolveDirectory = resolve));
		stubClient(
			'getWorkflowExportDefaultDirectory',
			(() => pendingDirectory) as typeof editorDataClient.getWorkflowExportDefaultDirectory,
		);
		stubClient('listExportWorkflows', (async () => workflowRows(1)) as typeof editorDataClient.listExportWorkflows);
		let exportCalls = 0;
		stubClient('exportWorkflows', (async input => {
			exportCalls++;
			return exportResult(input.workflowIds, input.outputPath ?? null);
		}) as typeof editorDataClient.exportWorkflows);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);
		await fake.state.listener?.({ type: 'loadCatalog', orgId: 'org-1' });
		const message = { type: 'startExport', orgId: 'org-1', workflowIds: ['wf-1'], mode: 'bundle' };

		const firstExport = fake.state.listener?.(message);
		await fake.state.listener?.(message);

		assert.strictEqual(exportCalls, 0);
		assert.ok(messagesOfType(fake, 'error').some(item => item.message === 'A workflow export is already running.'));
		resolveDirectory('/exports');
		await firstExport;
		assert.strictEqual(exportCalls, 1);
		provider.dispose();
	});

	test('exports 26 bundled workflows as two backend calls and reports aggregate completion', async () => {
		const calls: { workflowIds: string[]; outputPath?: string }[] = [];
		stubClient('exportWorkflows', (async input => {
			calls.push({ workflowIds: input.workflowIds, outputPath: input.outputPath });
			return exportResult(input.workflowIds, input.outputPath ?? null);
		}) as typeof editorDataClient.exportWorkflows);
		const rows = workflowRows(26);
		const { provider, fake } = await loadProviderCatalog(rows);

		await fake.state.listener?.({
			type: 'startExport',
			orgId: 'org-1',
			workflowIds: rows.map(row => row.id),
			mode: 'bundle',
		});

		assert.deepStrictEqual(
			calls.map(call => call.workflowIds.length),
			[25, 1],
		);
		assert.deepStrictEqual(
			calls.map(call => call.outputPath),
			['/exports/rewst-workflows-batch-001-of-002.json', '/exports/rewst-workflows-batch-002-of-002.json'],
		);
		assert.deepStrictEqual(messagesOfType(fake, 'exportComplete').at(-1), {
			type: 'exportComplete',
			cancelled: false,
			exportedWorkflowCount: 26,
			fileCount: 2,
			outputPaths: calls.map(call => call.outputPath),
			failures: [],
		});
		assert.strictEqual(messagesOfType(fake, 'exportProgress').at(-1)?.percent, 100);
		provider.dispose();
	});

	test('cancels an in-flight backend export and reports cancelled completion', async () => {
		let notifyStarted!: () => void;
		const started = new Promise<void>(resolve => (notifyStarted = resolve));
		let receivedSignal: AbortSignal | undefined;
		stubClient('exportWorkflows', ((_input, options) => {
			receivedSignal = options?.signal;
			notifyStarted();
			return new Promise((_, reject) => {
				options?.signal?.addEventListener('abort', () => reject(new Error('cancelled by test')), {
					once: true,
				});
			});
		}) as typeof editorDataClient.exportWorkflows);
		const { provider, fake } = await loadProviderCatalog(workflowRows(1));

		const exportPromise = fake.state.listener?.({
			type: 'startExport',
			orgId: 'org-1',
			workflowIds: ['wf-1'],
			mode: 'bundle',
		});
		await started;
		await fake.state.listener?.({ type: 'cancelExport' });
		await exportPromise;

		assert.strictEqual(receivedSignal?.aborted, true);
		assert.deepStrictEqual(messagesOfType(fake, 'exportComplete').at(-1), {
			type: 'exportComplete',
			cancelled: true,
			exportedWorkflowCount: 0,
			fileCount: 0,
			outputPaths: [],
			failures: [],
		});
		provider.dispose();
	});

	test('reports a failed bundle while retaining a successful later batch', async () => {
		let callIndex = 0;
		stubClient('exportWorkflows', (async input => {
			if (callIndex++ === 0) throw new Error('first batch failed');
			return exportResult(input.workflowIds, input.outputPath ?? null);
		}) as typeof editorDataClient.exportWorkflows);
		const rows = workflowRows(26);
		const { provider, fake } = await loadProviderCatalog(rows);

		await fake.state.listener?.({
			type: 'startExport',
			orgId: 'org-1',
			workflowIds: rows.map(row => row.id),
			mode: 'bundle',
		});

		const completion = messagesOfType(fake, 'exportComplete').at(-1);
		assert.strictEqual(callIndex, 2);
		assert.strictEqual(completion?.cancelled, false);
		assert.strictEqual(completion?.exportedWorkflowCount, 1);
		assert.strictEqual(completion?.fileCount, 1);
		assert.deepStrictEqual(completion?.failures, [
			{
				workflowName: undefined,
				workflowId: undefined,
				workflowIds: rows.slice(0, 25).map(row => row.id),
				message: 'first batch failed',
			},
		]);
		provider.dispose();
	});

	test('rejects an existing file destination without changing the destination', async () => {
		setActiveOrganization();
		stubClient('getWorkflowExportDefaultDirectory', (async () =>
			process.cwd()) as typeof editorDataClient.getWorkflowExportDefaultDirectory);
		restores.push(
			stub(vscode.window, 'showSaveDialog', (async () =>
				vscode.Uri.file(join(process.cwd(), 'package.json'))) as typeof vscode.window.showSaveDialog),
		);
		const provider = new WorkflowExportViewProvider(vscode.Uri.file('/extension'));
		const fake = fakeView();
		provider.resolveWebviewView(fake.view);

		await fake.state.listener?.({ type: 'chooseFile', workflowCount: 1 });

		assert.deepStrictEqual(
			messagesOfType(fake, 'error').map(message => message.message),
			['Choose a new file name; workflow exports never overwrite files.'],
		);
		assert.deepStrictEqual(messagesOfType(fake, 'destination'), []);
		provider.dispose();
	});

	test('reveals only output paths returned by completed exports', async () => {
		const revealed: string[] = [];
		restores.push(
			stub(vscode.commands, 'executeCommand', (async (command: string, uri?: vscode.Uri) => {
				if (command === 'revealFileInOS' && uri) revealed.push(uri.fsPath);
			}) as typeof vscode.commands.executeCommand),
		);
		stubClient('exportWorkflows', (async input =>
			exportResult(input.workflowIds, '/exports/completed.json')) as typeof editorDataClient.exportWorkflows);
		const { provider, fake } = await loadProviderCatalog(workflowRows(1));

		await fake.state.listener?.({ type: 'reveal', path: '/exports/untrusted.json' });
		await fake.state.listener?.({ type: 'startExport', orgId: 'org-1', workflowIds: ['wf-1'], mode: 'bundle' });
		await fake.state.listener?.({ type: 'reveal', path: '/exports/completed.json' });
		await fake.state.listener?.({ type: 'reveal', path: '/exports/untrusted.json' });

		assert.deepStrictEqual(revealed, ['/exports/completed.json']);
		provider.dispose();
	});
});
