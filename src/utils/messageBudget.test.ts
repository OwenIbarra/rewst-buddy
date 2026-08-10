import * as assert from 'assert';
import { suite, test } from '../test/tdd';
import {
	clampConversationMessage,
	MAX_CONVERSATION_MESSAGE_CHARS,
	MIN_TRANSCRIPT_CHARS,
	perSectionBudget,
	transcriptBudget,
	truncateToBudget,
	TURN_MESSAGE_TARGET_CHARS,
} from './messageBudget';

suite('Unit: messageBudget', () => {
	suite('truncateToBudget()', () => {
		test('leaves text within budget untouched', () => {
			assert.strictEqual(truncateToBudget('hello', 10), 'hello');
		});

		test('marks the cut when text overruns the budget', () => {
			const result = truncateToBudget('x'.repeat(500), 200);
			assert.strictEqual(result.length, 200);
			assert.ok(result.includes('truncated'), 'the cut is marked');
		});

		test('hard-slices when the budget cannot hold the marker', () => {
			assert.strictEqual(truncateToBudget('abcdef', 3), 'abc');
		});

		test('returns empty for a non-positive budget', () => {
			assert.strictEqual(truncateToBudget('abc', 0), '');
		});
	});

	suite('transcriptBudget()', () => {
		test('gives the transcript whatever the fixed parts leave', () => {
			assert.strictEqual(transcriptBudget(2_000), TURN_MESSAGE_TARGET_CHARS - 2_000);
		});

		test('never returns less than the floor', () => {
			assert.strictEqual(transcriptBudget(TURN_MESSAGE_TARGET_CHARS + 10_000), MIN_TRANSCRIPT_CHARS);
		});
	});

	suite('perSectionBudget()', () => {
		test('splits the total evenly', () => {
			assert.strictEqual(perSectionBudget(1_000, 4, 100), 250);
		});

		test('honors the floor for many sections', () => {
			assert.strictEqual(perSectionBudget(4_000, 4, 500), 1_000);
		});

		test('never hands a section more than the total budget', () => {
			// The floor must not lift a section above the budget it is drawn from.
			assert.strictEqual(perSectionBudget(1_000, 100, 5_000), 1_000);
			assert.strictEqual(perSectionBudget(200, 1, 500), 200);
		});

		test('returns the total when there are no sections', () => {
			assert.strictEqual(perSectionBudget(1_000, 0), 1_000);
		});
	});

	suite('clampConversationMessage()', () => {
		test('passes a message under the backend cap through unchanged', () => {
			const message = 'a'.repeat(100);
			assert.deepStrictEqual(clampConversationMessage(message), { message, trimmed: 0 });
		});

		test('clamps an over-long message to the cap and reports the loss', () => {
			const result = clampConversationMessage('a'.repeat(MAX_CONVERSATION_MESSAGE_CHARS + 1_500));
			assert.strictEqual(result.message.length, MAX_CONVERSATION_MESSAGE_CHARS);
			assert.strictEqual(result.trimmed, 1_500);
		});
	});
});
