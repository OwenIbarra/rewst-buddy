import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityContext } from '../src/capabilities/Capability';
import { getCapability } from '../src/capabilities/registry';
import {
	MAX_FORMS_PER_EXPORT,
	MAX_TEMPLATES_PER_EXPORT,
	_setFormExportDependenciesForTesting,
	_setTemplateExportDependenciesForTesting,
} from '../src/capabilities/templateFormExportCapabilities';
import type { ExportBundle } from '../src/export/exportObjects';
import { configureRuntimeHost, type RuntimeHost } from '../src/host';
import { callTool } from '../src/mcp/McpActions';
import type Session from '../src/sessions/Session';

const ORG_ID = 'org-a';
const OTHER_ORG_ID = 'org-b';
const region = {
	name: 'fixture',
	cookieName: 'appSession',
	graphqlUrl: 'https://api.rewst.io/graphql',
	loginUrl: 'https://app.rewst.io',
};

type ObjectKind = 'template' | 'form';

const cases = [
	{
		kind: 'template' as const,
		toolName: 'buddy_export_templates',
		idsField: 'templateIds',
		ids: ['template-1', 'template-2'],
		max: MAX_TEMPLATES_PER_EXPORT,
		setDependencies: _setTemplateExportDependenciesForTesting,
	},
	{
		kind: 'form' as const,
		toolName: 'buddy_export_forms',
		idsField: 'formIds',
		ids: ['form-1', 'form-2'],
		max: MAX_FORMS_PER_EXPORT,
		setDependencies: _setFormExportDependenciesForTesting,
	},
];

function bundleFixture(kind: ObjectKind, ids: readonly string[]): ExportBundle {
	return {
		version: 2,
		exportedAt: '2026-09-20T20:46:23.000Z',
		signing: { signature: `${kind}-signature` },
		objects: ids.map(id => ({ type: kind, fields: { id } })),
	};
}

function context(
	kind: ObjectKind,
	owners: Record<string, { id: string; orgId: string } | null>,
	onOwnerCheck?: (id: string) => void,
) {
	const rawGraphql = vi.fn(async (query: string, variables?: Record<string, unknown>) => {
		const id = variables?.id as string;
		expect(query).toContain(`${kind}(where: { id: $id })`);
		onOwnerCheck?.(id);
		return { data: { [kind]: owners[id] ?? null } };
	});
	const session = {
		profile: { region },
		getCookies: vi.fn(async () => 'fixture-token'),
		rawGraphql,
	} as unknown as Session;
	return {
		rawGraphql,
		ctx: { session, orgId: ORG_ID, sessions: [session] } as CapabilityContext,
	};
}

beforeEach(() => {
	const state = new Map<string, unknown>();
	configureRuntimeHost({
		state: {
			get: (key, fallback) => (state.get(key) ?? fallback) as never,
			update: async (key, value) => {
				state.set(key, value);
			},
		},
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
		getSetting: (_key, fallback) => fallback,
		log: () => {},
	} satisfies RuntimeHost);
});

afterEach(() => {
	_setTemplateExportDependenciesForTesting();
	_setFormExportDependenciesForTesting();
	vi.restoreAllMocks();
});

describe.each(cases)('$toolName', testCase => {
	it('is registered as a bounded read capability with the object-specific id field', () => {
		const capability = getCapability(testCase.toolName);
		expect(capability?.access).toBe('read');
		const inputSchema = capability?.spec.inputSchema as { required?: string[] };
		expect(capability?.spec.inputSchema).toMatchObject({
			type: 'object',
			properties: {
				[testCase.idsField]: { type: 'array', minItems: 1, maxItems: testCase.max },
				overwrite: { const: false, default: false },
			},
		});
		expect(inputSchema.required).toEqual(expect.arrayContaining(['orgId', testCase.idsField]));
	});

	it('checks every owner before exporting, dedupes ids, saves, and returns the signed summary', async () => {
		const [first, second] = testCase.ids;
		const events: string[] = [];
		const { rawGraphql, ctx } = context(
			testCase.kind,
			{
				[first]: { id: first, orgId: ORG_ID },
				[second]: { id: second, orgId: ORG_ID },
			},
			id => events.push(`owner:${id}`),
		);
		const bundle = bundleFixture(testCase.kind, testCase.ids);
		const transport = vi.fn(async () => {
			events.push('transport');
			return { recommendedFilename: `${testCase.kind}.bundle.json`, bundle };
		});
		const storage = {
			save: vi.fn(async () => {
				events.push('storage');
				return {
					outputPath: `/abs/default/${testCase.kind}.bundle.json`,
					bytes: Buffer.byteLength(JSON.stringify(bundle, null, 2)),
				};
			}),
		};
		testCase.setDependencies({ transport, storage, defaultDir: async () => '/abs/default' });
		const capability = getCapability(testCase.toolName);
		if (!capability) throw new Error(`Expected ${testCase.toolName}`);

		const result = JSON.parse(
			await capability.run({ orgId: ORG_ID, [testCase.idsField]: [`  ${first}`, first, `${second}  `] }, ctx),
		);

		expect(rawGraphql).toHaveBeenCalledTimes(2);
		expect(events).toEqual([`owner:${first}`, `owner:${second}`, 'transport', 'storage']);
		expect(transport).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				objects: testCase.ids.map(id => ({ type: testCase.kind, id })),
				operationName: `${testCase.kind[0].toUpperCase()}${testCase.kind.slice(1)} export`,
				fallbackFilename: `rewst-${testCase.kind}s-export.json`,
			}),
		);
		expect(transport.mock.calls[0]?.[0]).not.toHaveProperty('workflowIds');
		expect(storage.save).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				outputPath: '/abs/default',
				recommendedFilename: `${testCase.kind}.bundle.json`,
				overwrite: false,
			}),
		);
		expect(result).toMatchObject({
			status: 'saved',
			orgId: ORG_ID,
			[testCase.idsField]: testCase.ids,
			recommendedFilename: `${testCase.kind}.bundle.json`,
			outputPath: `/abs/default/${testCase.kind}.bundle.json`,
			version: 2,
			exportedAt: bundle.exportedAt,
			objectCount: 2,
			signingPresent: true,
			bundle,
		});
	});

	it.each(['missing', 'cross-organization'] as const)(
		'fails closed on %s ownership before transport or storage',
		async ownership => {
			const [first, id] = testCase.ids;
			const owner = ownership === 'missing' ? null : { id, orgId: OTHER_ORG_ID };
			const { rawGraphql, ctx } = context(testCase.kind, {
				[first]: { id: first, orgId: ORG_ID },
				[id]: owner,
			});
			const transport = vi.fn();
			const storage = { save: vi.fn() };
			const defaultDir = vi.fn();
			testCase.setDependencies({ transport, storage, defaultDir });
			const capability = getCapability(testCase.toolName);
			if (!capability) throw new Error(`Expected ${testCase.toolName}`);

			await expect(capability.run({ orgId: ORG_ID, [testCase.idsField]: [first, id] }, ctx)).rejects.toThrow(
				`${testCase.kind[0].toUpperCase()}${testCase.kind.slice(1)} ${id} was not found in org ${ORG_ID}.`,
			);
			expect(rawGraphql.mock.calls.map(call => call[1]?.id)).toEqual([first, id]);
			expect(transport).not.toHaveBeenCalled();
			expect(defaultDir).not.toHaveBeenCalled();
			expect(storage.save).not.toHaveBeenCalled();
		},
	);

	it('rejects over-limit requests and observes cancellation before owner checks', async () => {
		const { rawGraphql, ctx } = context(testCase.kind, {});
		const transport = vi.fn();
		const storage = { save: vi.fn() };
		testCase.setDependencies({ transport, storage });
		const capability = getCapability(testCase.toolName);
		if (!capability) throw new Error(`Expected ${testCase.toolName}`);
		const tooMany = Array.from({ length: testCase.max + 1 }, (_, index) => `${testCase.kind}-${index}`);

		await expect(capability.run({ orgId: ORG_ID, [testCase.idsField]: tooMany }, ctx)).rejects.toThrow(
			`at most ${testCase.max} ${testCase.kind} ids`,
		);

		const controller = new AbortController();
		controller.abort();
		await expect(
			capability.run(
				{ orgId: ORG_ID, [testCase.idsField]: [testCase.ids[0]] },
				{ ...ctx, signal: controller.signal },
			),
		).rejects.toThrow(new RegExp(`${testCase.kind} export was cancelled`, 'i'));
		expect(rawGraphql).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
		expect(storage.save).not.toHaveBeenCalled();
	});
});

describe('template/form export MCP cancellation', () => {
	it.each(cases)('passes cancellation through $toolName before session access', async testCase => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			callTool({
				name: testCase.toolName,
				arguments: { orgId: ORG_ID, [testCase.idsField]: [testCase.ids[0]] },
				signal: controller.signal,
			}),
		).rejects.toThrow(new RegExp(`${testCase.kind} export was cancelled`, 'i'));
	});
});
