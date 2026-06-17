import * as assert from 'assert';
import * as Mocha from 'mocha';
import type { CapabilitySettings } from './Capability';
import {
	CAPABILITY_REGISTRY,
	chatCapabilities,
	enabledMcpCapabilities,
	getCapability,
	mcpCapabilities,
} from './registry';

const { suite, test } = Mocha;

function settings(overrides: Partial<CapabilitySettings> = {}): CapabilitySettings {
	return { enableGraphqlTool: false, enableWorkspaceTools: false, enableWebTools: false, ...overrides };
}

suite('Unit: capability registry', () => {
	test('capability names are unique', () => {
		const names = CAPABILITY_REGISTRY.map(capability => capability.spec.name);
		assert.strictEqual(new Set(names).size, names.length, 'no duplicate capability names');
	});

	test('every capability declares an access level and an inputSchema', () => {
		for (const capability of CAPABILITY_REGISTRY) {
			assert.ok(['read', 'write'].includes(capability.access), `${capability.spec.name} access is read|write`);
			assert.ok(capability.spec.inputSchema, `${capability.spec.name} carries an inputSchema`);
		}
	});

	test('getCapability resolves by tool name', () => {
		const schema = getCapability('rewst_graphql_schema');
		assert.ok(schema, 'rewst_graphql_schema is registered');
		assert.strictEqual(schema.access, 'read');
		assert.strictEqual(getCapability('does_not_exist'), undefined);
	});

	test('rewst_graphql is a write capability (can mutate)', () => {
		const graphql = getCapability('rewst_graphql');
		assert.ok(graphql);
		assert.strictEqual(graphql.access, 'write');
	});

	suite('chat surface', () => {
		test('exposes the workspace, web, and graphql tools', () => {
			const names = chatCapabilities().map(capability => capability.spec.name);
			for (const expected of ['list_template_links', 'web_search', 'rewst_graphql_schema', 'rewst_graphql']) {
				assert.ok(names.includes(expected), `${expected} exposed to chat`);
			}
		});

		test('each chat capability is gated by its own setting', () => {
			const byName = new Map(chatCapabilities().map(capability => [capability.spec.name, capability]));
			assert.strictEqual(
				byName.get('list_template_links')?.enabled(settings({ enableWorkspaceTools: true })),
				true,
			);
			assert.strictEqual(byName.get('list_template_links')?.enabled(settings()), false);
			assert.strictEqual(byName.get('web_search')?.enabled(settings({ enableWebTools: true })), true);
			assert.strictEqual(byName.get('rewst_graphql')?.enabled(settings({ enableGraphqlTool: true })), true);
			assert.strictEqual(byName.get('rewst_graphql')?.enabled(settings()), false);
		});

		test('the MCP read tools are not exposed to the chat surface', () => {
			const names = chatCapabilities().map(capability => capability.spec.name);
			assert.ok(!names.includes('list_orgs'));
			assert.ok(!names.includes('get_workflow'));
		});
	});

	suite('mcp surface', () => {
		test('read tools are exposed to MCP and are all read access', () => {
			const names = mcpCapabilities().map(capability => capability.spec.name);
			for (const expected of [
				'list_orgs',
				'list_templates',
				'get_template',
				'list_workflows',
				'get_workflow',
				'rewst_graphql_query',
			]) {
				assert.ok(names.includes(expected), `${expected} exposed to MCP`);
			}
			for (const capability of mcpCapabilities()) {
				assert.strictEqual(capability.access, 'read', `${capability.spec.name} is read-only`);
			}
		});

		test('the GraphQL chat tools are not exposed to MCP (writes stay in the chat surface)', () => {
			const names = mcpCapabilities().map(capability => capability.spec.name);
			assert.ok(!names.includes('rewst_graphql'));
			assert.ok(!names.includes('rewst_graphql_schema'));
		});

		test('list_orgs does not require an org', () => {
			const listOrgs = getCapability('list_orgs');
			assert.ok(listOrgs);
			assert.strictEqual(listOrgs.requiresOrg, false);
		});

		test('rewst_graphql_query is gated by enableGraphqlTool; structured reads are not', () => {
			const off = enabledMcpCapabilities(settings()).map(capability => capability.spec.name);
			assert.ok(!off.includes('rewst_graphql_query'), 'raw query off by default');
			assert.ok(off.includes('list_templates'), 'structured reads always available');
			const on = enabledMcpCapabilities(settings({ enableGraphqlTool: true })).map(
				capability => capability.spec.name,
			);
			assert.ok(on.includes('rewst_graphql_query'), 'raw query available when graphql enabled');
		});
	});
});
