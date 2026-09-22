import type { WorkflowExportResult } from '../../../packages/mcp-server/src/capabilities/workflowExportCapability';
import { join } from 'node:path';
import * as assert from 'assert';
import * as Mocha from 'mocha';
import {
	MAX_EXPORT_FILENAME_SUFFIX,
	MAX_WORKFLOW_EXPORT_BATCH_SIZE,
	exportOutputPath,
	resolveExportOutputPath,
	runCatalogExports,
	runWorkflowExports,
	resolveWorkflowExportOutputPath,
	separateExportFilename,
	sanitizeWorkflowFilenamePart,
	separateWorkflowExportFilename,
	workflowExportOutputPath,
	type ExportWorkflowChoice,
} from './workflowExportEngine';

const { suite, test } = Mocha;

function workflow(id: string, name = id): ExportWorkflowChoice {
	return { id, name, orgId: 'org-1', orgName: 'Org One' };
}

function result(workflowIds: string[], outputPath: string | null = null): WorkflowExportResult {
	return {
		status: 'saved',
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

suite('Unit: workflow export engine', () => {
	test('keeps 25 workflows in one bundle and starts a second batch at 26', async () => {
		for (const expected of [
			{ count: MAX_WORKFLOW_EXPORT_BATCH_SIZE, sizes: [25] },
			{ count: MAX_WORKFLOW_EXPORT_BATCH_SIZE + 1, sizes: [25, 1] },
		]) {
			const calls: { ids: string[]; batchIndex: number; batchCount: number }[] = [];
			const selected = Array.from({ length: expected.count }, (_, index) => workflow(`wf-${index + 1}`));

			const outcome = await runWorkflowExports(
				selected,
				'bundle',
				async (ids, batchIndex, batchCount) => {
					calls.push({ ids, batchIndex, batchCount });
					return result(ids);
				},
				new AbortController().signal,
			);

			assert.deepStrictEqual(
				calls.map(call => call.ids.length),
				expected.sizes,
			);
			assert.deepStrictEqual(
				calls.map(call => call.batchIndex),
				expected.sizes.map((_, index) => index),
			);
			assert.deepStrictEqual(
				calls.map(call => call.batchCount),
				expected.sizes.map(() => expected.sizes.length),
			);
			assert.strictEqual(outcome.cancelled, false);
			assert.deepStrictEqual(outcome.failures, []);
		}
	});

	test('shares typed batching, progress, and failure semantics with template and form exports', async () => {
		for (const objectType of ['template', 'form'] as const) {
			const selected = Array.from({ length: 3 }, (_, index) => ({
				...workflow(`${objectType}-${index + 1}`, `${objectType} ${index + 1}`),
			}));
			const calls: string[][] = [];
			const progress: string[] = [];
			const outcome = await runCatalogExports(
				selected,
				objectType,
				'bundle',
				async ids => {
					calls.push(ids);
					if (ids.includes(`${objectType}-3`)) throw new Error(`${objectType} batch failed`);
					return { outputPath: `/exports/${objectType}.json` };
				},
				new AbortController().signal,
				message => progress.push(message),
				2,
			);

			assert.deepStrictEqual(calls, [[`${objectType}-1`, `${objectType}-2`], [`${objectType}-3`]]);
			assert.match(progress[0], new RegExp(`Bundling batch 1/2 2 ${objectType}s`));
			assert.match(progress[2], new RegExp(`Bundling batch 2/2 1 ${objectType}`));
			assert.deepStrictEqual(
				outcome.results.map(item => item.objectIds),
				[[`${objectType}-1`, `${objectType}-2`]],
			);
			assert.deepStrictEqual(outcome.failures, [
				{ objectIds: [`${objectType}-3`], message: `${objectType} batch failed` },
			]);
		}
	});

	test('reports exact progress increments for a 26-workflow bundle export', async () => {
		const progress: { message: string; increment?: number }[] = [];
		const selected = Array.from({ length: 26 }, (_, index) => workflow(`wf-${index + 1}`));

		await runWorkflowExports(
			selected,
			'bundle',
			async ids => result(ids),
			new AbortController().signal,
			(message, increment) => progress.push({ message, increment }),
		);

		assert.deepStrictEqual(progress, [
			{ message: 'Bundling batch 1/2 25 workflows…', increment: undefined },
			{ message: '25 of 26 complete', increment: 2500 / 26 },
			{ message: 'Bundling batch 2/2 1 workflow…', increment: undefined },
			{ message: '26 of 26 complete', increment: 100 / 26 },
		]);
		assert.strictEqual(
			progress.reduce((total, update) => total + (update.increment ?? 0), 0),
			100,
		);
	});

	test('stops before work when cancelled and preserves completed results when cancelled later', async () => {
		const preCancelled = new AbortController();
		preCancelled.abort();
		let preCancelledCalls = 0;
		assert.deepStrictEqual(
			await runWorkflowExports(
				[workflow('wf-1')],
				'separate',
				async ids => {
					preCancelledCalls++;
					return result(ids);
				},
				preCancelled.signal,
			),
			{ results: [], failures: [], cancelled: true },
		);
		assert.strictEqual(preCancelledCalls, 0);

		const midExport = new AbortController();
		const calls: string[][] = [];
		const outcome = await runWorkflowExports(
			[workflow('wf-1'), workflow('wf-2')],
			'separate',
			async ids => {
				calls.push(ids);
				midExport.abort();
				return result(ids);
			},
			midExport.signal,
		);

		assert.deepStrictEqual(calls, [['wf-1']]);
		assert.deepStrictEqual(
			outcome.results.map(exported => exported.workflowIds),
			[['wf-1']],
		);
		assert.strictEqual(outcome.cancelled, true);
	});

	test('records exporter failures and continues with remaining separate exports', async () => {
		const outcome = await runWorkflowExports(
			[workflow('wf-1', 'One'), workflow('wf-2', 'Two'), workflow('wf-3', 'Three')],
			'separate',
			async ids => {
				if (ids[0] === 'wf-2') throw new Error('backend unavailable');
				return result(ids);
			},
			new AbortController().signal,
		);

		assert.deepStrictEqual(
			outcome.results.map(exported => exported.workflowIds),
			[['wf-1'], ['wf-3']],
		);
		assert.deepStrictEqual(outcome.failures, [
			{ workflow: workflow('wf-2', 'Two'), message: 'backend unavailable' },
		]);
		assert.strictEqual(outcome.cancelled, false);
	});

	test('identifies every workflow in a failed bundle and continues with the next batch', async () => {
		const selected = Array.from({ length: 26 }, (_, index) => workflow(`wf-${index + 1}`));
		const outcome = await runWorkflowExports(
			selected,
			'bundle',
			async (ids, batchIndex) => {
				if (batchIndex === 0) throw 'request rejected';
				return result(ids);
			},
			new AbortController().signal,
		);

		assert.deepStrictEqual(
			outcome.results.map(exported => exported.workflowIds),
			[['wf-26']],
		);
		assert.deepStrictEqual(outcome.failures, [
			{ workflowIds: selected.slice(0, 25).map(item => item.id), message: 'request rejected' },
		]);
	});

	test('makes reserved and control-character filenames portable', () => {
		assert.strictEqual(sanitizeWorkflowFilenamePart('CON'), '_CON');
		assert.strictEqual(sanitizeWorkflowFilenamePart('lpt9.report'), '_lpt9.report');
		assert.strictEqual(sanitizeWorkflowFilenamePart('Daily\u0000\u001f\u007f / Sync'), 'Daily - Sync');
		assert.strictEqual(separateWorkflowExportFilename(workflow('NUL', 'PRN'), true), '_PRN--_NUL.json');
	});

	test('keeps colliding sanitized workflow names unique by workflow id', () => {
		const first = separateWorkflowExportFilename(workflow('wf-1', 'Daily/Sync'), true);
		const second = separateWorkflowExportFilename(workflow('wf-2', 'Daily\\Sync'), true);

		assert.strictEqual(first, 'Daily-Sync--wf-1.json');
		assert.strictEqual(second, 'Daily-Sync--wf-2.json');
		assert.notStrictEqual(first, second);
	});

	test('derives collision-safe template and form filenames and bundle destinations', async () => {
		for (const objectType of ['template', 'form'] as const) {
			const object = workflow(`${objectType}-1`, 'Daily/Sync');
			assert.strictEqual(separateExportFilename(object, objectType, true), `Daily-Sync--${objectType}-1.json`);
			const first = exportOutputPath(
				{ kind: 'directory', outputPath: '/exports' },
				'/default',
				objectType,
				'bundle',
				[object],
				0,
				2,
			);
			assert.strictEqual(first, join('/exports', `rewst-${objectType}s-batch-001-of-002.json`));
			assert.strictEqual(
				await resolveExportOutputPath(
					{ kind: 'directory', outputPath: '/exports' },
					'/default',
					objectType,
					'bundle',
					[object],
					0,
					2,
					false,
					async path => path === first,
				),
				join('/exports', `rewst-${objectType}s-batch-001-of-002-2.json`),
			);
		}
	});

	test('uses file destinations verbatim and derives directory output paths', () => {
		assert.strictEqual(
			workflowExportOutputPath(
				{ kind: 'file', outputPath: '/chosen/export.json' },
				'/default',
				'bundle',
				[workflow('wf-1')],
				0,
				1,
			),
			'/chosen/export.json',
		);
		assert.strictEqual(
			workflowExportOutputPath(
				{ kind: 'directory', outputPath: '/chosen' },
				'/default',
				'bundle',
				[workflow('wf-1')],
				1,
				3,
			),
			join('/chosen', 'rewst-workflows-batch-002-of-003.json'),
		);
		assert.strictEqual(
			workflowExportOutputPath(
				{ kind: 'directory' },
				'/default',
				'separate',
				[workflow('wf-1', 'Daily Sync')],
				0,
				1,
				true,
			),
			join('/default', 'Daily Sync--wf-1.json'),
		);
	});

	test('preserves free directory filenames and adds deterministic suffixes for existing exports', async () => {
		const existing = new Set<string>();
		const exists = async (path: string): Promise<boolean> => existing.has(path);
		const bundleArgs = [
			{ kind: 'directory' as const, outputPath: '/exports' },
			'/default',
			'bundle' as const,
			[workflow('wf-1')],
			0,
			1,
		] as const;

		assert.strictEqual(
			await resolveWorkflowExportOutputPath(...bundleArgs, false, exists),
			join('/exports', 'rewst-workflows-batch-001-of-001.json'),
		);
		existing.add(join('/exports', 'rewst-workflows-batch-001-of-001.json'));
		assert.strictEqual(
			await resolveWorkflowExportOutputPath(...bundleArgs, false, exists),
			join('/exports', 'rewst-workflows-batch-001-of-001-2.json'),
		);
		existing.add(join('/exports', 'rewst-workflows-batch-001-of-001-2.json'));
		assert.strictEqual(
			await resolveWorkflowExportOutputPath(...bundleArgs, false, exists),
			join('/exports', 'rewst-workflows-batch-001-of-001-3.json'),
		);

		existing.add(join('/exports', 'Daily Sync--wf-1.json'));
		assert.strictEqual(
			await resolveWorkflowExportOutputPath(
				{ kind: 'directory', outputPath: '/exports' },
				'/default',
				'separate',
				[workflow('wf-1', 'Daily Sync')],
				0,
				1,
				true,
				exists,
			),
			join('/exports', 'Daily Sync--wf-1-2.json'),
		);
	});

	test('stops searching after the maximum export filename suffix', async () => {
		const checked: string[] = [];
		const base = join('/exports', 'rewst-workflows-batch-001-of-001.json');
		const exists = async (candidate: string) => {
			checked.push(candidate);
			return true;
		};
		await assert.rejects(
			resolveWorkflowExportOutputPath(
				{ kind: 'directory', outputPath: '/exports' },
				'/default',
				'bundle',
				[workflow('wf-1')],
				0,
				1,
				false,
				exists,
			),
			error =>
				error instanceof Error &&
				error.message.includes(base) &&
				error.message.includes(String(MAX_EXPORT_FILENAME_SUFFIX)),
		);
		assert.strictEqual(checked.length, MAX_EXPORT_FILENAME_SUFFIX);
		assert.strictEqual(
			checked.at(-1),
			join('/exports', `rewst-workflows-batch-001-of-001-${MAX_EXPORT_FILENAME_SUFFIX}.json`),
		);
	});

	test('does not rewrite an explicitly chosen file destination', async () => {
		assert.strictEqual(
			await resolveWorkflowExportOutputPath(
				{ kind: 'file', outputPath: '/chosen/export.json' },
				'/default',
				'bundle',
				[workflow('wf-1')],
				0,
				1,
				false,
				async () => true,
			),
			'/chosen/export.json',
		);
	});
});
