import { MAX_CONVERSATION_MESSAGE_CHARS, log } from '@utils';
import { initTestEnvironment } from '@test';
import * as assert from 'assert';
import * as Mocha from 'mocha';
import type { AskOptions } from './ConversationClient';
import { conversationVariables } from './ConversationClient';

const { suite, test, setup, teardown } = Mocha;

/** Captures log.info lines so the clamp's disclosure can be asserted. */
function captureInfo(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = log.info.bind(log);
	log.info = (message: string, ...args: unknown[]) => {
		lines.push(message);
		void args;
	};
	return { lines, restore: () => (log.info = original) };
}

function options(message: string): AskOptions {
	// Only the fields conversationVariables reads matter here; the transport
	// (session, sockets) is not involved.
	return { message, orgId: 'org-1' } as unknown as AskOptions;
}

suite('Unit: ConversationClient', () => {
	setup(() => {
		initTestEnvironment();
	});

	teardown(() => {
		// captureInfo restores in each test; nothing global to reset.
	});

	suite('conversationVariables()', () => {
		test('passes an ordinary message through untouched', () => {
			const captured = captureInfo();
			try {
				const variables = conversationVariables(options('what is a trigger?'), 'org-1');
				assert.strictEqual(variables.message, 'what is a trigger?');
				assert.strictEqual(variables.orgId, 'org-1');
				assert.deepStrictEqual(variables.metadata, { orgId: 'org-1' });
				assert.strictEqual(variables.conversationType, 'HELP_DOCS');
				assert.strictEqual(
					captured.lines.filter(line => line.includes('clamped')).length,
					0,
					'nothing is reported when nothing was trimmed',
				);
			} finally {
				captured.restore();
			}
		});

		test('clamps an over-long message before it reaches the subscription (#189)', () => {
			const captured = captureInfo();
			try {
				const overflow = 2_500;
				const variables = conversationVariables(
					options('a'.repeat(MAX_CONVERSATION_MESSAGE_CHARS + overflow)),
					'org-1',
				);

				assert.strictEqual(
					variables.message.length,
					MAX_CONVERSATION_MESSAGE_CHARS,
					'the subscription never sees a message over the backend limit',
				);
				const reported = captured.lines.find(line => line.includes('clamped'));
				assert.ok(reported, `expected a clamp log line, got: ${captured.lines.join(' | ')}`);
				assert.ok(
					reported.includes(`${overflow} chars`),
					`expected the dropped count in the log line, got: ${reported}`,
				);
			} finally {
				captured.restore();
			}
		});

		test('normalizes the optional continuation fields to null', () => {
			const captured = captureInfo();
			try {
				const variables = conversationVariables(options('hi'), 'org-2');
				assert.strictEqual(variables.conversationId, null);
				assert.strictEqual(variables.resumeRequestId, null);
			} finally {
				captured.restore();
			}
		});
	});
});
