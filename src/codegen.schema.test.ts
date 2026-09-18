import * as assert from 'assert';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { suite, test } from './test/tdd';
import offlineCodegen from './codegen';

const ENV_KEY = 'REWST_BUDDY_SCHEMA_REFRESH';
const LIVE_SCHEMA = 'https://api.rewst.io/graphql';
const SNAPSHOT_OUTPUT = 'packages/mcp-server/src/sessions/graphql/schema.graphql';

async function loadConfig() {
	const module = await import('./codegen.schema');
	return module.default;
}

async function withEnv(value: string | undefined, load: () => Promise<void>): Promise<void> {
	const saved = process.env[ENV_KEY];
	if (value === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = value;
	vi.resetModules();
	try {
		await load();
	} finally {
		if (saved === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = saved;
		vi.resetModules();
	}
}

suite('Unit: codegen.schema verified-export mode', () => {
	test('default mode targets the live schema with only the snapshot output', async () => {
		await withEnv(undefined, async () => {
			const config = await loadConfig();

			assert.strictEqual(config.schema, LIVE_SCHEMA);
			assert.deepStrictEqual(Object.keys(config.generates ?? {}), [SNAPSHOT_OUTPUT]);
		});
	});

	test('verified-export mode stages a transformed local schema path', async () => {
		await withEnv('verified-export', async () => {
			const config = await loadConfig();

			assert.ok(typeof config.schema === 'string' && !config.schema.startsWith('http'));
			assert.ok(config.schema.endsWith('schema.graphql'));
			assert.ok(existsSync(config.schema), 'transformed schema file is staged on disk');

			const generates = config.generates ?? {};
			assert.ok(generates[SNAPSHOT_OUTPUT], 'snapshot output is generated');
			for (const key of Object.keys(offlineCodegen.generates)) {
				assert.ok(generates[key], `offline generate entry ${key} is preserved`);
			}
		});
	});
});
