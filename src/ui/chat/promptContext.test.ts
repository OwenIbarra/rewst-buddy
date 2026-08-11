import * as assert from 'assert';
import * as Mocha from 'mocha';
import { MAX_STANDING_INSTRUCTIONS_CHARS, prependInstructions, standingInstructionsCost } from './promptContext';

const { suite, test } = Mocha;

suite('Unit: promptContext', () => {
	suite('prependInstructions()', () => {
		test('prepends trimmed instructions', () => {
			const result = prependInstructions('hello', '  be brief  ');
			assert.match(result, /^User's standing instructions: be brief/);
			assert.match(result, /hello$/);
		});

		test('returns the message untouched without instructions', () => {
			assert.strictEqual(prependInstructions('hello', undefined), 'hello');
			assert.strictEqual(prependInstructions('hello', '   '), 'hello');
		});

		test('bounds oversized standing instructions so the message survives them', () => {
			// The setting is user-authored and sits ahead of the question, so without a
			// cap the transport clamp would drop the request instead of the preamble.
			const result = prependInstructions('the actual question', 'x'.repeat(50_000));

			assert.ok(
				result.length < MAX_STANDING_INSTRUCTIONS_CHARS + 200,
				`prepended message was ${result.length} chars`,
			);
			assert.ok(result.endsWith('the actual question'), 'the question is never displaced');
			assert.ok(/truncated/.test(result), 'the cut is marked');
		});
	});

	suite('standingInstructionsCost()', () => {
		test('reports nothing for absent or blank instructions', () => {
			assert.strictEqual(standingInstructionsCost(undefined), 0);
			assert.strictEqual(standingInstructionsCost('  '), 0);
		});

		test('matches what prependInstructions actually adds', () => {
			const message = 'question';
			for (const instructions of ['be brief', 'y'.repeat(50_000)]) {
				const added = prependInstructions(message, instructions).length - message.length;
				assert.strictEqual(
					standingInstructionsCost(instructions),
					added,
					'budget accounting must match the rendered cost',
				);
			}
		});
	});
});
