import { clearCachedSession, getTestOrgId, getTestSession, hasTestToken, initTestEnvironment } from '@test';
import * as assert from 'assert';
import { randomUUID } from 'crypto';
import * as Mocha from 'mocha';
import type { CapabilityContext } from '../../../packages/mcp-server/src/capabilities/Capability';
import { getCapability } from '../../../packages/mcp-server/src/capabilities/registry';
import {
	_setFormExportDependenciesForTesting,
	_setTemplateExportDependenciesForTesting,
} from '../../../packages/mcp-server/src/capabilities/templateFormExportCapabilities';
import type { Session } from '../../../packages/mcp-server/src/sessions';
import { rawGraphqlOrThrow } from '../../capabilities/inputHelpers';

const { suite, test, suiteSetup, suiteTeardown } = Mocha;

const SANDBOX_EXPORT_ANCHORS = `query RbItestExportValidationAnchors($orgId: ID!) {
  templates(where: { orgId: $orgId }, limit: 1) { id orgId }
  forms(where: { orgId: $orgId }, limit: 1) { id orgId }
}`;

/**
 * Opt-in live ownership checks only. The injected transport and storage guards
 * make starting an export subscription or saving a bundle a test failure.
 * REWST_EXPORT_VALIDATION_LIVE=1 npm run test:grep:integration -- "template/form export validation"
 */
suite('Integration: template/form export validation (read-only)', function () {
	this.timeout(120_000);

	let session: Session;
	let ctx: CapabilityContext;
	let orgId: string;
	let anchors: { template?: string; form?: string } = {};

	suiteSetup(async function () {
		if (!hasTestToken() || process.env.REWST_EXPORT_VALIDATION_LIVE !== '1') {
			this.skip();
			return;
		}
		initTestEnvironment();
		orgId = getTestOrgId();
		session = await getTestSession();
		if (session.profile.org.id !== orgId || session.profile.allManagedOrgs.some(org => org.id !== orgId)) {
			throw new Error('Safety invariant failed: test session is not sandbox-only.');
		}
		ctx = { session, orgId, sessions: [session] };
		const data = (await rawGraphqlOrThrow(session, SANDBOX_EXPORT_ANCHORS, { orgId })) as {
			templates?: { id: string; orgId: string }[];
			forms?: { id: string; orgId: string }[];
		};
		for (const row of [...(data.templates ?? []), ...(data.forms ?? [])]) {
			assert.strictEqual(row.orgId, orgId, 'Export validation anchor must belong to the sandbox.');
		}
		anchors = { template: data.templates?.[0]?.id, form: data.forms?.[0]?.id };
	});

	suiteTeardown(() => {
		_setTemplateExportDependenciesForTesting();
		_setFormExportDependenciesForTesting();
		clearCachedSession();
	});

	for (const testCase of [
		{
			kind: 'template' as const,
			toolName: 'buddy_export_templates',
			idsField: 'templateIds',
			setDependencies: _setTemplateExportDependenciesForTesting,
		},
		{
			kind: 'form' as const,
			toolName: 'buddy_export_forms',
			idsField: 'formIds',
			setDependencies: _setFormExportDependenciesForTesting,
		},
	]) {
		async function expectRejectedBeforeExport(id: string, requestedOrgId: string): Promise<void> {
			const capability = getCapability(testCase.toolName);
			assert.ok(capability, `missing capability ${testCase.toolName}`);
			let transportCalls = 0;
			let storageCalls = 0;
			let defaultDirCalls = 0;
			testCase.setDependencies({
				transport: async () => {
					transportCalls++;
					throw new Error('Export subscription must not start.');
				},
				storage: {
					save: async () => {
						storageCalls++;
						throw new Error('Local storage must not start.');
					},
				},
				defaultDir: async () => {
					defaultDirCalls++;
					throw new Error('Default export directory must not be created.');
				},
			});
			try {
				await assert.rejects(
					capability.run({ orgId: requestedOrgId, [testCase.idsField]: [id] }, ctx),
					new RegExp(`${testCase.kind} ${id} was not found in org ${requestedOrgId}`, 'i'),
				);
				assert.deepStrictEqual(
					{ transportCalls, storageCalls, defaultDirCalls },
					{
						transportCalls: 0,
						storageCalls: 0,
						defaultDirCalls: 0,
					},
				);
			} finally {
				testCase.setDependencies();
			}
		}

		test(`${testCase.toolName} rejects a missing id from the live sandbox`, async () => {
			await expectRejectedBeforeExport(randomUUID(), orgId);
		});

		test(`${testCase.toolName} rejects a live sandbox id requested under another org`, async function () {
			const id = anchors[testCase.kind];
			if (!id) {
				this.skip();
				return;
			}
			// The only remote lookup is by a known sandbox id. The synthetic org id
			// exercises the mismatch without reading another organization's data.
			await expectRejectedBeforeExport(id, randomUUID());
		});
	}
});
