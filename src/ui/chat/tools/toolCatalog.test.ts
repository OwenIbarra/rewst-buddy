import * as assert from 'assert';
import { suite, test } from '../../../test/tdd';
import {
	MAX_TOOL_DETAILS_REQUESTED,
	mcpToolTail,
	parseRequestedToolNames,
	planToolManifest,
	renderToolCatalogEntry,
	renderToolDetailEntry,
	renderToolDetails,
	renderToolNameEntry,
	summarizeToolDescription,
	TOOL_DETAILS_SPEC,
	TOOL_DETAILS_TOOL_NAME,
	TOOL_SUMMARY_MAX_CHARS,
} from './toolCatalog';
import type { ToolSpec } from './toolProtocol';

function spec(name: string, descriptionChars = 400, argsChars = 400): ToolSpec {
	return {
		name,
		description: `Does ${name}. ${'detail '.repeat(Math.ceil(descriptionChars / 7))}`.slice(0, descriptionChars),
		args: `{"schema":"${'x'.repeat(Math.max(0, argsChars - 14))}"}`,
	};
}

suite('Unit: toolCatalog', () => {
	suite('summarizeToolDescription()', () => {
		test('keeps a short description whole', () => {
			assert.strictEqual(summarizeToolDescription('Reads a file.'), 'Reads a file.');
		});

		test('collapses whitespace', () => {
			assert.strictEqual(summarizeToolDescription('Reads\n  a\tfile.'), 'Reads a file.');
		});

		test('keeps only the first sentence of a long description', () => {
			const summary = summarizeToolDescription(`Reads a file. ${'More detail. '.repeat(80)}`);
			assert.strictEqual(summary, 'Reads a file.');
		});

		test('word-cuts a long description with no early sentence break', () => {
			const summary = summarizeToolDescription(`${'word '.repeat(200)}end.`);
			assert.ok(summary.length <= TOOL_SUMMARY_MAX_CHARS + 1, `summary was ${summary.length} chars`);
			assert.ok(summary.endsWith('…'), 'the cut is marked');
		});
	});

	suite('planToolManifest()', () => {
		test('details every tool when the full manifest fits the budget', () => {
			const specs = [spec('a'), spec('b')];
			const plan = planToolManifest(specs, 100_000);
			assert.deepStrictEqual(
				plan.detailed.map(s => s.name),
				['a', 'b'],
			);
			assert.deepStrictEqual(plan.cataloged, []);
		});

		test('catalogs the overflow and keeps the manifest within budget', () => {
			const specs = Array.from({ length: 60 }, (_, i) => spec(`tool_${i}`));
			const budget = 8_000;
			const plan = planToolManifest(specs, budget);

			assert.ok(plan.cataloged.length > 0, 'some tools are cataloged');
			assert.strictEqual(plan.detailed.length + plan.cataloged.length + plan.named.length, specs.length);
			const rendered = [
				...plan.detailed.map(renderToolDetailEntry),
				...plan.cataloged.map(renderToolCatalogEntry),
				...plan.named.map(renderToolNameEntry),
			].join('\n');
			assert.ok(rendered.length <= budget, `manifest was ${rendered.length} chars, budget ${budget}`);
		});

		test('details the tools listed first, so editor tools keep their schemas', () => {
			const specs = [spec('first'), ...Array.from({ length: 60 }, (_, i) => spec(`later_${i}`))];
			const plan = planToolManifest(specs, 8_000);
			assert.strictEqual(plan.detailed[0].name, 'first');
		});

		test('still details the leading tools when a huge registry cannot even be summarized', () => {
			// The real failure this guards: ~155 tools whose summaries alone overrun the
			// budget previously left EVERY tool without an args schema, including the
			// editor tools the model calls constantly.
			const specs = Array.from({ length: 160 }, (_, i) => spec(`tool_${i}`, 600, 900));
			const budget = 20_000;
			const plan = planToolManifest(specs, budget);

			assert.ok(plan.detailed.length >= 5, `only ${plan.detailed.length} tools kept full detail`);
			assert.strictEqual(plan.detailed[0].name, 'tool_0', 'detail goes to the earliest specs');
			assert.ok(plan.named.length > 0, 'the long tail degrades to names');
			assert.strictEqual(plan.detailed.length + plan.cataloged.length + plan.named.length, specs.length);
			const rendered = [
				...plan.detailed.map(renderToolDetailEntry),
				...plan.cataloged.map(renderToolCatalogEntry),
				...plan.named.map(renderToolNameEntry),
			].join('\n');
			assert.ok(rendered.length <= budget, `manifest was ${rendered.length} chars, budget ${budget}`);
		});

		test('every advertised tool appears in exactly one tier', () => {
			const specs = Array.from({ length: 100 }, (_, i) => spec(`tool_${i}`, 500, 700));
			const plan = planToolManifest(specs, 12_000);
			const seen = [...plan.detailed, ...plan.cataloged, ...plan.named].map(s => s.name);
			assert.strictEqual(new Set(seen).size, specs.length, 'no tool is dropped or duplicated');
		});

		test('always details the details tool itself, however tight the budget', () => {
			const specs = [...Array.from({ length: 60 }, (_, i) => spec(`t_${i}`)), TOOL_DETAILS_SPEC];
			const plan = planToolManifest(specs, 100);
			assert.ok(
				plan.detailed.some(s => s.name === TOOL_DETAILS_TOOL_NAME),
				'the catalog expansion tool is never summary-only',
			);
		});
	});

	suite('mcpToolTail()', () => {
		test('recovers the Buddy tool name from VS Code MCP naming', () => {
			assert.strictEqual(mcpToolTail('mcp_rewst-buddy_buddy_workflow_get'), 'buddy_workflow_get');
			assert.strictEqual(mcpToolTail('mcp_someServer_buddy_list_orgs'), 'buddy_list_orgs');
		});

		test('leaves ordinary and non-Buddy MCP tool names alone', () => {
			assert.strictEqual(mcpToolTail('buddy_workflow_get'), undefined);
			assert.strictEqual(mcpToolTail('read_file'), undefined);
			assert.strictEqual(mcpToolTail('mcp_other_pylanceDocuments'), undefined);
		});
	});

	suite('parseRequestedToolNames()', () => {
		test('reads a name array, de-duplicating and trimming', () => {
			assert.deepStrictEqual(parseRequestedToolNames({ tools: [' a ', 'b', 'a'] }), ['a', 'b']);
		});

		test('accepts a bare string and the alternate arg names', () => {
			assert.deepStrictEqual(parseRequestedToolNames({ tools: 'a' }), ['a']);
			assert.deepStrictEqual(parseRequestedToolNames({ names: ['b'] }), ['b']);
			assert.deepStrictEqual(parseRequestedToolNames({ tool: 'c' }), ['c']);
		});

		test('ignores non-string entries and caps the count', () => {
			const many = Array.from({ length: MAX_TOOL_DETAILS_REQUESTED + 5 }, (_, i) => `t_${i}`);
			assert.deepStrictEqual(parseRequestedToolNames({ tools: [1, null, 'ok'] }), ['ok']);
			assert.strictEqual(parseRequestedToolNames({ tools: many }).length, MAX_TOOL_DETAILS_REQUESTED);
		});

		test('returns nothing when the argument is missing', () => {
			assert.deepStrictEqual(parseRequestedToolNames({}), []);
		});
	});

	suite('renderToolDetails()', () => {
		test('returns the full description and args schema of each named tool', () => {
			const specs = [spec('buddy_workflow_edit'), spec('read_file')];
			const output = renderToolDetails(specs, { tools: ['buddy_workflow_edit'] });
			assert.ok(output.includes('### buddy_workflow_edit'));
			assert.ok(output.includes(specs[0].args), 'the exact args schema is returned');
			assert.ok(output.includes(specs[0].description), 'the whole description is returned');
			assert.ok(!output.includes('read_file'), 'unrequested tools are not returned');
		});

		test('reports an unknown name with close matches instead of dropping it', () => {
			const output = renderToolDetails([spec('buddy_workflow_get')], { tools: ['workflow_get'] });
			assert.ok(output.includes('### workflow_get'));
			assert.ok(output.includes('Not available'));
			assert.ok(output.includes('buddy_workflow_get'), 'a close match is suggested');
		});

		test('explains the call shape when no names are given', () => {
			const output = renderToolDetails([spec('a')], {});
			assert.ok(output.includes('No tool names given'));
			assert.ok(output.includes(TOOL_DETAILS_TOOL_NAME));
		});
	});
});
