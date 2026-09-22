import { stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path';
import type { WorkflowExportResult } from '../../../packages/mcp-server/src/capabilities/workflowExportCapability';

/** Rewst's export operation accepts at most this many workflow ids per call. */
export const MAX_WORKFLOW_EXPORT_BATCH_SIZE = 25;
export const MAX_EXPORT_FILENAME_SUFFIX = 1000;
/** Maximum UTF-8 bytes for a portable filesystem path segment. */
export const MAX_EXPORT_FILENAME_BYTES = 255;
/** Compatibility alias retained for sidebar-era workflow exporter callers. */
export const MAX_WORKFLOW_EXPORT_FILENAME_BYTES = MAX_EXPORT_FILENAME_BYTES;

export type ExporterObjectType = 'workflow' | 'template' | 'form';

export interface ExportCatalogItem {
	id: string;
	name: string;
	orgId: string;
	orgName: string;
	createdAt?: string | null;
	updatedAt?: string | null;
	tags?: { id?: string | null; name?: string | null }[] | null;
}

/** Compatibility name retained for workflow command and provider callers. */
export type ExportWorkflowChoice = ExportCatalogItem;

export type ExportMode = 'bundle' | 'separate';
/** Compatibility name retained for the workflow exporter interface. */
export type WorkflowExportMode = ExportMode;

export interface CatalogExportFailure {
	item?: ExportCatalogItem;
	objectIds?: string[];
	message: string;
}

export interface CatalogExportResult<TResult> {
	objectIds: string[];
	result: TResult;
}

export interface CatalogExportFlowResult<TResult> {
	results: CatalogExportResult<TResult>[];
	failures: CatalogExportFailure[];
	cancelled: boolean;
}

export interface WorkflowExportFailure {
	workflow?: ExportWorkflowChoice;
	workflowIds?: string[];
	message: string;
}

export interface WorkflowExportFlowResult {
	results: WorkflowExportResult[];
	failures: WorkflowExportFailure[];
	cancelled: boolean;
}

export interface WorkflowExportDestination {
	outputPath?: string;
	kind: 'directory' | 'file';
}

type Exporter = (workflowIds: string[], batchIndex: number, batchCount: number) => Promise<WorkflowExportResult>;
type CatalogExporter<TResult> = (objectIds: string[], batchIndex: number, batchCount: number) => Promise<TResult>;
type ProgressReporter = (message: string, increment?: number) => void;

const OBJECT_LABELS: Record<ExporterObjectType, { singular: string; plural: string }> = {
	workflow: { singular: 'workflow', plural: 'workflows' },
	template: { singular: 'template', plural: 'templates' },
	form: { singular: 'form', plural: 'forms' },
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function batches<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/**
 * Shared execution loop for every catalog-backed exporter. The workflow
 * wrapper below preserves its historical result and failure shapes.
 */
export async function runCatalogExports<TResult>(
	objects: readonly ExportCatalogItem[],
	objectType: ExporterObjectType,
	mode: ExportMode,
	exporter: CatalogExporter<TResult>,
	signal: AbortSignal,
	report: ProgressReporter = () => {},
	batchSize = MAX_WORKFLOW_EXPORT_BATCH_SIZE,
): Promise<CatalogExportFlowResult<TResult>> {
	if (objects.length === 0) return { results: [], failures: [], cancelled: false };
	const labels = OBJECT_LABELS[objectType];

	if (mode === 'bundle') {
		const objectBatches = batches(objects, batchSize);
		const results: CatalogExportResult<TResult>[] = [];
		const failures: CatalogExportFailure[] = [];
		for (const [index, objectBatch] of objectBatches.entries()) {
			if (signal.aborted) return { results, failures, cancelled: true };
			const batchLabel = objectBatches.length === 1 ? '' : ` batch ${index + 1}/${objectBatches.length}`;
			report(
				`Bundling${batchLabel} ${objectBatch.length} ${objectBatch.length === 1 ? labels.singular : labels.plural}…`,
			);
			const objectIds = objectBatch.map(object => object.id);
			try {
				results.push({ objectIds, result: await exporter(objectIds, index, objectBatches.length) });
			} catch (error) {
				if (signal.aborted) return { results, failures, cancelled: true };
				failures.push({ objectIds, message: errorMessage(error) });
			}
			report(
				`${Math.min((index + 1) * batchSize, objects.length)} of ${objects.length} complete`,
				(100 * objectBatch.length) / objects.length,
			);
		}
		return { results, failures, cancelled: false };
	}

	const results: CatalogExportResult<TResult>[] = [];
	const failures: CatalogExportFailure[] = [];
	const increment = 100 / objects.length;
	for (const [index, object] of objects.entries()) {
		if (signal.aborted) return { results, failures, cancelled: true };
		report(`Exporting ${object.name} (${index + 1}/${objects.length})…`);
		try {
			results.push({ objectIds: [object.id], result: await exporter([object.id], index, objects.length) });
		} catch (error) {
			if (signal.aborted) return { results, failures, cancelled: true };
			failures.push({ item: object, message: errorMessage(error) });
		}
		report(`${index + 1} of ${objects.length} complete`, increment);
	}
	return { results, failures, cancelled: false };
}

/** Runs every selected export while keeping each backend request within Rewst's limit. */
export async function runWorkflowExports(
	workflows: readonly ExportWorkflowChoice[],
	mode: WorkflowExportMode,
	exporter: Exporter,
	signal: AbortSignal,
	report: ProgressReporter = () => {},
): Promise<WorkflowExportFlowResult> {
	const outcome = await runCatalogExports(
		workflows,
		'workflow',
		mode,
		exporter,
		signal,
		report,
		MAX_WORKFLOW_EXPORT_BATCH_SIZE,
	);
	return {
		results: outcome.results.map(result => result.result),
		failures: outcome.failures.map(failure => ({
			...(failure.item ? { workflow: failure.item } : {}),
			...(failure.objectIds ? { workflowIds: failure.objectIds } : {}),
			message: failure.message,
		})),
		cancelled: outcome.cancelled,
	};
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function truncateByUtf8Bytes(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return '';
	if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
	let result = '';
	let usedBytes = 0;
	for (const character of value) {
		const bytes = Buffer.byteLength(character, 'utf8');
		if (usedBytes + bytes > maxBytes) break;
		result += character;
		usedBytes += bytes;
	}
	return result;
}

function fitFilenamePart(value: string, maxBytes: number, fallback: string): string {
	const fitted = truncateByUtf8Bytes(value, maxBytes).replace(/[. ]+$/g, '');
	if (fitted) return fitted;
	return truncateByUtf8Bytes(fallback, maxBytes).replace(/[. ]+$/g, '') || 'x';
}

/** Produces one portable path segment while retaining readable workflow names. */
export function sanitizeWorkflowFilenamePart(value: string, maxLength = 150): string {
	return sanitizeExportFilenamePart(value, 'workflow', maxLength);
}

export function sanitizeExportFilenamePart(value: string, fallback: string, maxLength = 150): string {
	let safe = [...value.normalize('NFKC')]
		.filter(character => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint > 0x1f && codePoint !== 0x7f;
		})
		.join('')
		.replace(/[<>:"/\\|?*]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/-+/g, '-')
		.trim()
		.replace(/^[. ]+|[. ]+$/g, '');
	if (!safe || safe === '.' || safe === '..') safe = fallback;
	if (WINDOWS_RESERVED_NAME.test(safe)) safe = `_${safe}`;
	return (
		[...safe]
			.slice(0, maxLength)
			.join('')
			.replace(/[. ]+$/g, '') || fallback
	);
}

/** Names separate exports by id or, when opted in, by readable name plus a collision-safe workflow id. */
export function separateWorkflowExportFilename(
	workflow: Pick<ExportWorkflowChoice, 'id' | 'name'>,
	useWorkflowNames: boolean,
): string {
	return separateExportFilename(workflow, 'workflow', useWorkflowNames);
}

export function separateExportFilename(
	object: Pick<ExportCatalogItem, 'id' | 'name'>,
	objectType: ExporterObjectType,
	useObjectNames: boolean,
): string {
	const extension = '.json';
	const prefix = `rewst-${objectType}-`;
	const separator = '--';
	const sanitizedId = sanitizeExportFilenamePart(object.id, objectType, 80);
	if (!useObjectNames) {
		const id = fitFilenamePart(
			sanitizedId,
			MAX_EXPORT_FILENAME_BYTES - Buffer.byteLength(`${prefix}${extension}`, 'utf8'),
			objectType,
		);
		return `${prefix}${id}${extension}`;
	}
	const id = fitFilenamePart(
		sanitizedId,
		MAX_EXPORT_FILENAME_BYTES - Buffer.byteLength(`${objectType}${separator}${extension}`, 'utf8'),
		objectType,
	);
	const name = fitFilenamePart(
		sanitizeExportFilenamePart(object.name, objectType),
		MAX_EXPORT_FILENAME_BYTES - Buffer.byteLength(`${separator}${id}${extension}`, 'utf8'),
		objectType,
	);
	return `${name}${separator}${id}${extension}`;
}

export function workflowExportOutputPath(
	destination: WorkflowExportDestination,
	defaultDirectory: string,
	mode: WorkflowExportMode,
	workflows: readonly Pick<ExportWorkflowChoice, 'id' | 'name'>[],
	batchIndex: number,
	batchCount: number,
	useWorkflowNames = false,
): string | undefined {
	return exportOutputPath(
		destination,
		defaultDirectory,
		'workflow',
		mode,
		workflows,
		batchIndex,
		batchCount,
		useWorkflowNames,
	);
}

export function exportOutputPath(
	destination: WorkflowExportDestination,
	defaultDirectory: string,
	objectType: ExporterObjectType,
	mode: ExportMode,
	objects: readonly Pick<ExportCatalogItem, 'id' | 'name'>[],
	batchIndex: number,
	batchCount: number,
	useObjectNames = false,
): string | undefined {
	if (destination.kind === 'file') return destination.outputPath;
	const directory = destination.outputPath ?? defaultDirectory;
	if (mode === 'bundle') {
		return join(
			directory,
			`rewst-${OBJECT_LABELS[objectType].plural}-batch-${String(batchIndex + 1).padStart(3, '0')}-of-${String(batchCount).padStart(3, '0')}.json`,
		);
	}
	const object = objects[0] ?? { id: objectType, name: objectType };
	return join(directory, separateExportFilename(object, objectType, useObjectNames));
}

type PathExists = (path: string) => Promise<boolean>;

export async function pathExists(path: string, statPath: (path: string) => Promise<unknown> = stat): Promise<boolean> {
	try {
		await statPath(path);
		return true;
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * Keeps the established directory-export filename when available and otherwise
 * chooses the first deterministic numeric suffix. Explicit file destinations
 * are validated by the picker and remain verbatim.
 */
export async function resolveWorkflowExportOutputPath(
	destination: WorkflowExportDestination,
	defaultDirectory: string,
	mode: WorkflowExportMode,
	workflows: readonly Pick<ExportWorkflowChoice, 'id' | 'name'>[],
	batchIndex: number,
	batchCount: number,
	useWorkflowNames = false,
	exists: PathExists = pathExists,
): Promise<string | undefined> {
	return resolveExportOutputPath(
		destination,
		defaultDirectory,
		'workflow',
		mode,
		workflows,
		batchIndex,
		batchCount,
		useWorkflowNames,
		exists,
	);
}

export async function resolveExportOutputPath(
	destination: WorkflowExportDestination,
	defaultDirectory: string,
	objectType: ExporterObjectType,
	mode: ExportMode,
	objects: readonly Pick<ExportCatalogItem, 'id' | 'name'>[],
	batchIndex: number,
	batchCount: number,
	useObjectNames = false,
	exists: PathExists = pathExists,
): Promise<string | undefined> {
	const outputPath = exportOutputPath(
		destination,
		defaultDirectory,
		objectType,
		mode,
		objects,
		batchIndex,
		batchCount,
		useObjectNames,
	);
	if (!outputPath || destination.kind === 'file' || !(await exists(outputPath))) return outputPath;

	const directory = dirname(outputPath);
	const extension = extname(outputPath);
	const filename = basename(outputPath);
	const stem = filename.slice(0, filename.length - extension.length);
	for (let suffix = 2; suffix <= MAX_EXPORT_FILENAME_SUFFIX; suffix++) {
		const suffixText = `-${suffix}`;
		const fittedStem = fitFilenamePart(
			stem,
			MAX_EXPORT_FILENAME_BYTES - Buffer.byteLength(`${suffixText}${extension}`, 'utf8'),
			objectType,
		);
		const candidate = join(directory, `${fittedStem}${suffixText}${extension}`);
		if (!(await exists(candidate))) return candidate;
	}
	throw new Error(`No available export filename for ${outputPath} after suffix ${MAX_EXPORT_FILENAME_SUFFIX}.`);
}

export interface ExportPathRequest {
	destination: WorkflowExportDestination;
	defaultDirectory: string;
	objectType: ExporterObjectType;
	mode: ExportMode;
	objects: readonly Pick<ExportCatalogItem, 'id' | 'name'>[];
	batchIndex: number;
	batchCount: number;
	useObjectNames?: boolean;
}

const directoryExportQueues = new Map<string, Promise<void>>();

function serializeDirectoryExport<T>(directory: string, operation: () => Promise<T>): Promise<T> {
	const key = resolvePath(directory);
	const previous = directoryExportQueues.get(key) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	directoryExportQueues.set(key, settled);
	void settled.then(() => {
		if (directoryExportQueues.get(key) === settled) directoryExportQueues.delete(key);
	});
	return result;
}

/** Serializes path selection and publication for every exporter sharing a directory. */
export async function exportBatchToAvailablePath<T>(
	request: ExportPathRequest,
	exporter: (outputPath: string | undefined) => Promise<T>,
	exists: PathExists = pathExists,
): Promise<T> {
	const run = async (): Promise<T> => {
		const outputPath = await resolveExportOutputPath(
			request.destination,
			request.defaultDirectory,
			request.objectType,
			request.mode,
			request.objects,
			request.batchIndex,
			request.batchCount,
			request.useObjectNames,
			exists,
		);
		return exporter(outputPath);
	};
	if (request.destination.kind === 'file') return run();
	return serializeDirectoryExport(request.destination.outputPath ?? request.defaultDirectory, run);
}

export interface WorkflowExportPathRequest {
	destination: WorkflowExportDestination;
	defaultDirectory: string;
	mode: WorkflowExportMode;
	workflows: readonly Pick<ExportWorkflowChoice, 'id' | 'name'>[];
	batchIndex: number;
	batchCount: number;
	useWorkflowNames?: boolean;
}

export function exportWorkflowBatchToAvailablePath<T>(
	request: WorkflowExportPathRequest,
	exporter: (outputPath: string | undefined) => Promise<T>,
	exists: PathExists = pathExists,
): Promise<T> {
	return exportBatchToAvailablePath(
		{
			destination: request.destination,
			defaultDirectory: request.defaultDirectory,
			objectType: 'workflow',
			mode: request.mode,
			objects: request.workflows,
			batchIndex: request.batchIndex,
			batchCount: request.batchCount,
			useObjectNames: request.useWorkflowNames,
		},
		exporter,
		exists,
	);
}
