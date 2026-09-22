import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { runExportObjects, type ExportTransportOptions } from '../export/exportClient';
import {
	DEFAULT_EXPORT_INACTIVITY_TIMEOUT_MS,
	MAX_EXPORT_INACTIVITY_TIMEOUT_MS,
	MIN_EXPORT_INACTIVITY_TIMEOUT_MS,
	redactExportError,
	type ExportBundle,
	type ExportObjectsSuccess,
} from '../export/exportObjects';
import { LocalExportStorage, ensureDefaultExportDir, type ExportStorage } from '../export/exportStorage';
import { toCookieHeader } from '../sessions/graphqlWsTransport';
import type { ToolSpecDefinition } from '../tools/toolProtocol';
import type { Capability, CapabilityContext } from './Capability';
import { readCapability } from './capabilityFactories';
import { json, ORG_ID_FIELD, parseCapabilityInput, rawGraphqlOrThrow, toInputSchema } from './inputHelpers';

export type SupportedExportObjectType = 'workflow' | 'template' | 'form';

type ExportTransport = (options: ExportTransportOptions) => Promise<ExportObjectsSuccess>;

export interface ObjectExportDependencies {
	transport?: ExportTransport;
	storage?: ExportStorage;
	defaultDir?: () => Promise<string>;
}

export interface ObjectExportCapabilityConfig {
	toolName: string;
	objectType: SupportedExportObjectType;
	objectLabel: string;
	objectsLabel: string;
	idsField: `${string}Ids`;
	ownerQuery: string;
	ownerResponseField: string;
	description: string;
	maxObjects: number;
}

interface ExportOwner {
	id?: unknown;
	name?: unknown;
	orgId?: unknown;
}

interface ParsedExportInput {
	orgId: string;
	outputPath?: string;
	overwrite: false;
	includeBundle: boolean;
	timeoutMs: number;
	[key: string]: unknown;
}

function bundleObjectCount(bundle: ExportBundle): number {
	if (Array.isArray(bundle.objects)) return bundle.objects.length;
	if (bundle.objects && typeof bundle.objects === 'object') return Object.keys(bundle.objects).length;
	return 0;
}

function signingPresent(bundle: ExportBundle): boolean {
	return bundle.signing !== null && bundle.signing !== undefined;
}

function uniqueIds(ids: readonly string[]): string[] {
	return [...new Set(ids.map(id => id.trim()))];
}

/** Builds one signed-export capability while keeping transport, storage, and result behavior identical across types. */
export function createObjectExportCapability(config: ObjectExportCapabilityConfig): {
	capability: Capability;
	setDependenciesForTesting: (dependencies?: ObjectExportDependencies) => void;
} {
	let exportTransport: ExportTransport = runExportObjects;
	let exportStorage: ExportStorage = new LocalExportStorage();
	let defaultExportDir: () => Promise<string> = ensureDefaultExportDir;
	const operationName = `${config.objectLabel} export`;

	const inputSchema = z.object({
		orgId: ORG_ID_FIELD,
		[config.idsField]: z
			.array(
				z
					.string()
					.trim()
					.min(1, { error: `${config.idsField} cannot contain empty ids.` }),
				{
					error: `"${config.idsField}" must be a non-empty array of ${config.objectType} id strings.`,
				},
			)
			.min(1, { error: `"${config.idsField}" must contain at least one ${config.objectType} id.` })
			.max(config.maxObjects, {
				error: `"${config.idsField}" must contain at most ${config.maxObjects} ${config.objectType} ids.`,
			})
			.describe(
				`One or more ${config.objectType} ids to export, up to ${config.maxObjects}. Values are trimmed and duplicates are removed.`,
			),
		outputPath: z
			.string()
			.trim()
			.min(1)
			.refine(isAbsolute, { error: '"outputPath" must be an absolute file or directory path.' })
			.optional()
			.describe(
				'Optional absolute local file path or existing directory. When omitted the bundle is saved to the default export directory instead of only returning inline.',
			),
		overwrite: z
			.literal(false, {
				error: `${config.toolName} is read-only and cannot overwrite an existing local file; choose a new outputPath.`,
			})
			.optional()
			.default(false)
			.describe('Must remain false. This read capability never replaces an existing local file.'),
		includeBundle: z
			.boolean()
			.optional()
			.default(false)
			.describe('Include the full bundle in the result when outputPath is supplied.'),
		timeoutMs: z
			.number()
			.int()
			.min(MIN_EXPORT_INACTIVITY_TIMEOUT_MS)
			.max(MAX_EXPORT_INACTIVITY_TIMEOUT_MS)
			.optional()
			.default(DEFAULT_EXPORT_INACTIVITY_TIMEOUT_MS)
			.describe(
				`WebSocket stream inactivity timeout in milliseconds (${MIN_EXPORT_INACTIVITY_TIMEOUT_MS}-${MAX_EXPORT_INACTIVITY_TIMEOUT_MS}); resets on every stream event.`,
			),
	});

	function throwIfCancelled(signal?: AbortSignal): void {
		if (signal?.aborted) throw new Error(`${operationName} was cancelled.`);
	}

	async function validateOwners(
		ids: readonly string[],
		orgId: string,
		ctx: CapabilityContext,
		redactionSecrets: readonly string[],
	): Promise<void> {
		for (const id of ids) {
			throwIfCancelled(ctx.signal);
			let data: unknown;
			try {
				data = await rawGraphqlOrThrow(ctx.session, config.ownerQuery, { id }, { signal: ctx.signal });
			} catch (error) {
				throwIfCancelled(ctx.signal);
				throw new Error(redactExportError(error, redactionSecrets));
			}
			throwIfCancelled(ctx.signal);
			const owner = (data as Record<string, ExportOwner | null> | null | undefined)?.[config.ownerResponseField];
			if (!owner || owner.id !== id || owner.orgId !== orgId) {
				throw new Error(`${config.objectLabel} ${id} was not found in org ${orgId}.`);
			}
		}
	}

	async function run(input: Record<string, unknown>, ctx: CapabilityContext): Promise<string> {
		throwIfCancelled(ctx.signal);
		const parsed = parseCapabilityInput(inputSchema, input) as ParsedExportInput;
		const ids = uniqueIds(parsed[config.idsField] as string[]);
		const storedCookie = await ctx.session.getCookies();
		throwIfCancelled(ctx.signal);
		const cookieHeader = toCookieHeader(storedCookie, ctx.session.profile.region);
		const redactionSecrets = storedCookie === cookieHeader ? [cookieHeader] : [storedCookie, cookieHeader];

		// Every id is checked over HTTP before the websocket is created. Unknown
		// and cross-organization resources therefore fail closed.
		await validateOwners(ids, parsed.orgId, ctx, redactionSecrets);
		throwIfCancelled(ctx.signal);

		const transportOptions: ExportTransportOptions = {
			session: ctx.session,
			inactivityTimeoutMs: parsed.timeoutMs,
			signal: ctx.signal,
		};
		// Preserve the established internal workflow transport shape. New object
		// types use the generic request list that drives subscription variables.
		if (config.objectType === 'workflow') {
			transportOptions.workflowIds = ids;
		} else {
			transportOptions.objects = ids.map(id => ({ type: config.objectType, id }));
			transportOptions.operationName = operationName;
			transportOptions.fallbackFilename = `rewst-${config.objectsLabel}-export.json`;
		}
		const outcome = await exportTransport(transportOptions);
		throwIfCancelled(ctx.signal);

		const contents = JSON.stringify(outcome.bundle, null, 2);
		const bundleBytes = Buffer.byteLength(contents, 'utf8');
		const destination = parsed.outputPath ?? (await defaultExportDir());
		throwIfCancelled(ctx.signal);
		const saved = await exportStorage.save({
			outputPath: destination,
			recommendedFilename: outcome.recommendedFilename,
			contents,
			overwrite: false,
			signal: ctx.signal,
			...(config.objectType === 'workflow' ? {} : { operationName }),
		});
		throwIfCancelled(ctx.signal);

		const result: Record<string, unknown> = {
			status: 'saved',
			orgId: parsed.orgId,
			[config.idsField]: ids,
			recommendedFilename: outcome.recommendedFilename,
			outputPath: saved?.outputPath ?? null,
			bytes: saved?.bytes ?? bundleBytes,
			version: outcome.bundle.version,
			exportedAt: outcome.bundle.exportedAt,
			objectCount: bundleObjectCount(outcome.bundle),
			signingPresent: signingPresent(outcome.bundle),
		};
		if (parsed.outputPath === undefined || parsed.includeBundle) result.bundle = outcome.bundle;
		return json(result);
	}

	const spec: ToolSpecDefinition = {
		name: config.toolName,
		description: config.description,
		inputSchema: toInputSchema(inputSchema),
	};

	return {
		capability: readCapability(spec, run),
		setDependenciesForTesting: dependencies => {
			exportTransport = dependencies?.transport ?? runExportObjects;
			exportStorage = dependencies?.storage ?? new LocalExportStorage();
			defaultExportDir = dependencies?.defaultDir ?? ensureDefaultExportDir;
		},
	};
}
