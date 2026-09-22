import { createMockSession, Fixtures, initTestEnvironment, installMockSessions, stub } from '@test';
import { context } from '@global';
import { SessionManager } from '@sessions';
import { log } from '@utils';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as assert from 'assert';
import * as Mocha from 'mocha';
import vscode from 'vscode';
import { editorDataClient } from '../../backend/editorDataClient';
import type { WorkflowExportResult } from '../../../packages/mcp-server/src/capabilities/workflowExportCapability';
import { WORKFLOW_EXPORT_BOOTSTRAP_PAYLOAD } from '../../../packages/mcp-server/src/capabilities/workflowExportCapability';
import {
	MAX_WORKFLOW_CATALOG_CACHE_ENTRIES,
	MAX_WORKFLOW_CATALOG_CACHE_ROWS,
	MAX_WORKFLOW_EXPORT_BATCH_SIZE,
	WORKFLOW_CATALOG_CACHE_KEY,
	ExportWorkflows,
	chooseWorkflowCatalog,
	pickDestination,
	persistWorkflowCatalog,
	readCachedWorkflowCatalog,
	runWorkflowExports,
	sanitizeWorkflowFilenamePart,
	separateWorkflowExportFilename,
	workflowExportOutputPath,
	workflowExportDestinationChoices,
	workflowExportTargetExists,
	workflowQuickPickItems,
	writeCachedWorkflowCatalog,
	validateWorkflowExportPath,
	type ExportWorkflowChoice,
} from './ExportWorkflows';

const { suite, test, setup } = Mocha;

function workflow(id: string, name = id): ExportWorkflowChoice {
	return { id, name, orgId: 'org-1', orgName: 'Org One' };
}

function result(ids: string[], outputPath = `/exports/${ids.join('-')}.json`): WorkflowExportResult {
	return {
		status: 'saved',
		orgId: 'org-1',
		workflowIds: ids,
		recommendedFilename: 'export.json',
		outputPath,
		bytes: 100,
		version: 2,
		exportedAt: '2026-09-18T00:00:00.000Z',
		objectCount: ids.length,
		signingPresent: true,
	};
}

suite('Unit: ExportWorkflows helpers', () => {
	setup(() => initTestEnvironment());

	test('picker rows are searchable by org/id and distinguish duplicate names', () => {
		const items = workflowQuickPickItems(
			[
				{ id: 'wf-1', name: 'Onboarding', orgId: 'org-1' },
				{ id: 'wf-2', name: 'Onboarding', orgId: 'org-1' },
				{ id: 'wf-2', name: 'Duplicate row', orgId: 'org-1' },
				{ id: null, name: 'Missing id' },
			],
			{ id: 'org-1', name: 'Org One' },
		);

		assert.strictEqual(items.length, 2);
		assert.deepStrictEqual(
			items.map(item => item.label),
			['Onboarding', 'Onboarding'],
		);
		assert.match(items[0].description ?? '', /Org One.*org-1/);
		assert.strictEqual(items[0].detail, 'Workflow ID: wf-1');
		assert.strictEqual(items[1].detail, 'Workflow ID: wf-2');
	});

	test('picker rows trim values and fall back to the id for missing names or organizations', () => {
		const items = workflowQuickPickItems(
			[
				{ id: ' wf-1 ', name: '  ', orgId: ' org-9 ' },
				{ id: ' wf-1 ', name: 'Duplicate id' },
				{ id: ' wf-2 ', name: null, orgId: null },
			],
			{ id: 'org-1', name: 'Org One' },
		);

		assert.deepStrictEqual(
			items.map(item => item.workflow),
			[
				{ id: 'wf-1', name: 'wf-1', orgId: 'org-9', orgName: 'Org One' },
				{ id: 'wf-2', name: 'wf-2', orgId: 'org-1', orgName: 'Org One' },
			],
		);
	});

	test('destination choices allow a file only for bundled exports', () => {
		assert.deepStrictEqual(
			workflowExportDestinationChoices('bundle', '/exports').map(choice => choice.value),
			['default', 'folder', 'file', 'input'],
		);
		assert.deepStrictEqual(
			workflowExportDestinationChoices('separate', '/exports').map(choice => choice.value),
			['default', 'folder', 'input'],
		);
		assert.strictEqual(workflowExportDestinationChoices('separate', '/exports')[0].detail, '/exports');
		assert.match(workflowExportDestinationChoices('separate', '/exports')[2].detail ?? '', /existing folder/i);
		assert.deepStrictEqual(
			workflowExportDestinationChoices('bundle', '/exports', MAX_WORKFLOW_EXPORT_BATCH_SIZE + 1).map(
				choice => choice.value,
			),
			['default', 'folder', 'input'],
		);
	});

	test('public target check treats only ENOENT as available and accepts an injected stat', async () => {
		assert.strictEqual(await workflowExportTargetExists('/exports/present.json', async () => ({})), true);
		const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
		assert.strictEqual(
			await workflowExportTargetExists('/exports/missing.json', async () => Promise.reject(missing)),
			false,
		);
		const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
		await assert.rejects(
			workflowExportTargetExists('/exports/denied.json', async () => Promise.reject(denied)),
			/denied/,
		);
	});

	test('workflow export bootstrap payload exposes the authoritative backend batch limit', () => {
		assert.strictEqual(WORKFLOW_EXPORT_BOOTSTRAP_PAYLOAD.maxWorkflowsPerExport, MAX_WORKFLOW_EXPORT_BATCH_SIZE);
	});

	test('workflow catalog cache writes and reads a matching session and organization entry', async () => {
		const entry = {
			sessionId: 'session-1',
			orgId: 'org-1',
			fetchedAt: '2026-09-18T12:00:00.000Z',
			workflows: [{ id: 'wf-1', name: 'One', orgId: 'org-1' }],
		};

		await writeCachedWorkflowCatalog(entry);

		assert.deepStrictEqual(readCachedWorkflowCatalog('session-1', 'org-1'), entry);
		assert.strictEqual(readCachedWorkflowCatalog('session-2', 'org-1'), undefined);
	});

	test('workflow catalog cache ignores malformed and mismatched entries', async () => {
		await context.globalState.update(WORKFLOW_CATALOG_CACHE_KEY, {
			entries: {
				['session-1\u0000org-1']: { sessionId: 'session-1', orgId: 'org-1', fetchedAt: 'not-a-date' },
				['session-1\u0000org-2']: {
					sessionId: 'other-session',
					orgId: 'org-2',
					fetchedAt: '2026-09-18T12:00:00.000Z',
					workflows: [],
				},
			},
		});

		assert.strictEqual(readCachedWorkflowCatalog('session-1', 'org-1'), undefined);
		assert.strictEqual(readCachedWorkflowCatalog('session-1', 'org-2'), undefined);
	});

	test('workflow catalog cache retains only the newest bounded set of entries', async () => {
		for (let index = 0; index <= MAX_WORKFLOW_CATALOG_CACHE_ENTRIES; index += 1) {
			await writeCachedWorkflowCatalog({
				sessionId: 'session-1',
				orgId: `org-${index}`,
				fetchedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
				workflows: [],
			});
		}

		const stored = context.globalState.get<{ entries: Record<string, unknown> }>(WORKFLOW_CATALOG_CACHE_KEY);
		assert.strictEqual(Object.keys(stored?.entries ?? {}).length, MAX_WORKFLOW_CATALOG_CACHE_ENTRIES);
		assert.strictEqual(readCachedWorkflowCatalog('session-1', 'org-0'), undefined);
		assert.ok(readCachedWorkflowCatalog('session-1', `org-${MAX_WORKFLOW_CATALOG_CACHE_ENTRIES}`));
	});

	test('workflow catalog cache bounds total rows without truncating catalogs', async () => {
		const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `wf-${index}` }));
		await writeCachedWorkflowCatalog({
			sessionId: 'session-1',
			orgId: 'old',
			fetchedAt: '2026-01-01T00:00:00.000Z',
			workflows: rows(2_000),
		});
		await writeCachedWorkflowCatalog({
			sessionId: 'session-1',
			orgId: 'new',
			fetchedAt: '2026-01-02T00:00:00.000Z',
			workflows: rows(3_000),
		});
		await writeCachedWorkflowCatalog({
			sessionId: 'session-1',
			orgId: 'newest',
			fetchedAt: '2026-01-03T00:00:00.000Z',
			workflows: rows(1),
		});

		assert.strictEqual(readCachedWorkflowCatalog('session-1', 'old'), undefined);
		assert.strictEqual(readCachedWorkflowCatalog('session-1', 'new')?.workflows.length, 3_000);
		assert.strictEqual(readCachedWorkflowCatalog('session-1', 'newest')?.workflows.length, 1);

		await writeCachedWorkflowCatalog({
			sessionId: 'session-1',
			orgId: 'oversized',
			fetchedAt: '2026-01-04T00:00:00.000Z',
			workflows: rows(MAX_WORKFLOW_CATALOG_CACHE_ROWS + 1),
		});
		assert.strictEqual(readCachedWorkflowCatalog('session-1', 'oversized'), undefined);
		assert.strictEqual(readCachedWorkflowCatalog('session-1', 'new')?.workflows.length, 3_000);
	});

	test('catalog chooser returns a cached entry and does not fetch', async () => {
		const entry = {
			sessionId: 'session-1',
			orgId: 'org-1',
			fetchedAt: '2026-09-18T12:00:00.000Z',
			workflows: [],
		};
		await writeCachedWorkflowCatalog(entry);
		const restorePicker = stub(vscode.window, 'showQuickPick', (async (items: readonly { value: string }[]) =>
			items.find(item => item.value === 'cached')) as unknown as typeof vscode.window.showQuickPick);
		const restoreFetch = stub(editorDataClient, 'listExportWorkflows', (async () => {
			throw new Error('cache hit must not fetch');
		}) as typeof editorDataClient.listExportWorkflows);
		try {
			assert.deepStrictEqual(await chooseWorkflowCatalog('session-1', { id: 'org-1', name: 'Org One' }), entry);
		} finally {
			restoreFetch();
			restorePicker();
		}
	});

	test('catalog chooser stops when the cache-source prompt is dismissed', async () => {
		await writeCachedWorkflowCatalog({
			sessionId: 'session-1',
			orgId: 'org-1',
			fetchedAt: '2026-09-18T12:00:00.000Z',
			workflows: [],
		});
		const restorePicker = stub(
			vscode.window,
			'showQuickPick',
			(async () => undefined) as unknown as typeof vscode.window.showQuickPick,
		);
		try {
			assert.strictEqual(await chooseWorkflowCatalog('session-1', { id: 'org-1', name: 'Org One' }), undefined);
		} finally {
			restorePicker();
		}
	});

	test('catalog chooser refreshes a cached catalog from Rewst', async () => {
		await writeCachedWorkflowCatalog({
			sessionId: 'session-1',
			orgId: 'org-1',
			fetchedAt: '2026-09-18T12:00:00.000Z',
			workflows: [],
		});
		const cancellation = new vscode.CancellationTokenSource();
		const calls: { sessionId: string; orgId: string; aborted: boolean }[] = [];
		const restorePicker = stub(vscode.window, 'showQuickPick', (async (items: readonly { value: string }[]) =>
			items.find(item => item.value === 'refresh')) as unknown as typeof vscode.window.showQuickPick);
		const restoreProgress = stub(vscode.window, 'withProgress', (async (_options, task) =>
			task({ report: () => {} }, cancellation.token)) as typeof vscode.window.withProgress);
		const restoreFetch = stub(editorDataClient, 'listExportWorkflows', (async (input, options) => {
			calls.push({ ...input, aborted: options?.signal?.aborted ?? false });
			return [{ id: 'wf-fresh', name: 'Fresh', orgId: input.orgId }];
		}) as typeof editorDataClient.listExportWorkflows);
		try {
			const catalog = await chooseWorkflowCatalog('session-1', { id: 'org-1', name: 'Org One' });
			assert.deepStrictEqual(calls, [{ sessionId: 'session-1', orgId: 'org-1', aborted: false }]);
			assert.deepStrictEqual(catalog?.workflows, [{ id: 'wf-fresh', name: 'Fresh', orgId: 'org-1' }]);
		} finally {
			restoreFetch();
			restoreProgress();
			restorePicker();
			cancellation.dispose();
		}
	});

	test('catalog fetch aborts and returns no catalog when progress is cancelled', async () => {
		const cancellation = new vscode.CancellationTokenSource();
		let requestSignal: AbortSignal | undefined;
		const restoreProgress = stub(vscode.window, 'withProgress', (async (_options, task) => {
			const pending = task({ report: () => {} }, cancellation.token);
			cancellation.cancel();
			return pending;
		}) as typeof vscode.window.withProgress);
		const restoreFetch = stub(editorDataClient, 'listExportWorkflows', ((_input, options) => {
			requestSignal = options?.signal;
			return new Promise((_resolve, reject) => {
				requestSignal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
			});
		}) as typeof editorDataClient.listExportWorkflows);
		try {
			assert.strictEqual(await chooseWorkflowCatalog('session-1', { id: 'org-1', name: 'Org One' }), undefined);
			assert.strictEqual(requestSignal?.aborted, true);
			assert.strictEqual(readCachedWorkflowCatalog('session-1', 'org-1'), undefined);
		} finally {
			restoreFetch();
			restoreProgress();
			cancellation.dispose();
		}
	});

	test('catalog persistence logs rejected fire-and-forget writes', async () => {
		const warnings: unknown[][] = [];
		const restoreUpdate = stub(context.globalState, 'update', (async () => {
			throw new Error('storage unavailable');
		}) as typeof context.globalState.update);
		const restoreWarn = stub(log, 'warn', ((...args: unknown[]) => {
			warnings.push(args);
		}) as typeof log.warn);
		try {
			persistWorkflowCatalog({
				sessionId: 'session-1',
				orgId: 'org-1',
				fetchedAt: '2026-09-18T12:00:00.000Z',
				workflows: [],
			});
			await new Promise(resolve => setImmediate(resolve));
			assert.strictEqual(warnings.length, 1);
			assert.match(String(warnings[0][0]), /persist workflow export catalog cache/i);
		} finally {
			restoreWarn();
			restoreUpdate();
		}
	});

	test('destination input enforces absolute paths and an existing folder for separate files', async () => {
		assert.strictEqual(
			await validateWorkflowExportPath('relative/path', 'bundle'),
			'Enter an absolute export path.',
		);
		assert.strictEqual(
			await validateWorkflowExportPath(process.execPath, 'separate'),
			'Choose an existing export folder for separate files.',
		);
		assert.strictEqual(
			await validateWorkflowExportPath(join(tmpdir(), 'rewst-buddy-export-path-does-not-exist'), 'bundle'),
			undefined,
		);
		assert.strictEqual(
			await validateWorkflowExportPath(
				join(tmpdir(), 'rewst-buddy-bundled-batches'),
				'bundle',
				MAX_WORKFLOW_EXPORT_BATCH_SIZE + 1,
			),
			'Choose an existing export folder for bundled batch files.',
		);
	});

	test('file destination rejects an existing save-dialog path and accepts a new name', async () => {
		const existingPath = join(process.cwd(), 'package.json');
		const newPath = join(tmpdir(), `rewst-workflows-export-${Date.now()}.json`);
		const savePaths = [existingPath, newPath];
		const warnings: string[] = [];
		const restorePicker = stub(vscode.window, 'showQuickPick', (async (items: readonly { value: string }[]) =>
			items.find(item => item.value === 'file')) as unknown as typeof vscode.window.showQuickPick);
		const restoreSave = stub(vscode.window, 'showSaveDialog', (async () => {
			const path = savePaths.shift();
			return path ? vscode.Uri.file(path) : undefined;
		}) as typeof vscode.window.showSaveDialog);
		const restoreWarning = stub(vscode.window, 'showWarningMessage', (async (message: string) => {
			warnings.push(message);
			return undefined;
		}) as typeof vscode.window.showWarningMessage);
		try {
			assert.deepStrictEqual(await pickDestination('bundle', tmpdir(), 1), {
				outputPath: newPath,
				kind: 'file',
			});
			assert.deepStrictEqual(warnings, ['Choose a new file name; workflow exports never overwrite files.']);
			assert.strictEqual(savePaths.length, 0);
		} finally {
			restoreWarning();
			restoreSave();
			restorePicker();
		}
	});

	test('a second legacy command export to the same directory uses a new filename', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'rewst-buddy-workflow-export-'));
		const org = Fixtures.orgModel({ id: 'org-1', name: 'Org One' });
		const { session } = createMockSession({ profile: { org, allManagedOrgs: [org] } });
		installMockSessions([session]);
		const outputPaths: string[] = [];
		const restores = [
			stub(vscode.window, 'showQuickPick', (async (
				items: readonly ({
					value?: string;
					arguments?: boolean[];
					workflow?: ExportWorkflowChoice;
				} & vscode.QuickPickItem)[],
				options?: { canPickMany?: boolean },
			) => {
				if (options?.canPickMany) return items.filter(item => item.workflow?.id === 'wf-1');
				return items.find(item => item.arguments?.[0] || item.value === 'cached' || item.value === 'default');
			}) as unknown as typeof vscode.window.showQuickPick),
			stub(vscode.window, 'withProgress', (async (_options, task) => {
				const cancellation = new vscode.CancellationTokenSource();
				try {
					return await task({ report: () => {} }, cancellation.token);
				} finally {
					cancellation.dispose();
				}
			}) as typeof vscode.window.withProgress),
			stub(
				vscode.window,
				'showInformationMessage',
				(async () => undefined) as typeof vscode.window.showInformationMessage,
			),
			stub(editorDataClient, 'listExportWorkflows', (async () => [
				{ id: 'wf-1', name: 'One', orgId: org.id },
			]) as typeof editorDataClient.listExportWorkflows),
			stub(
				editorDataClient,
				'getWorkflowExportDefaultDirectory',
				(async () => directory) as typeof editorDataClient.getWorkflowExportDefaultDirectory,
			),
			stub(editorDataClient, 'exportWorkflows', (async input => {
				assert.deepStrictEqual(input.workflowIds, ['wf-1']);
				assert.strictEqual(input.orgId, org.id);
				assert.ok(input.outputPath);
				await writeFile(input.outputPath, String(outputPaths.length + 1), { flag: 'wx' });
				outputPaths.push(input.outputPath);
				return result(input.workflowIds, input.outputPath);
			}) as typeof editorDataClient.exportWorkflows),
		];
		try {
			await new ExportWorkflows().execute();
			await new ExportWorkflows().execute();
			assert.deepStrictEqual(outputPaths, [
				join(directory, 'rewst-workflows-batch-001-of-001.json'),
				join(directory, 'rewst-workflows-batch-001-of-001-2.json'),
			]);
			assert.strictEqual(await readFile(outputPaths[0], 'utf8'), '1');
			assert.strictEqual(await readFile(outputPaths[1], 'utf8'), '2');
		} finally {
			while (restores.length) restores.pop()!();
			SessionManager._resetForTesting();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('filename mode preserves readable workflow names while remaining portable and collision-safe', () => {
		assert.strictEqual(sanitizeWorkflowFilenamePart('  Daily / User: Sync  '), 'Daily - User- Sync');
		assert.strictEqual(sanitizeWorkflowFilenamePart('Daily\u0000Sync\u001f\u007f'), 'DailySync');
		assert.strictEqual(
			separateWorkflowExportFilename(workflow('wf-123', 'Daily / User: Sync'), true),
			'Daily - User- Sync--wf-123.json',
		);
		assert.strictEqual(
			workflowExportOutputPath(
				{ kind: 'directory', outputPath: '/exports' },
				'/default',
				'separate',
				[workflow('wf-123', 'Daily / User: Sync')],
				0,
				1,
				true,
			),
			'/exports/Daily - User- Sync--wf-123.json',
		);
	});

	test('bundle mode sends all selected ids in one backend operation', async () => {
		const calls: string[][] = [];
		const workflows = [workflow('wf-1'), workflow('wf-2')];
		const outcome = await runWorkflowExports(
			workflows,
			'bundle',
			async ids => {
				calls.push(ids);
				return result(ids);
			},
			new AbortController().signal,
		);

		assert.deepStrictEqual(calls, [['wf-1', 'wf-2']]);
		assert.deepStrictEqual(outcome.results[0].workflowIds, ['wf-1', 'wf-2']);
		assert.deepStrictEqual(outcome.failures, []);
		assert.strictEqual(outcome.cancelled, false);
	});

	test('separate mode continues after a failure and returns a useful partial summary shape', async () => {
		const calls: string[][] = [];
		const outcome = await runWorkflowExports(
			[workflow('wf-1', 'One'), workflow('wf-2', 'Two'), workflow('wf-3', 'Three')],
			'separate',
			async ids => {
				calls.push(ids);
				if (ids[0] === 'wf-2') throw new Error('file already exists');
				return result(ids);
			},
			new AbortController().signal,
		);

		assert.deepStrictEqual(calls, [['wf-1'], ['wf-2'], ['wf-3']]);
		assert.strictEqual(outcome.results.length, 2);
		assert.deepStrictEqual(outcome.failures, [
			{ workflow: workflow('wf-2', 'Two'), message: 'file already exists' },
		]);
		assert.strictEqual(outcome.cancelled, false);
	});

	test('cancellation stops separate exports before starting another workflow', async () => {
		const controller = new AbortController();
		const calls: string[][] = [];
		const outcome = await runWorkflowExports(
			[workflow('wf-1'), workflow('wf-2')],
			'separate',
			async ids => {
				calls.push(ids);
				controller.abort();
				return result(ids);
			},
			controller.signal,
		);

		assert.deepStrictEqual(calls, [['wf-1']]);
		assert.strictEqual(outcome.results.length, 1);
		assert.strictEqual(outcome.cancelled, true);
	});

	test('bundle cancellation before start does not call the backend', async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const outcome = await runWorkflowExports(
			[workflow('wf-1'), workflow('wf-2')],
			'bundle',
			async ids => {
				called = true;
				return result(ids);
			},
			controller.signal,
		);

		assert.strictEqual(called, false);
		assert.deepStrictEqual(outcome, { results: [], failures: [], cancelled: true });
	});

	test('bundle cancellation during an aborted backend call returns saved results safely', async () => {
		const controller = new AbortController();
		const outcomePromise = runWorkflowExports(
			[workflow('wf-1')],
			'bundle',
			async ids => {
				controller.abort();
				throw new Error('aborted by caller');
			},
			controller.signal,
		);

		await assert.deepStrictEqual(await outcomePromise, { results: [], failures: [], cancelled: true });
	});

	test('bundle mode batches every selected workflow without rejecting large selections', async () => {
		const calls: string[][] = [];
		const workflows = Array.from({ length: MAX_WORKFLOW_EXPORT_BATCH_SIZE + 2 }, (_, index) =>
			workflow(`wf-${index}`),
		);
		const outcome = await runWorkflowExports(
			workflows,
			'bundle',
			async ids => {
				calls.push(ids);
				return result(ids);
			},
			new AbortController().signal,
		);

		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0].length, MAX_WORKFLOW_EXPORT_BATCH_SIZE);
		assert.strictEqual(calls[1].length, 2);
		assert.strictEqual(outcome.results.length, 2);
		assert.deepStrictEqual(
			outcome.results.flatMap(exportResult => exportResult.workflowIds),
			workflows.map(selected => selected.id),
		);
		assert.deepStrictEqual(outcome.failures, []);
		assert.strictEqual(outcome.cancelled, false);
	});

	test('bundle mode continues after a failed batch and identifies the affected workflow ids', async () => {
		const workflows = Array.from({ length: MAX_WORKFLOW_EXPORT_BATCH_SIZE + 1 }, (_, index) =>
			workflow(`wf-${index}`),
		);
		const outcome = await runWorkflowExports(
			workflows,
			'bundle',
			async ids => {
				if (ids.length === MAX_WORKFLOW_EXPORT_BATCH_SIZE) throw new Error('request failed');
				return result(ids);
			},
			new AbortController().signal,
		);

		assert.strictEqual(outcome.results.length, 1);
		assert.deepStrictEqual(outcome.failures, [
			{
				workflowIds: workflows.slice(0, MAX_WORKFLOW_EXPORT_BATCH_SIZE).map(selected => selected.id),
				message: 'request failed',
			},
		]);
	});
});
