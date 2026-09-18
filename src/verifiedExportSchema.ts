import {
	Kind,
	parse,
	visit,
	type DocumentNode,
	type FieldDefinitionNode,
	type InputValueDefinitionNode,
} from 'graphql';

// Export-only facts verified through Rewst Buddy on 2026-09-17. This is an
// offline overlay, not a substitute for refreshing the complete live schema.
const verified = parse(`
  scalar Unknown
  type Subscription {
    exportObjects(objects: [ExportRequestObject!]!): ExportObjectsStreamEvent
  }
  input ExportRequestObject { id: ID!, type: ExportObjectType! }
  type ExportBundle { version: Int!, exportedAt: String!, signing: JSON!, objects: JSON! }
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
`);

/** Replace only verified fields, retaining all unrelated snapshot definitions. */
export function applyVerifiedExportContract(snapshot: DocumentNode): DocumentNode {
	const patches = new Map<string, readonly (FieldDefinitionNode | InputValueDefinitionNode)[]>();
	for (const definition of verified.definitions) {
		if (definition.kind === Kind.OBJECT_TYPE_DEFINITION || definition.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION) {
			patches.set(definition.name.value, definition.fields ?? []);
		}
	}
	const updated = visit(snapshot, {
		enter(node) {
			if (node.kind !== Kind.OBJECT_TYPE_DEFINITION && node.kind !== Kind.INPUT_OBJECT_TYPE_DEFINITION) return;
			const fields = patches.get(node.name.value);
			if (!fields) return;
			patches.delete(node.name.value);
			const names = new Set(fields.map(field => field.name.value));
			return {
				...node,
				fields: [...(node.fields ?? []).filter(field => !names.has(field.name.value)), ...fields],
			};
		},
	});
	if (patches.size) throw new Error(`Missing export snapshot types: ${[...patches.keys()].join(', ')}`);
	const unknown = updated.definitions.find(
		definition => 'name' in definition && definition.name?.value === 'Unknown',
	);
	if (unknown && unknown.kind !== Kind.SCALAR_TYPE_DEFINITION) throw new Error('Unknown must be a scalar.');
	return unknown ? updated : { ...updated, definitions: [...updated.definitions, verified.definitions[0]] };
}
