import type { CodegenConfig } from '@graphql-codegen/cli';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildASTSchema, parse, printSchema } from 'graphql';
import offlineCodegen from './codegen';
import { applyVerifiedExportContract } from './verifiedExportSchema';

/**
 * Manual-only config for refreshing the committed schema snapshot.
 * Run: npm run codegen:refresh-schema
 *
 * This hits the live API and overwrites packages/mcp-server/src/sessions/graphql/schema.graphql.
 * The main `codegen` script uses the committed snapshot (offline, reproducible).
 * Set REWST_BUDDY_SCHEMA_REFRESH=verified-export to apply only the verified
 * export contract offline and regenerate the snapshot and client types together.
 */
const exportOnly = process.env.REWST_BUDDY_SCHEMA_REFRESH === 'verified-export';

/**
 * Applies the verified export overlay to the committed snapshot and stages it
 * as a temp .graphql file so codegen loads a path string (offline).
 */
function verifiedExportSchemaPath(): string {
	const snapshot = readFileSync('packages/mcp-server/src/sessions/graphql/schema.graphql', 'utf8');
	const schema = buildASTSchema(applyVerifiedExportContract(parse(snapshot)));
	const file = join(mkdtempSync(join(tmpdir(), 'rewst-buddy-schema-')), 'schema.graphql');
	writeFileSync(file, printSchema(schema));
	return file;
}

const config: CodegenConfig = {
	...(exportOnly ? offlineCodegen : {}),
	schema: exportOnly ? verifiedExportSchemaPath() : 'https://api.rewst.io/graphql',
	generates: {
		...(exportOnly ? offlineCodegen.generates : {}),
		'packages/mcp-server/src/sessions/graphql/schema.graphql': {
			plugins: ['schema-ast'],
		},
	},
};

export default config;
