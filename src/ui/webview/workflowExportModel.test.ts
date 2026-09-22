import * as assert from 'assert';
import * as Mocha from 'mocha';
import type { ExportWorkflowChoice } from '../../commands/workflows/workflowExportEngine';
import {
	exportTagOptions,
	filterExportCatalog,
	filterWorkflowCatalog,
	filterWorkflowOrganizations,
	normalizeExportCatalog,
	normalizeWorkflowCatalog,
	parseExportCatalogFilters,
	parseWorkflowCatalogFilters,
	workflowTagOptions,
} from './workflowExportModel';

const { suite, test } = Mocha;

function workflow(overrides: Partial<ExportWorkflowChoice> = {}): ExportWorkflowChoice {
	return {
		id: 'wf-1',
		name: 'Morning Sync',
		orgId: 'org-1',
		orgName: 'Org One',
		createdAt: '2026-01-10T12:00:00.000Z',
		updatedAt: '2026-03-15T12:00:00.000Z',
		tags: [{ id: 'ops', name: 'Operations' }],
		...overrides,
	};
}

suite('Unit: workflow export catalog model', () => {
	test('normalizes metadata, removes duplicate ids, and collects sorted tags', () => {
		const workflows = normalizeWorkflowCatalog(
			[
				{
					id: ' wf-1 ',
					name: ' Morning Sync ',
					createdAt: '2026-01-10',
					updatedAt: '2026-03-15',
					tags: [
						{ id: 'ops', name: 'Operations' },
						{ id: 'alpha', name: 'Alpha' },
					],
				},
				{ id: 'wf-1', name: 'duplicate' },
				{ id: null, name: 'missing' },
			],
			{ id: 'org-1', name: 'Org One' },
		);

		assert.strictEqual(workflows.length, 1);
		assert.strictEqual(workflows[0].name, 'Morning Sync');
		assert.deepStrictEqual(workflowTagOptions(workflows), [
			{ id: 'alpha', name: 'Alpha' },
			{ id: 'ops', name: 'Operations' },
		]);
	});

	test('normalizes template and form rows through the shared catalog contract', () => {
		for (const fixture of [
			{ id: ' template-1 ', name: ' Welcome template ', tagName: 'Customer', orgId: 'org-templates' },
			{ id: ' form-1 ', name: ' Intake form ', tagName: 'Onboarding', orgId: 'org-forms' },
		]) {
			const objects = normalizeExportCatalog(
				[
					{
						id: fixture.id,
						name: fixture.name,
						createdAt: '1767225600000',
						updatedAt: '2026-02-28T23:59:59.000Z',
						tags: [
							{ id: ' shared ', name: ` ${fixture.tagName} ` },
							{ id: 'fallback', name: ' ' },
						],
					},
					{ id: fixture.id.trim(), name: 'duplicate' },
					{ id: ' ', name: 'missing id' },
				],
				{ id: fixture.orgId, name: 'Selected Org' },
			);

			assert.deepStrictEqual(objects, [
				{
					id: fixture.id.trim(),
					name: fixture.name.trim(),
					orgId: fixture.orgId,
					orgName: 'Selected Org',
					createdAt: '1767225600000',
					updatedAt: '2026-02-28T23:59:59.000Z',
					tags: [
						{ id: 'shared', name: fixture.tagName },
						{ id: 'fallback', name: 'fallback' },
					],
				},
			]);
			assert.deepStrictEqual(Object.fromEntries(exportTagOptions(objects).map(tag => [tag.id, tag.name])), {
				shared: fixture.tagName,
				fallback: 'fallback',
			});
		}
	});

	test('skips null tag entries and preserves tag-name and object-name fallbacks', () => {
		const objects = normalizeExportCatalog(
			[{ id: 'template-1', name: null, tags: [null, { id: null, name: 'ignored' }, { id: 'ops', name: null }] }],
			{ id: 'org-1', name: 'Org One' },
		);
		assert.strictEqual(objects[0].name, 'template-1');
		assert.deepStrictEqual(objects[0].tags, [{ id: 'ops', name: 'ops' }]);
		assert.deepStrictEqual(exportTagOptions(objects), [{ id: 'ops', name: 'ops' }]);
		assert.deepStrictEqual(
			filterExportCatalog(objects, { search: '', tagIds: ['ops'], tagMatch: 'all' }).map(item => item.id),
			['template-1'],
		);
	});

	test('filters organizations for the single searchable picker', () => {
		assert.deepStrictEqual(
			filterWorkflowOrganizations(
				[
					{ id: 'org-main', name: 'Main Organization' },
					{ id: 'org-ops', name: 'Operations' },
				],
				'ops',
			).map(org => org.id),
			['org-ops'],
		);
	});

	test('filters search, any/all tags, and inclusive created/updated dates', () => {
		const workflows = [
			workflow(),
			workflow({
				id: 'wf-2',
				name: 'Evening Audit',
				createdAt: '2026-02-05T00:00:00.000Z',
				updatedAt: '2026-04-20T23:59:59.000Z',
				tags: [
					{ id: 'ops', name: 'Operations' },
					{ id: 'audit', name: 'Audit' },
				],
			}),
		];

		assert.deepStrictEqual(
			filterWorkflowCatalog(workflows, {
				search: 'audit',
				tagIds: ['ops', 'audit'],
				tagMatch: 'all',
				createdFrom: '2026-02-05',
				createdTo: '2026-02-05',
				updatedFrom: '2026-04-20',
				updatedTo: '2026-04-20',
			}).map(item => item.id),
			['wf-2'],
		);
		assert.strictEqual(
			filterWorkflowCatalog(workflows, {
				search: '',
				tagIds: ['missing', 'ops'],
				tagMatch: 'any',
			}).length,
			2,
		);
	});

	test('applies shared tag/date filters to template and form catalogs and fails closed for unsupported fields', () => {
		const objects = [
			workflow({
				id: 'template-1',
				name: 'Welcome template',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-31T23:59:59.999Z',
				tags: [
					{ id: 'customer', name: 'Customer' },
					{ id: 'email', name: 'Email' },
				],
			}),
			workflow({
				id: 'form-1',
				name: 'Employee intake',
				createdAt: '2026-02-01T00:00:00.000Z',
				updatedAt: '2026-02-28T23:59:59.999Z',
				tags: [{ id: 'employee', name: 'Employee' }],
			}),
		];
		const filters = parseExportCatalogFilters({
			search: 'template',
			tagIds: ['customer', 'email', 'customer'],
			tagMatch: 'all',
			createdFrom: '2026-01-01',
			createdTo: '2026-01-01',
			updatedFrom: '2026-01-31',
			updatedTo: '2026-01-31',
		});

		assert.deepStrictEqual(
			filterExportCatalog(objects, filters).map(item => item.id),
			['template-1'],
		);
		assert.deepStrictEqual(
			filterExportCatalog(objects, {
				search: '',
				tagMatch: 'any',
				tagIds: ['missing', 'employee'],
			}).map(item => item.id),
			['form-1'],
		);
		assert.deepStrictEqual(
			filterExportCatalog(objects, filters, { tags: false, createdAt: true, updatedAt: true }),
			[],
		);
		assert.deepStrictEqual(
			filterExportCatalog(objects, { ...filters, tagIds: [] }, { tags: true, createdAt: false, updatedAt: true }),
			[],
		);
	});

	test('interprets epoch seconds and milliseconds without expanding valid 12-digit milliseconds', () => {
		const workflows = [
			workflow({ id: 'seconds', createdAt: '946684800' }),
			workflow({ id: 'twelve-digit-milliseconds', createdAt: '946684800000' }),
			workflow({ id: 'thirteen-digit-milliseconds', createdAt: '1767225600000' }),
			workflow({ id: 'invalid', createdAt: 'not-a-timestamp' }),
		];

		assert.deepStrictEqual(
			filterWorkflowCatalog(workflows, {
				search: '',
				tagIds: [],
				tagMatch: 'any',
				createdFrom: '2000-01-01',
				createdTo: '2000-01-01',
			}).map(item => item.id),
			['seconds', 'twelve-digit-milliseconds'],
		);
		assert.deepStrictEqual(
			filterWorkflowCatalog(workflows, {
				search: '',
				tagIds: [],
				tagMatch: 'any',
				createdFrom: '2026-01-01',
				createdTo: '2026-01-01',
			}).map(item => item.id),
			['thirteen-digit-milliseconds'],
		);
	});

	test('excludes missing timestamps when a date range is active and safely parses webview input', () => {
		assert.deepStrictEqual(
			filterWorkflowCatalog([workflow({ createdAt: null })], {
				search: '',
				tagIds: [],
				tagMatch: 'any',
				createdFrom: '2026-01-01',
			}),
			[],
		);
		assert.deepStrictEqual(parseWorkflowCatalogFilters({ tagIds: ['ops', 'ops', null], tagMatch: 'all' }), {
			search: '',
			tagIds: ['ops'],
			tagMatch: 'all',
			createdFrom: undefined,
			createdTo: undefined,
			updatedFrom: undefined,
			updatedTo: undefined,
		});
	});

	test('treats invalid non-empty date bounds as unbounded', () => {
		assert.deepStrictEqual(
			filterWorkflowCatalog([workflow()], {
				search: '',
				tagIds: [],
				tagMatch: 'any',
				createdFrom: 'not-a-date',
				updatedTo: 'also-not-a-date',
			}),
			[workflow()],
		);
	});

	test('keeps missing timestamps when the only date bound is invalid', () => {
		const missingCreatedAt = workflow({ createdAt: null });
		assert.deepStrictEqual(
			filterWorkflowCatalog([missingCreatedAt], {
				search: '',
				tagIds: [],
				tagMatch: 'any',
				createdFrom: 'not-a-date',
			}),
			[missingCreatedAt],
		);
	});
});
