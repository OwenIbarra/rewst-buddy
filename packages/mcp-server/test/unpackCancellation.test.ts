import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureRuntimeHost, type RuntimeHost } from '../src/host';
import {
	_setUnpackTransportForTesting,
	type UnpackOutcome,
	type UnpackTransportOptions,
} from '../src/capabilities/crateUnpackCapability';
import {
	_resetMcpMutationApproverForTesting,
	setMcpMutationApprover,
} from '../src/capabilities/graphqlMutateCapability';
import { callTool, _resetMcpThrottleForTesting } from '../src/mcp/McpActions';
import { readMcpSettings, type McpSettings } from '../src/mcp/settings';
import { WorkingScopeManager } from '../src/models/WorkingScopeManager';
import { SessionManager } from '../src/sessions/SessionManager';
import type Session from '../src/sessions/Session';

const CRATE_ROW = {
	id: 'crate-1',
	name: 'User Onboarding',
	description: 'Full onboarding',
	requiredOrgVariables: ['ORG_VAR'],
	isUnpackedForSelectedOrg: false,
	workflow: { name: 'Onboarding Flow', humanSecondsSaved: 900 },
	tokens: [
		{ id: 'tok-1', name: 'Team Name', type: 'inputVar', index: 0, options: [] },
		{
			id: 'tok-2',
			name: 'Channel',
			type: 'selectVar',
			index: 1,
			options: [{ id: 'o-1', label: 'General', value: 'general', isDefault: true }],
		},
	],
	crateTriggers: [],
};

const region = {
	name: 'fixture',
	cookieName: 'appSession',
	graphqlUrl: 'https://api.example.test/graphql',
	loginUrl: 'https://app.example.test',
};

function sessionWith(rawGraphql: ReturnType<typeof vi.fn>) {
	return {
		profile: {
			user: { id: 'user-1' },
			org: { id: 'org-1', name: 'Org' },
			allManagedOrgs: [{ id: 'org-1', name: 'Org' }],
			region,
		},
		validate: async () => true,
		rawGraphql,
	} as unknown as Session;
}

describe('buddy_unpack_crate cancellation', () => {
	let transportCalls: UnpackTransportOptions[];
	let rawGraphql: ReturnType<typeof vi.fn>;
	let settings: McpSettings;

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
		WorkingScopeManager._resetForTesting();
		_resetMcpThrottleForTesting();
		transportCalls = [];
		_setUnpackTransportForTesting(async (opts): Promise<UnpackOutcome> => {
			transportCalls.push(opts);
			return { id: 'wf-9', orgId: opts.input.orgId, type: 'workflow' };
		});
		setMcpMutationApprover(async () => true);
		rawGraphql = vi.fn(async () => ({ data: { crate: CRATE_ROW } }));
		const stubSession = sessionWith(rawGraphql);
		vi.spyOn(SessionManager, 'getActiveSessions').mockReturnValue([stubSession]);
		vi.spyOn(SessionManager, 'getSessionForOrg').mockResolvedValue(stubSession);
		settings = { ...readMcpSettings(), enableWriteTools: true, alwaysAllowedOrgs: ['org-1'] };
	});

	afterEach(() => {
		_setUnpackTransportForTesting(undefined);
		_resetMcpMutationApproverForTesting();
		vi.restoreAllMocks();
	});

	function unpack(signal?: AbortSignal) {
		return callTool(
			{
				name: 'buddy_unpack_crate',
				arguments: { orgId: 'org-1', crateId: 'crate-1', tokenValues: { 'Team Name': 'Acme' } },
				signal,
			},
			settings,
		);
	}

	it('rejects an already-aborted unpack without touching GraphQL or the transport', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(unpack(controller.signal)).rejects.toThrow('Crate unpack was cancelled.');
		expect(rawGraphql).not.toHaveBeenCalled();
		expect(transportCalls).toHaveLength(0);
	});

	it('forwards a live caller signal into the unpack transport', async () => {
		const controller = new AbortController();

		const result = await unpack(controller.signal);

		expect(result.isError).not.toBe(true);
		expect(result.text).toContain('"unpacked"');
		expect(transportCalls).toHaveLength(1);
		expect(transportCalls[0].signal).toBe(controller.signal);
	});
});
