import { SessionManager } from '@sessions';
import { createMockSession, Fixtures, initTestEnvironment, stub, type Restore } from '@test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as assert from 'assert';
import * as Mocha from 'mocha';
import vscode from 'vscode';
import { ExportForms } from './ExportForms';
import {
	defaultExportCommandDependencies,
	exportQuickPickItems,
	updatedDateDetail,
	type ExportCommandDependencies,
} from './ExportObjectCommand';
import { ExportTemplates } from './ExportTemplates';

const { suite, test, setup, teardown } = Mocha;

interface PickerItem extends vscode.QuickPickItem {
	id?: string;
	destinationType?: 'default' | 'folder';
}

suite('Unit: template and form export commands', () => {
	const restores: Restore[] = [];
	let informationMessages: string[];
	let warningMessages: string[];
	let errorMessages: string[];

	setup(() => {
		initTestEnvironment();
		SessionManager._resetForTesting();
		informationMessages = [];
		warningMessages = [];
		errorMessages = [];
		restores.push(
			stub(vscode.window, 'showInformationMessage', (async (message: string) => {
				informationMessages.push(message);
				return undefined;
			}) as typeof vscode.window.showInformationMessage),
			stub(vscode.window, 'showWarningMessage', (async (message: string) => {
				warningMessages.push(message);
				return undefined;
			}) as typeof vscode.window.showWarningMessage),
			stub(vscode.window, 'showErrorMessage', (async (message: string) => {
				errorMessages.push(message);
				return undefined;
			}) as typeof vscode.window.showErrorMessage),
		);
	});

	teardown(() => {
		while (restores.length) restores.pop()!();
		SessionManager._resetForTesting();
	});

	function context() {
		const org = Fixtures.orgModel({ id: 'org-export', name: 'Export Org' });
		const { session, wrapper } = createMockSession({ profile: { org, allManagedOrgs: [org] } });
		const calls: Parameters<ExportCommandDependencies['runCapability']>[0][] = [];
		const dependencies: ExportCommandDependencies = {
			...defaultExportCommandDependencies,
			pickOrganization: async () => ({ session, org }),
			listForms: async () => [],
			runCapability: async input => {
				calls.push(input);
				return JSON.stringify({ status: 'saved', outputPath: '/exports/rewst-export.json' });
			},
		};
		return { org, session, wrapper, calls, dependencies };
	}

	function selectItemsThenDestination(ids: string[], destination: 'default' | 'folder' | 'cancel'): void {
		restores.push(
			stub(vscode.window, 'showQuickPick', (async (
				items: readonly PickerItem[],
				options?: { canPickMany?: boolean },
			) => {
				if (options?.canPickMany) return items.filter(item => item.id && ids.includes(item.id));
				if (destination === 'cancel') return undefined;
				return items.find(item => item.destinationType === destination);
			}) as unknown as typeof vscode.window.showQuickPick),
		);
	}

	function stubProgress(
		cancelOnCall?: number,
		reports?: { message?: string; increment?: number }[],
	): vscode.ProgressOptions[] {
		const optionsSeen: vscode.ProgressOptions[] = [];
		let callCount = 0;
		const replacement = async <T>(
			options: vscode.ProgressOptions,
			task: (
				progress: vscode.Progress<{ message?: string; increment?: number }>,
				token: vscode.CancellationToken,
			) => Thenable<T>,
		): Promise<T> => {
			optionsSeen.push(options);
			callCount++;
			const cancellation = new vscode.EventEmitter<void>();
			let isCancellationRequested = false;
			const token: vscode.CancellationToken = {
				get isCancellationRequested() {
					return isCancellationRequested;
				},
				onCancellationRequested: cancellation.event,
			};
			try {
				const result = task({ report: value => reports?.push(value) }, token);
				if (callCount === cancelOnCall) {
					isCancellationRequested = true;
					cancellation.fire();
				}
				return await result;
			} finally {
				cancellation.dispose();
			}
		};
		restores.push(stub(vscode.window, 'withProgress', replacement as unknown as typeof vscode.window.withProgress));
		return optionsSeen;
	}

	test('builds searchable picker items with human names, ids, and details', () => {
		assert.deepStrictEqual(
			exportQuickPickItems([{ id: 'tpl-1', name: 'Welcome email', detail: 'Customer greeting' }]),
			[{ id: 'tpl-1', label: 'Welcome email', description: 'tpl-1', detail: 'Customer greeting' }],
		);
	});

	test('formats update dates for standalone picker details and preserves missing values', () => {
		const timestamp = '2026-09-20T10:00:00Z';
		assert.strictEqual(updatedDateDetail(timestamp), `Updated ${new Date(timestamp).toLocaleDateString()}`);
		assert.strictEqual(updatedDateDetail(undefined), undefined);
		assert.strictEqual(updatedDateDetail('unknown'), 'Updated unknown');
	});

	test('shows localized update dates in template and form pickers', async () => {
		const { org, wrapper, dependencies } = context();
		const timestamp = '2026-09-20T10:00:00Z';
		wrapper.when('listTemplates', {
			data: Fixtures.listTemplatesQuery([
				Fixtures.template({
					id: 'tpl-1',
					name: 'Welcome',
					description: '',
					updatedAt: timestamp,
					orgId: org.id,
				}),
			]),
		});
		dependencies.listForms = async () => [{ id: 'form-1', name: 'Intake', updatedAt: timestamp }];
		const details: string[] = [];
		restores.push(
			stub(vscode.window, 'showQuickPick', (async (
				items: readonly PickerItem[],
				options?: { canPickMany?: boolean },
			) => {
				if (options?.canPickMany) details.push(items[0]?.detail ?? '');
				return undefined;
			}) as unknown as typeof vscode.window.showQuickPick),
		);

		await new ExportTemplates(dependencies).execute();
		await new ExportForms(dependencies).execute();

		assert.deepStrictEqual(details, [
			`Updated ${new Date(timestamp).toLocaleDateString()}`,
			`Updated ${new Date(timestamp).toLocaleDateString()}`,
		]);
	});

	test('keeps template descriptions alongside localized update dates and as the missing-date fallback', async () => {
		const { org, wrapper, dependencies } = context();
		const timestamp = '2026-09-20T10:00:00Z';
		wrapper.when('listTemplates', {
			data: Fixtures.listTemplatesQuery([
				Fixtures.template({ id: 'tpl-1', description: 'Greeting', updatedAt: timestamp, orgId: org.id }),
				Fixtures.template({ id: 'tpl-2', description: 'Reminder', updatedAt: undefined, orgId: org.id }),
			]),
		});
		const details: (string | undefined)[] = [];
		restores.push(
			stub(vscode.window, 'showQuickPick', (async (
				items: readonly PickerItem[],
				options?: { canPickMany?: boolean },
			) => {
				if (options?.canPickMany) details.push(...items.map(item => item.detail));
				return undefined;
			}) as unknown as typeof vscode.window.showQuickPick),
		);
		await new ExportTemplates(dependencies).execute();
		assert.deepStrictEqual(details, [`Greeting • Updated ${new Date(timestamp).toLocaleDateString()}`, 'Reminder']);
	});

	test('reports a missing template SDK as an error', async () => {
		const { session, calls, dependencies } = context();
		session.sdk = undefined;
		await new ExportTemplates(dependencies).execute();
		assert.deepStrictEqual(calls, []);
		assert.deepStrictEqual(warningMessages, []);
		assert.match(errorMessages[0], /selected Rewst session has no SDK for loading templates/i);
	});

	test('loads templates through listTemplates and exports all selected ids to a chosen folder', async () => {
		const { org, session, wrapper, calls, dependencies } = context();
		wrapper.when('listTemplates', {
			data: Fixtures.listTemplatesQuery([
				Fixtures.template({ id: 'tpl-1', name: 'First template', orgId: org.id }),
				Fixtures.template({ id: 'tpl-2', name: 'Second template', orgId: org.id }),
			]),
		});
		selectItemsThenDestination(['tpl-1', 'tpl-2'], 'folder');
		restores.push(
			stub(vscode.window, 'showOpenDialog', (async () => [
				vscode.Uri.file('/exports/chosen'),
			]) as typeof vscode.window.showOpenDialog),
		);

		await new ExportTemplates(dependencies).execute();

		assert.strictEqual(wrapper.getCallsFor('listTemplates').length, 1);
		assert.deepStrictEqual(wrapper.getCallsFor('listTemplates')[0].variables, { orgId: org.id });
		assert.deepStrictEqual(calls, [
			{
				sessionId: session.profile.user.id!,
				orgId: org.id,
				name: 'buddy_export_templates',
				arguments: {
					orgId: org.id,
					templateIds: ['tpl-1', 'tpl-2'],
					includeBundle: false,
					outputPath: '/exports/chosen',
				},
			},
		]);
		assert.match(informationMessages[0], /Exported 2 templates.*rewst-export\.json/);
	});

	test('batches 26 selected templates into backend-safe files', async () => {
		const { org, wrapper, calls, dependencies } = context();
		const templates = Array.from({ length: 26 }, (_, index) =>
			Fixtures.template({ id: `tpl-${index + 1}`, name: `Template ${index + 1}`, orgId: org.id }),
		);
		wrapper.when('listTemplates', { data: Fixtures.listTemplatesQuery(templates) });
		selectItemsThenDestination(
			templates.map(template => template.id),
			'folder',
		);
		restores.push(
			stub(vscode.window, 'showOpenDialog', (async () => [
				vscode.Uri.file('/exports/chosen'),
			]) as typeof vscode.window.showOpenDialog),
		);

		await new ExportTemplates(dependencies).execute();

		assert.deepStrictEqual(
			calls.map(call => call.arguments.templateIds),
			[templates.slice(0, 25).map(template => template.id), [templates[25].id]],
		);
		assert.deepStrictEqual(
			calls.map(call => call.arguments.outputPath),
			[
				'/exports/chosen/rewst-templates-batch-001-of-002.json',
				'/exports/chosen/rewst-templates-batch-002-of-002.json',
			],
		);
		assert.ok(calls.every(call => (call.arguments.templateIds as string[]).length <= 25));
		assert.match(informationMessages[0], /Exported 26 templates across 2 signed bundle files/);
	});

	for (const destination of ['default', 'folder'] as const) {
		test(`allocates distinct multi-batch template paths in the ${destination} directory when filenames are occupied`, async () => {
			const directory = await mkdtemp(join(tmpdir(), `rewst-command-${destination}-`));
			try {
				await writeFile(join(directory, 'rewst-templates-batch-001-of-002.json'), 'occupied');
				await writeFile(join(directory, 'rewst-templates-batch-001-of-002-2.json'), 'occupied');
				await writeFile(join(directory, 'rewst-templates-batch-002-of-002.json'), 'occupied');
				const { org, wrapper, calls, dependencies } = context();
				const templates = Array.from({ length: 26 }, (_, index) =>
					Fixtures.template({ id: `tpl-${index + 1}`, name: `Template ${index + 1}`, orgId: org.id }),
				);
				wrapper.when('listTemplates', { data: Fixtures.listTemplatesQuery(templates) });
				dependencies.getDefaultDirectory = async () => directory;
				selectItemsThenDestination(
					templates.map(template => template.id),
					destination,
				);
				if (destination === 'folder') {
					restores.push(
						stub(vscode.window, 'showOpenDialog', (async () => [
							vscode.Uri.file(directory),
						]) as typeof vscode.window.showOpenDialog),
					);
				}

				await new ExportTemplates(dependencies).execute();

				assert.deepStrictEqual(
					calls.map(call => (call.arguments.templateIds as string[]).length),
					[25, 1],
				);
				assert.deepStrictEqual(
					calls.map(call => call.arguments.outputPath),
					[
						join(directory, 'rewst-templates-batch-001-of-002-3.json'),
						join(directory, 'rewst-templates-batch-002-of-002-2.json'),
					],
				);
				assert.strictEqual(new Set(calls.map(call => call.arguments.outputPath)).size, 2);
				assert.deepStrictEqual(errorMessages, []);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	}

	test('reports shared batch progress and keeps completed exports when a later template batch fails', async () => {
		const { org, wrapper, calls, dependencies } = context();
		const templates = Array.from({ length: 26 }, (_, index) =>
			Fixtures.template({ id: `tpl-${index + 1}`, name: `Template ${index + 1}`, orgId: org.id }),
		);
		wrapper.when('listTemplates', { data: Fixtures.listTemplatesQuery(templates) });
		selectItemsThenDestination(
			templates.map(template => template.id),
			'default',
		);
		dependencies.getDefaultDirectory = async () => '/exports/default';
		dependencies.runCapability = async input => {
			calls.push(input);
			if ((input.arguments.templateIds as string[]).includes('tpl-26')) throw new Error('second batch failed');
			return JSON.stringify({ status: 'saved', outputPath: '/exports/default/first.json' });
		};
		const reports: { message?: string; increment?: number }[] = [];
		stubProgress(undefined, reports);

		await new ExportTemplates(dependencies).execute();

		assert.deepStrictEqual(
			calls.map(call => (call.arguments.templateIds as string[]).length),
			[25, 1],
		);
		assert.deepStrictEqual(reports, [
			{ message: 'Bundling batch 1/2 25 templates…', increment: undefined },
			{ message: '25 of 26 complete', increment: 2500 / 26 },
			{ message: 'Bundling batch 2/2 1 template…', increment: undefined },
			{ message: '26 of 26 complete', increment: 100 / 26 },
		]);
		assert.deepStrictEqual(informationMessages, []);
		assert.deepStrictEqual(errorMessages, []);
		assert.match(warningMessages[0], /Exported 25 of 26 templates\. 1 batch failed/);
		assert.match(warningMessages[0], /tpl-26.*second batch failed/);
	});

	test('makes template loading cancellable and passes its signal to listTemplates', async () => {
		const { session, dependencies } = context();
		let receivedSignal: AbortSignal | null | undefined;
		session.sdk = {
			listTemplates: async (_variables: { orgId: string }, _headers?: unknown, signal?: AbortSignal | null) => {
				receivedSignal = signal;
				return { templates: [] };
			},
		} as unknown as NonNullable<typeof session.sdk>;
		const progressOptions = stubProgress();

		await new ExportTemplates(dependencies).execute();

		assert.strictEqual(progressOptions[0]?.cancellable, true);
		assert.ok(receivedSignal instanceof AbortSignal);
		assert.deepStrictEqual(errorMessages, []);
	});

	test('aborts form loading and returns quietly when loading progress is cancelled', async () => {
		const { dependencies } = context();
		let receivedSignal: AbortSignal | undefined;
		dependencies.listForms = async (_session, _orgId, signal?: AbortSignal) => {
			receivedSignal = signal;
			if (!signal) throw new Error('Form loading did not receive a cancellation signal.');
			return new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('Form loading aborted.')), { once: true });
			});
		};
		const progressOptions = stubProgress(1);

		await new ExportForms(dependencies).execute();

		assert.strictEqual(progressOptions[0]?.cancellable, true);
		assert.strictEqual(receivedSignal?.aborted, true);
		assert.deepStrictEqual(errorMessages, []);
		assert.deepStrictEqual(warningMessages, []);
	});

	test('loads forms through the authenticated form-list boundary and uses the configured default destination', async () => {
		const { org, calls, dependencies } = context();
		let defaultDirectorySignal: AbortSignal | undefined;
		dependencies.getDefaultDirectory = async signal => {
			defaultDirectorySignal = signal;
			return '/exports/default';
		};
		let listedOrgId: string | undefined;
		dependencies.listForms = async (_session, orgId) => {
			listedOrgId = orgId;
			return [
				{ id: 'form-1', name: 'New starter', updatedAt: '2026-09-20T10:00:00Z' },
				{ id: 'form-2', name: 'Exit interview', updatedAt: '2026-09-19T10:00:00Z' },
			];
		};
		selectItemsThenDestination(['form-2'], 'default');

		await new ExportForms(dependencies).execute();

		assert.strictEqual(listedOrgId, org.id);
		assert.ok(defaultDirectorySignal instanceof AbortSignal);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].name, 'buddy_export_forms');
		assert.deepStrictEqual(calls[0].arguments, {
			orgId: org.id,
			formIds: ['form-2'],
			includeBundle: false,
			outputPath: '/exports/default',
		});
	});

	test('batches large form selections in the resolved default directory', async () => {
		const { calls, dependencies } = context();
		const forms = Array.from({ length: 51 }, (_, index) => ({
			id: `form-${index + 1}`,
			name: `Form ${index + 1}`,
		}));
		dependencies.listForms = async () => forms;
		let defaultDirectorySignal: AbortSignal | undefined;
		dependencies.getDefaultDirectory = async signal => {
			defaultDirectorySignal = signal;
			return '/exports/default';
		};
		selectItemsThenDestination(
			forms.map(form => form.id),
			'default',
		);

		await new ExportForms(dependencies).execute();

		assert.ok(defaultDirectorySignal instanceof AbortSignal);
		assert.deepStrictEqual(
			calls.map(call => (call.arguments.formIds as string[]).length),
			[25, 25, 1],
		);
		assert.deepStrictEqual(
			calls.map(call => call.arguments.outputPath),
			[
				'/exports/default/rewst-forms-batch-001-of-003.json',
				'/exports/default/rewst-forms-batch-002-of-003.json',
				'/exports/default/rewst-forms-batch-003-of-003.json',
			],
		);
		assert.ok(calls.every(call => (call.arguments.formIds as string[]).length <= 25));
		assert.match(informationMessages[0], /Exported 51 forms across 3 signed bundle files/);
	});

	test('aborts the authenticated export and returns quietly when export progress is cancelled', async () => {
		const { dependencies } = context();
		dependencies.listForms = async () => [{ id: 'form-1', name: 'Form one' }];
		let receivedSignal: AbortSignal | undefined;
		dependencies.runCapability = async (_input, signal?: AbortSignal) => {
			receivedSignal = signal;
			if (!signal) throw new Error('Export did not receive a cancellation signal.');
			return new Promise((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('Export aborted.')), { once: true });
			});
		};
		selectItemsThenDestination(['form-1'], 'folder');
		restores.push(
			stub(vscode.window, 'showOpenDialog', (async () => [
				vscode.Uri.file('/exports/chosen'),
			]) as typeof vscode.window.showOpenDialog),
		);
		const progressOptions = stubProgress(2);

		await new ExportForms(dependencies).execute();

		assert.strictEqual(progressOptions[1]?.cancellable, true);
		assert.strictEqual(receivedSignal?.aborted, true);
		assert.deepStrictEqual(informationMessages, []);
		assert.deepStrictEqual(errorMessages, []);
	});

	test('handles no results without opening the object picker or exporter', async () => {
		const { calls, dependencies } = context();
		let quickPickCalls = 0;
		restores.push(
			stub(vscode.window, 'showQuickPick', (async () => {
				quickPickCalls++;
				return undefined;
			}) as unknown as typeof vscode.window.showQuickPick),
		);

		await new ExportForms(dependencies).execute();

		assert.strictEqual(quickPickCalls, 0);
		assert.strictEqual(calls.length, 0);
		assert.deepStrictEqual(warningMessages, ['No forms found for Export Org.']);
	});

	test('quietly returns when organization, object selection, destination, or folder selection is cancelled', async () => {
		const cases: ((dependencies: ExportCommandDependencies) => void)[] = [
			dependencies => {
				dependencies.pickOrganization = async () => undefined;
			},
			() => selectItemsThenDestination([], 'default'),
			() => selectItemsThenDestination(['form-1'], 'cancel'),
			() => {
				selectItemsThenDestination(['form-1'], 'folder');
				restores.push(
					stub(
						vscode.window,
						'showOpenDialog',
						(async () => undefined) as typeof vscode.window.showOpenDialog,
					),
				);
			},
		];

		for (const arrange of cases) {
			while (restores.length > 3) restores.pop()!();
			const { calls, dependencies } = context();
			dependencies.listForms = async () => [{ id: 'form-1', name: 'Form one' }];
			arrange(dependencies);
			await new ExportForms(dependencies).execute();
			assert.strictEqual(calls.length, 0);
		}
		assert.deepStrictEqual(errorMessages, []);
	});

	test('surfaces listing and exporter failures through the existing logger', async () => {
		const listing = context();
		listing.dependencies.listForms = async () => {
			throw new Error('listing failed');
		};
		await new ExportForms(listing.dependencies).execute();

		const exporting = context();
		exporting.dependencies.listForms = async () => [{ id: 'form-1', name: 'Form one' }];
		exporting.dependencies.runCapability = async () => {
			throw new Error('export failed');
		};
		selectItemsThenDestination(['form-1'], 'default');
		await new ExportForms(exporting.dependencies).execute();

		assert.match(errorMessages[0], /Failed to export forms.*listing failed/);
		assert.match(errorMessages[1], /Failed to export forms.*export failed/);
	});
});
