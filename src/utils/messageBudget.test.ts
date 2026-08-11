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
			assert.strictEqual(perSectionBudget(1_000, 4), 250);
			assert.strictEqual(perSectionBudget(200, 1), 200);
		});

		test('partitions strictly: every section together never exceeds the total', () => {
			for (const [total, count] of [
				[1_000, 100],
				[5_460, 12],
				[100, 7],
				[3, 5],
				[24_000, 5],
			] as const) {
				const share = perSectionBudget(total, count);
				assert.ok(share * count <= total, `${count} sections of ${share} exceed the total of ${total}`);
			}
		});

		test('gives nothing rather than overspending when the total cannot cover the sections', () => {
			assert.strictEqual(perSectionBudget(3, 5), 0);
			assert.strictEqual(perSectionBudget(0, 4), 0);
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
