import { expect, vi } from 'vitest';
import { setup as beforeEach, suite as describe, test as it } from '../test/tdd';
import { editorDataClient, type EditorDataInvokeOptions } from './editorDataClient';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./operations', () => ({ invoke: mocks.invoke }));

describe('editorDataClient export operations', () => {
	beforeEach(() => mocks.invoke.mockReset());

	it('delegates form listing with the exact input and options', async () => {
		const input = { sessionId: 'session-1', orgId: 'org-1' };
		const options: EditorDataInvokeOptions = {
			onEvent: vi.fn(),
			signal: new AbortController().signal,
		};
		const result = [{ id: 'form-1', name: 'Employee onboarding', updatedAt: '2026-09-20T12:00:00Z' }];
		mocks.invoke.mockResolvedValueOnce(result);

		await expect(editorDataClient.listExportForms(input, options)).resolves.toBe(result);

		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('exports.forms.list', input, options);
		expect(mocks.invoke.mock.calls[0]?.[1]).toBe(input);
		expect(mocks.invoke.mock.calls[0]?.[2]).toBe(options);
	});

	it('delegates template listing and shared object export with exact typed inputs', async () => {
		const signal = new AbortController().signal;
		const options = { signal };
		const listInput = { sessionId: 'session-1', orgId: 'org-1' };
		const exportInput = {
			sessionId: 'session-1',
			orgId: 'org-1',
			objectType: 'template' as const,
			objectIds: ['template-1'],
			outputPath: '/exports/template.json',
		};
		const rows = [{ id: 'template-1', name: 'Welcome', tags: [{ id: 'customer', name: 'Customer' }] }];
		const exported = {
			status: 'saved' as const,
			orgId: 'org-1',
			objectType: 'template' as const,
			objectIds: ['template-1'],
			outputPath: '/exports/template.json',
		};
		mocks.invoke.mockResolvedValueOnce(rows).mockResolvedValueOnce(exported);

		await expect(editorDataClient.listExportTemplates(listInput, options)).resolves.toBe(rows);
		await expect(editorDataClient.exportObjects(exportInput, options)).resolves.toBe(exported);

		expect(mocks.invoke.mock.calls).toEqual([
			['exports.templates.list', listInput, options],
			['exports.objects.run', exportInput, options],
		]);
	});

	it('delegates export execution with the exact input and options', async () => {
		const input = {
			sessionId: 'session-1',
			orgId: 'org-1',
			name: 'buddy_export_templates' as const,
			arguments: { templateIds: ['template-1'], includeBundle: true },
		};
		const options: EditorDataInvokeOptions = {
			onEvent: vi.fn(),
			signal: new AbortController().signal,
		};
		const result = '{"status":"saved"}';
		mocks.invoke.mockResolvedValueOnce(result);

		await expect(editorDataClient.runExportCapability(input, options)).resolves.toBe(result);

		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('exports.run', input, options);
		expect(mocks.invoke.mock.calls[0]?.[1]).toBe(input);
		expect(mocks.invoke.mock.calls[0]?.[2]).toBe(options);
	});

	it('forwards workflow catalog, destination, and export operations unchanged', async () => {
		const signal = new AbortController().signal;
		const options = { signal };
		const catalog = [{ id: 'workflow-1', name: 'Daily Sync', orgId: 'org-1' }];
		const exportResult = {
			status: 'saved',
			orgId: 'org-1',
			workflowIds: ['workflow-1'],
			recommendedFilename: 'workflow-export.json',
			outputPath: '/exports/workflow-export.json',
			bytes: 128,
			version: 2,
			exportedAt: '2026-09-18T12:00:00.000Z',
			objectCount: 1,
			signingPresent: true,
		};
		mocks.invoke
			.mockResolvedValueOnce(catalog)
			.mockResolvedValueOnce('/exports')
			.mockResolvedValueOnce(exportResult);

		await expect(
			editorDataClient.listExportWorkflows({ sessionId: 'session-1', orgId: 'org-1' }, options),
		).resolves.toBe(catalog);
		await expect(editorDataClient.getWorkflowExportDefaultDirectory(options)).resolves.toBe('/exports');
		await expect(
			editorDataClient.exportWorkflows(
				{
					sessionId: 'session-1',
					orgId: 'org-1',
					workflowIds: ['workflow-1'],
					outputPath: '/exports/workflow-export.json',
				},
				options,
			),
		).resolves.toBe(exportResult);

		expect(mocks.invoke.mock.calls).toEqual([
			['workflows.export.catalog', { sessionId: 'session-1', orgId: 'org-1' }, options],
			['workflows.export.defaultDirectory', {}, options],
			[
				'workflows.export.run',
				{
					sessionId: 'session-1',
					orgId: 'org-1',
					workflowIds: ['workflow-1'],
					outputPath: '/exports/workflow-export.json',
				},
				options,
			],
		]);
	});
});
