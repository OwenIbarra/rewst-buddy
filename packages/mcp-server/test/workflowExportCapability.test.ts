import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityContext } from '../src/capabilities/Capability';
import { getCapability } from '../src/capabilities/registry';
import {
	MAX_WORKFLOWS_PER_EXPORT,
	_setWorkflowExportDependenciesForTesting,
} from '../src/capabilities/workflowExportCapability';
import type { ExportBundle } from '../src/export/exportObjects';
import type Session from '../src/sessions/Session';

const ORG_ID = 'org-a';
const OTHER_ORG_ID = 'org-b';

const region = {
	name: 'fixture',
	cookieName: 'appSession',
	graphqlUrl: 'https://api.rewst.io/graphql',
	loginUrl: 'https://app.rewst.io',
};

function bundleFixture(overrides?: Partial<ExportBundle>): ExportBundle {
	return {
		version: 2,
		exportedAt: '2026-09-17T20:46:23.000Z',
		signing: { cert: 'fixture-cert', hash: 'sha256', signature: 'fixture-signature' },
		objects: [
			{ type: 'workflow', fields: { id: 'wf-1' } },
			{ type: 'workflow', fields: { id: 'wf-2' } },
		],
		...overrides,
	};
}

const outcomeFixture = {
	recommendedFilename: 'workflow.bundle.json',
	bundle: bundleFixture(),
};

interface SessionHarness {
	session: Session;
	rawGraphql: ReturnType<typeof vi.fn>;
	ctx: CapabilityContext;
}

function installSession(owners: Record<string, { id: string; orgId: string } | null>): SessionHarness {
	const rawGraphql = vi.fn(async (_query: string, variables?: Record<string, unknown>) => {
		const id = variables?.id as string;
		return { data: { workflow: owners[id] ?? null } };
	});
	const session = {
		profile: { region },
		getCookies: vi.fn(async () => 'fixture-token'),
		rawGraphql,
	} as unknown as Session;
	const ctx = { session, orgId: ORG_ID, sessions: [session] } as CapabilityContext;
	return { session, rawGraphql, ctx };
}

afterEach(() => {
	_setWorkflowExportDependenciesForTesting();
	vi.restoreAllMocks();
});

describe('workflowExportCapability', () => {
	it('fails closed for an unknown workflow id without calling transport or storage', async () => {
		const { rawGraphql, ctx } = installSession({ 'wf-1': { id: 'wf-1', orgId: ORG_ID } });
		const transport = vi.fn(async () => outcomeFixture);
		const storage = { save: vi.fn(async () => ({ outputPath: '/abs/out.json', bytes: 1 })) };
		_setWorkflowExportDependenciesForTesting({ transport, storage });
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		await expect(capability.run({ orgId: ORG_ID, workflowIds: ['wf-1', 'wf-unknown'] }, ctx)).rejects.toThrow(
			`Workflow wf-unknown was not found in org ${ORG_ID}.`,
		);
		expect(rawGraphql).toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});

	it('fails closed for a workflow owned by another org without calling transport or storage', async () => {
		const { ctx } = installSession({ 'wf-foreign': { id: 'wf-foreign', orgId: OTHER_ORG_ID } });
		const transport = vi.fn(async () => outcomeFixture);
		const storage = { save: vi.fn(async () => ({ outputPath: '/abs/out.json', bytes: 1 })) };
		_setWorkflowExportDependenciesForTesting({ transport, storage });
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		await expect(capability.run({ orgId: ORG_ID, workflowIds: ['wf-foreign'] }, ctx)).rejects.toThrow(
			`Workflow wf-foreign was not found in org ${ORG_ID}.`,
		);
		expect(transport).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});

	it('saves to the default directory and still returns the bundle inline when no outputPath is given', async () => {
		const { ctx } = installSession({ 'wf-1': { id: 'wf-1', orgId: ORG_ID } });
		const transport = vi.fn(async () => outcomeFixture);
		const storage = {
			save: vi.fn(async () => ({ outputPath: '/abs/default-exports/workflow.bundle.json', bytes: 1 })),
		};
		_setWorkflowExportDependenciesForTesting({
			transport,
			storage,
			defaultDir: async () => '/abs/default-exports',
		});
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		const result = JSON.parse(await capability.run({ orgId: ORG_ID, workflowIds: ['wf-1'] }, ctx));

		expect(storage.save).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				outputPath: '/abs/default-exports',
				recommendedFilename: outcomeFixture.recommendedFilename,
				overwrite: false,
			}),
		);
		expect(result.status).toBe('saved');
		expect(result.outputPath).toBe('/abs/default-exports/workflow.bundle.json');
		expect(result.bundle).toEqual(outcomeFixture.bundle);
	});

	it('saves under the sanitized recommended filename for an existing directory outputPath', async () => {
		const { ctx } = installSession({ 'wf-1': { id: 'wf-1', orgId: ORG_ID } });
		const transport = vi.fn(async () => outcomeFixture);
		const savedBytes = 1234;
		const storage = {
			save: vi.fn(async () => ({ outputPath: '/abs/exports/workflow.bundle.json', bytes: savedBytes })),
		};
		_setWorkflowExportDependenciesForTesting({ transport, storage });
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		const result = JSON.parse(
			await capability.run({ orgId: ORG_ID, workflowIds: ['wf-1'], outputPath: '/abs/exports' }, ctx),
		);

		expect(storage.save).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				outputPath: '/abs/exports',
				recommendedFilename: outcomeFixture.recommendedFilename,
				overwrite: false,
			}),
		);
		expect(result.status).toBe('saved');
		expect(result.outputPath).toBe('/abs/exports/workflow.bundle.json');
		expect(result.bytes).toBe(savedBytes);
		expect(result.bundle).toBeUndefined();
	});

	it('omits the bundle by default with outputPath but includes it when includeBundle is true', async () => {
		const { ctx } = installSession({ 'wf-1': { id: 'wf-1', orgId: ORG_ID } });
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		const transport = vi.fn(async () => outcomeFixture);
		const storage = {
			save: vi.fn(async () => ({ outputPath: '/abs/exports/workflow.bundle.json', bytes: 10 })),
		};
		_setWorkflowExportDependenciesForTesting({ transport, storage });

		const omitted = JSON.parse(
			await capability.run({ orgId: ORG_ID, workflowIds: ['wf-1'], outputPath: '/abs/exports' }, ctx),
		);
		expect(omitted.bundle).toBeUndefined();

		const included = JSON.parse(
			await capability.run(
				{ orgId: ORG_ID, workflowIds: ['wf-1'], outputPath: '/abs/exports', includeBundle: true },
				ctx,
			),
		);
		expect(included.bundle).toEqual(outcomeFixture.bundle);
	});

	it('rejects overwrite without calling transport or storage', async () => {
		const { ctx } = installSession({ 'wf-1': { id: 'wf-1', orgId: ORG_ID } });
		const transport = vi.fn(async () => outcomeFixture);
		const storage = { save: vi.fn(async () => ({ outputPath: '/abs/out.json', bytes: 1 })) };
		_setWorkflowExportDependenciesForTesting({ transport, storage });
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		await expect(
			capability.run({ orgId: ORG_ID, workflowIds: ['wf-1'], outputPath: '/abs/out.json', overwrite: true }, ctx),
		).rejects.toThrow(/cannot overwrite/i);
		expect(transport).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});

	it('formats result fields and dedupes/trims workflow ids', async () => {
		const { ctx } = installSession({
			'wf-1': { id: 'wf-1', orgId: ORG_ID },
			'wf-2': { id: 'wf-2', orgId: ORG_ID },
		});
		const bundle = bundleFixture();
		const transport = vi.fn(async () => ({ recommendedFilename: 'acme.bundle.json', bundle }));
		const storage = {
			save: vi.fn(async (request: { contents: string }) => ({
				outputPath: '/abs/default-exports/acme.bundle.json',
				bytes: Buffer.byteLength(request.contents, 'utf8'),
			})),
		};
		_setWorkflowExportDependenciesForTesting({
			transport,
			storage,
			defaultDir: async () => '/abs/default-exports',
		});
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		const result = JSON.parse(
			await capability.run({ orgId: ORG_ID, workflowIds: ['  wf-1', 'wf-1', 'wf-2 '] }, ctx),
		);
		const expectedBytes = Buffer.byteLength(JSON.stringify(bundle, null, 2), 'utf8');

		expect(result).toMatchObject({
			status: 'saved',
			orgId: ORG_ID,
			workflowIds: ['wf-1', 'wf-2'],
			recommendedFilename: 'acme.bundle.json',
			outputPath: '/abs/default-exports/acme.bundle.json',
			bytes: expectedBytes,
			version: bundle.version,
			exportedAt: bundle.exportedAt,
			objectCount: 2,
			signingPresent: true,
		});
		expect(transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workflowIds: ['wf-1', 'wf-2'] }));
	});

	it('reports objectCount from mapped objects and signingPresent false when signing is absent', async () => {
		const { ctx } = installSession({ 'wf-1': { id: 'wf-1', orgId: ORG_ID } });
		const bundle = bundleFixture({ signing: null, objects: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } } });
		const transport = vi.fn(async () => ({ recommendedFilename: 'workflow.bundle.json', bundle }));
		const storage = {
			save: vi.fn(async () => ({ outputPath: '/abs/default-exports/workflow.bundle.json', bytes: 1 })),
		};
		_setWorkflowExportDependenciesForTesting({
			transport,
			storage,
			defaultDir: async () => '/abs/default-exports',
		});
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		const result = JSON.parse(await capability.run({ orgId: ORG_ID, workflowIds: ['wf-1'] }, ctx));

		expect(result.objectCount).toBe(3);
		expect(result.signingPresent).toBe(false);
	});

	it('rejects a cancelled call without calling transport or storage', async () => {
		const { rawGraphql, ctx } = installSession({ 'wf-1': { id: 'wf-1', orgId: ORG_ID } });
		const transport = vi.fn(async () => outcomeFixture);
		const storage = { save: vi.fn(async () => ({ outputPath: '/abs/out.json', bytes: 1 })) };
		_setWorkflowExportDependenciesForTesting({ transport, storage });
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');
		const controller = new AbortController();
		controller.abort();

		await expect(
			capability.run({ orgId: ORG_ID, workflowIds: ['wf-1'] }, { ...ctx, signal: controller.signal }),
		).rejects.toThrow(/cancelled/i);
		expect(rawGraphql).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});

	it(`accepts exactly ${MAX_WORKFLOWS_PER_EXPORT} workflow ids`, async () => {
		const ids = Array.from({ length: MAX_WORKFLOWS_PER_EXPORT }, (_, index) => `wf-${index}`);
		const owners = Object.fromEntries(ids.map(id => [id, { id, orgId: ORG_ID }]));
		const { ctx } = installSession(owners);
		const transport = vi.fn(async () => outcomeFixture);
		const storage = {
			save: vi.fn(async () => ({ outputPath: '/abs/default-exports/workflow.bundle.json', bytes: 1 })),
		};
		_setWorkflowExportDependenciesForTesting({
			transport,
			storage,
			defaultDir: async () => '/abs/default-exports',
		});
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		const result = JSON.parse(await capability.run({ orgId: ORG_ID, workflowIds: ids }, ctx));

		expect(result.workflowIds).toEqual(ids);
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it(`rejects more than ${MAX_WORKFLOWS_PER_EXPORT} workflow ids without calling transport or storage`, async () => {
		const { ctx } = installSession({});
		const transport = vi.fn(async () => outcomeFixture);
		const storage = { save: vi.fn(async () => ({ outputPath: '/abs/out.json', bytes: 1 })) };
		_setWorkflowExportDependenciesForTesting({ transport, storage });
		const capability = getCapability('buddy_export_workflows');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');
		const ids = Array.from({ length: MAX_WORKFLOWS_PER_EXPORT + 1 }, (_, index) => `wf-${index}`);

		await expect(capability.run({ orgId: ORG_ID, workflowIds: ids }, ctx)).rejects.toThrow(
			`at most ${MAX_WORKFLOWS_PER_EXPORT} workflow ids`,
		);
		expect(transport).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});

	it('is registered as a read capability that runs through the registry', async () => {
		const { ctx } = installSession({ 'wf-1': { id: 'wf-1', orgId: ORG_ID } });
		const transport = vi.fn(async () => outcomeFixture);
		const storage = {
			save: vi.fn(async () => ({ outputPath: '/abs/default-exports/workflow.bundle.json', bytes: 1 })),
		};
		_setWorkflowExportDependenciesForTesting({
			transport,
			storage,
			defaultDir: async () => '/abs/default-exports',
		});

		const capability = getCapability('buddy_export_workflows');
		expect(capability?.access).toBe('read');
		if (!capability) throw new Error('Expected buddy_export_workflows capability');

		const result = JSON.parse(await capability.run({ orgId: ORG_ID, workflowIds: ['wf-1'] }, ctx));
		expect(result.status).toBe('saved');
		expect(transport).toHaveBeenCalledTimes(1);
	});
});
