import * as assert from 'assert';
import {
	Kind,
	buildASTSchema,
	parse,
	print,
	printSchema,
	type DocumentNode,
	type InputObjectTypeDefinitionNode,
	type ObjectTypeDefinitionNode,
} from 'graphql';
import { suite, test } from './test/tdd';
import { applyVerifiedExportContract } from './verifiedExportSchema';

const BASE_SNAPSHOT = `
scalar JSON
scalar Unknown
scalar ExportObjectIdentifier
enum ExportObjectType { WORKFLOW }
type ExportObjectsStreamEvent { token: String }
type Query { hello: String }
type Subscription {
	exportObjects(objects: [ExportRequestObject!]!): ExportObjectsStreamEvent
	legacySubscriptionField: String
}
input ExportRequestObject { id: ID! }
type ExportBundle { version: String, legacyBundleField: String }
type ExportObjectsStreamSuccessResponse {
	isFinished: Boolean!
	didSucceed: Boolean!
	bundle: ExportBundle!
	recommendedFilename: String!
}
type ExportObjectsStreamFailureResponse {
	isFinished: Boolean!
	didSucceed: Boolean!
	failures: [ExportErrorObject!]!
	error: String
	code: String
}
type ExportErrorObject { paths: [[ExportObjectIdentifier!]!]! }
`;

function objectType(document: DocumentNode, name: string): ObjectTypeDefinitionNode {
	for (const node of document.definitions) {
		if (node.kind === Kind.OBJECT_TYPE_DEFINITION && node.name.value === name) return node;
	}
	assert.fail(`expected object type ${name}`);
}

function inputType(document: DocumentNode, name: string): InputObjectTypeDefinitionNode {
	for (const node of document.definitions) {
		if (node.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION && node.name.value === name) return node;
	}
	assert.fail(`expected input type ${name}`);
}

suite('Unit: applyVerifiedExportContract', () => {
	test('replaces verified object fields while retaining unrelated snapshot fields', () => {
		const result = applyVerifiedExportContract(parse(BASE_SNAPSHOT));
		const bundle = objectType(result, 'ExportBundle');
		const fields = new Map((bundle.fields ?? []).map(field => [field.name.value, field]));

		assert.ok(fields.has('legacyBundleField'), 'unrelated snapshot field is retained');
		const version = fields.get('version');
		assert.ok(version, 'verified version field is present');
		assert.strictEqual(print(version.type), 'Int!');
		for (const field of fields.values()) {
			assert.strictEqual(field.kind, Kind.FIELD_DEFINITION);
		}

		const subscription = objectType(result, 'Subscription');
		const subscriptionFields = new Map((subscription.fields ?? []).map(field => [field.name.value, field]));
		assert.ok(subscriptionFields.has('legacySubscriptionField'), 'unrelated subscription field is retained');
		assert.ok(subscriptionFields.has('exportObjects'), 'verified subscription field is present');
	});

	test('merges verified input fields with InputValue definitions', () => {
		const result = applyVerifiedExportContract(parse(BASE_SNAPSHOT));
		const request = inputType(result, 'ExportRequestObject');
		const fields = request.fields ?? [];

		assert.deepStrictEqual(fields.map(field => field.name.value).sort(), ['id', 'type']);
		for (const field of fields) {
			assert.strictEqual(field.kind, Kind.INPUT_VALUE_DEFINITION);
		}
	});

	test('patched snapshot prints and rebuilds as a valid schema', () => {
		const result = applyVerifiedExportContract(parse(BASE_SNAPSHOT));
		const printed = printSchema(buildASTSchema(result));

		assert.ok(printed.includes('exportObjects'));
		assert.ok(printed.includes('scalar Unknown'));
	});

	test('throws listing missing types when the snapshot lacks verified types', () => {
		assert.throws(
			() => applyVerifiedExportContract(parse('type Query { hello: String }')),
			/Missing export snapshot types: .*Subscription/,
		);
	});

	test('throws when Unknown is defined as a non-scalar', () => {
		const snapshot = BASE_SNAPSHOT.replace('scalar Unknown', 'type Unknown { hello: String }');

		assert.throws(() => applyVerifiedExportContract(parse(snapshot)), /Unknown must be a scalar/);
	});

	test('appends the Unknown scalar when the snapshot lacks it', () => {
		const snapshot = BASE_SNAPSHOT.replace('scalar Unknown\n', '');
		const result = applyVerifiedExportContract(parse(snapshot));
		const unknowns = result.definitions.filter(node => 'name' in node && node.name?.value === 'Unknown');

		assert.strictEqual(unknowns.length, 1);
		assert.strictEqual(unknowns[0].kind, Kind.SCALAR_TYPE_DEFINITION);
	});

	test('does not duplicate Unknown when the snapshot already defines it', () => {
		const result = applyVerifiedExportContract(parse(BASE_SNAPSHOT));
		const unknowns = result.definitions.filter(node => 'name' in node && node.name?.value === 'Unknown');

		assert.strictEqual(unknowns.length, 1);
	});
});
