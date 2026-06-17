import type { WriteApproval } from '@capabilities';
import * as assert from 'assert';
import * as Mocha from 'mocha';
import { initTestEnvironment } from '@test';
import { _resetApprovedMutationScopes } from '../ui/chat/tools/graphqlTool';
import { _resetWriteApprovalPromptsForTesting, isWriteApproved, requestWriteApproval } from './approval';

const { suite, test, setup } = Mocha;

const approval: WriteApproval = {
	scopeId: 'tmpl-1',
	scopeName: 'Welcome',
	orgId: 'org-1',
	orgName: 'Acme',
	action: 'update the body of template',
};

suite('Unit: MCP write approval', () => {
	setup(() => {
		initTestEnvironment();
		_resetApprovedMutationScopes();
		_resetWriteApprovalPromptsForTesting();
	});

	test('a resource is not approved until the user approves it', () => {
		assert.strictEqual(isWriteApproved(approval), false);
	});

	test('approving through the prompt records the scope for the session', async () => {
		const promptCalls: WriteApproval[] = [];
		requestWriteApproval(approval, async a => {
			promptCalls.push(a);
			return true;
		});
		// Let the prompt promise settle.
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(promptCalls.length, 1);
		assert.strictEqual(isWriteApproved(approval), true);
	});

	test('a dismissed prompt leaves the resource unapproved', async () => {
		requestWriteApproval(approval, async () => false);
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(isWriteApproved(approval), false);
	});

	test('does not prompt again while one is already pending for the scope', async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));
		const prompt = async () => {
			calls++;
			await gate;
			return true;
		};
		requestWriteApproval(approval, prompt);
		requestWriteApproval(approval, prompt); // second call while first is pending
		assert.strictEqual(calls, 1, 'only one prompt is shown for a pending scope');
		release();
		await new Promise(resolve => setImmediate(resolve));
	});

	test('does not prompt for an already-approved scope', async () => {
		requestWriteApproval(approval, async () => true);
		await new Promise(resolve => setImmediate(resolve));
		let calls = 0;
		requestWriteApproval(approval, async () => {
			calls++;
			return true;
		});
		assert.strictEqual(calls, 0);
	});
});
