import * as assert from 'assert';
import * as Mocha from 'mocha';
import vscode from 'vscode';
import {
	chatToolSpecs,
	collectToolCalls,
	extractTrailingToolResults,
	formatInProcessToolResults,
	formatToolResultsMessage,
	partitionToolRequests,
	rejectedToolsNote,
} from './toolTranslation';

const { suite, test } = Mocha;

const { User, Assistant } = vscode.LanguageModelChatMessageRole;

function chatTool(name: string, description = `${name} tool`): vscode.LanguageModelChatTool {
	return { name, description, inputSchema: { type: 'object' } };
}

function fence(request: object): string {
	return '```vscode-tool\n' + JSON.stringify(request) + '\n```';
}

suite('Unit: toolTranslation', () => {
	suite('chatToolSpecs()', () => {
		test('maps VS Code tools into tool specs with a JSON arg signature', () => {
			const [spec] = chatToolSpecs([chatTool('read_file', 'read a file')]);
			assert.strictEqual(spec.name, 'read_file');
			assert.strictEqual(spec.description, 'read a file');
			assert.strictEqual(spec.args, JSON.stringify({ type: 'object' }));
		});

		test('falls back to an empty object signature when a tool has no schema', () => {
			const [spec] = chatToolSpecs([{ name: 't', description: 'd' } as vscode.LanguageModelChatTool]);
			assert.strictEqual(spec.args, '{}');
		});
	});

	suite('partitionToolRequests()', () => {
		test('routes built-in names to VS Code calls and buddy names to in-process requests', () => {
			const content = `${fence({ tool: 'read_file', args: { path: 'a.txt' } })}\n${fence({
				tool: 'buddy_workflow_get',
				args: { workflowId: 'w1' },
			})}`;
			const { vscodeCalls, buddyRequests, rejectedNames } = partitionToolRequests(
				content,
				new Set(['read_file']),
				new Set(['buddy_workflow_get']),
			);
			assert.strictEqual(vscodeCalls.length, 1);
			assert.strictEqual(vscodeCalls[0].name, 'read_file');
			assert.deepStrictEqual(vscodeCalls[0].input, { path: 'a.txt' });
			assert.strictEqual(buddyRequests.length, 1);
			assert.strictEqual(buddyRequests[0].tool, 'buddy_workflow_get');
			assert.deepStrictEqual(buddyRequests[0].args, { workflowId: 'w1' });
			assert.deepStrictEqual(rejectedNames, []);
		});

		test('reports names in neither set as rejected', () => {
			const content = fence({ tool: 'run_command', args: { command: 'ls' } });
			const { vscodeCalls, buddyRequests, rejectedNames } = partitionToolRequests(
				content,
				new Set(['read_file']),
				new Set(['buddy_workflow_get']),
			);
			assert.strictEqual(vscodeCalls.length, 0);
			assert.strictEqual(buddyRequests.length, 0);
			assert.deepStrictEqual(rejectedNames, ['run_command']);
		});

		test('a buddy name takes precedence even when it is also a VS Code tool', () => {
			// When VS Code passed the tool too (under the cap), the buddy in-process
			// path owns it so it never depends on the capped options.tools list.
			const content = fence({ tool: 'buddy_render_jinja', args: {} });
			const { vscodeCalls, buddyRequests } = partitionToolRequests(
				content,
				new Set(['buddy_render_jinja']),
				new Set(['buddy_render_jinja']),
			);
			assert.strictEqual(vscodeCalls.length, 0);
			assert.strictEqual(buddyRequests.length, 1);
		});
	});

	suite('formatInProcessToolResults()', () => {
		test('renders each result under a labeled fenced section the backend can read', () => {
			const message = formatInProcessToolResults([
				{ tool: 'buddy_workflow_get', argsLabel: '{"workflowId":"w1"}', ok: true, output: 'name: Deploy' },
			]);
			assert.ok(message.startsWith('Tool results:'));
			assert.ok(message.includes('buddy_workflow_get'));
			assert.ok(message.includes('{"workflowId":"w1"}'));
			assert.ok(message.includes('name: Deploy'));
			assert.ok(message.includes('give your final answer'));
		});

		test('caps a huge output so the results message fits the backend limit (#189)', () => {
			const budget = 5_000;
			const message = formatInProcessToolResults(
				[{ tool: 'buddy_execution_logs', argsLabel: '', ok: true, output: 'x'.repeat(200_000) }],
				budget,
			);
			// The budget bounds the whole message: labels, fences and the closing
			// instruction are reserved before any output is kept.
			assert.ok(message.length <= budget, `results message was ${message.length} chars, budget ${budget}`);
			assert.ok(/truncated/.test(message), 'the cut is marked for the model');
		});

		test('splits the output budget across several results', () => {
			const budget = 8_000;
			const results = Array.from({ length: 4 }, (_, i) => ({
				tool: `buddy_tool_${i}`,
				argsLabel: '',
				ok: true,
				output: 'y'.repeat(50_000),
			}));
			const message = formatInProcessToolResults(results, budget);
			assert.ok(message.length <= budget, `results message was ${message.length} chars, budget ${budget}`);
			for (let i = 0; i < results.length; i++) {
				assert.ok(message.includes(`buddy_tool_${i}`), `result ${i} is still reported`);
			}
		});

		test('stays within budget with more results than the budget can generously serve', () => {
			// Regression: an even split below the old per-section floor handed every
			// result the floor instead, so twelve results overran the whole budget.
			const budget = 6_000;
			const results = Array.from({ length: 12 }, (_, i) => ({
				tool: `buddy_tool_${i}`,
				argsLabel: '',
				ok: true,
				output: 'y'.repeat(5_000),
			}));
			const message = formatInProcessToolResults(results, budget);

			assert.ok(message.length <= budget, `results message was ${message.length} chars, budget ${budget}`);
			for (let i = 0; i < results.length; i++) {
				assert.ok(message.includes(`buddy_tool_${i}`), `result ${i} is still reported`);
			}
		});

		test('stays within budget when the args labels are themselves huge', () => {
			const budget = 4_000;
			const results = Array.from({ length: 3 }, (_, i) => ({
				tool: `buddy_tool_${i}`,
				argsLabel: JSON.stringify({ blob: 'a'.repeat(20_000) }),
				ok: true,
				output: 'z'.repeat(10_000),
			}));
			const message = formatInProcessToolResults(results, budget);
			assert.ok(message.length <= budget, `results message was ${message.length} chars, budget ${budget}`);
		});

		test('marks a failed result so the model does not treat the error text as data', () => {
			const message = formatInProcessToolResults([
				{ tool: 'buddy_workflow_get', argsLabel: '', ok: false, output: 'org_required' },
			]);
			assert.ok(/error/i.test(message));
			assert.ok(message.includes('org_required'));
		});
	});

	suite('formatToolResultsMessage()', () => {
		test('caps a huge editor tool output so the message fits the backend limit (#189)', () => {
			const message = formatToolResultsMessage(
				[{ callId: 'call-1', content: [new vscode.LanguageModelTextPart('z'.repeat(200_000))] }],
				new Map([['call-1', { name: 'read_file', input: { path: 'big.log' } }]]),
				5_000,
			);
			assert.ok(message.length <= 5_000, `results message was ${message.length} chars`);
			assert.ok(message.includes('read_file'), 'the tool is still labeled');
			assert.ok(/truncated/.test(message), 'the cut is marked for the model');
		});

		test('stays within budget with many replayed editor tool results', () => {
			const budget = 6_000;
			const results = Array.from({ length: 12 }, (_, i) => ({
				callId: `call-${i}`,
				content: [new vscode.LanguageModelTextPart('z'.repeat(5_000))],
			}));
			const calls = new Map(
				results.map((result, i) => [result.callId, { name: `editor_tool_${i}`, input: { path: `f${i}.txt` } }]),
			);
			const message = formatToolResultsMessage(results, calls, budget);

			assert.ok(message.length <= budget, `results message was ${message.length} chars, budget ${budget}`);
			for (let i = 0; i < results.length; i++) {
				assert.ok(message.includes(`editor_tool_${i}`), `result ${i} is still reported`);
			}
		});

		test('stays within budget when the echoed call input is huge', () => {
			const budget = 4_000;
			const message = formatToolResultsMessage(
				[{ callId: 'call-1', content: [new vscode.LanguageModelTextPart('z'.repeat(50_000))] }],
				new Map([['call-1', { name: 'create_file', input: { content: 'a'.repeat(80_000) } }]]),
				budget,
			);
			assert.ok(message.length <= budget, `results message was ${message.length} chars, budget ${budget}`);
			assert.ok(message.includes('create_file'), 'the tool is still labeled');
		});
	});

	suite('tool result round-trip', () => {
		test('collects calls from history and extracts trailing results', () => {
			const call = new vscode.LanguageModelToolCallPart('call-7', 'read_file', { path: 'a.txt' });
			const result = new vscode.LanguageModelToolResultPart('call-7', [
				new vscode.LanguageModelTextPart('file contents here'),
			]);
			const messages = [
				{ role: User, content: [new vscode.LanguageModelTextPart('check a.txt')] },
				{ role: Assistant, content: [call] },
				{ role: User, content: [result] },
			];

			const trailing = extractTrailingToolResults(messages);
			assert.ok(trailing);
			assert.strictEqual(trailing.length, 1);
			assert.strictEqual(trailing[0].callId, 'call-7');

			const calls = collectToolCalls(messages);
			assert.strictEqual(calls.get('call-7')?.name, 'read_file');
		});

		test('ordinary user turns are not tool results', () => {
			const messages = [{ role: User, content: [new vscode.LanguageModelTextPart('plain question')] }];
			assert.strictEqual(extractTrailingToolResults(messages), undefined);
		});
	});

	test('rejectedToolsNote names the tools once each', () => {
		const note = rejectedToolsNote(['run_command', 'run_command']);
		assert.ok(note.includes('`run_command`'));
		assert.strictEqual(note.match(/run_command/g)?.length, 1);
		assert.ok(!note.includes('rewst-buddy.ai'), 'chat rejection note does not mention retired Rewst tool settings');
	});
});
