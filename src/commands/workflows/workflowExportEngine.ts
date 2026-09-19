import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { WorkflowExportResult } from '../../../packages/mcp-server/src/capabilities/workflowExportCapability';

/** Rewst's export operation accepts at most this many workflow ids per call. */
export const MAX_WORKFLOW_EXPORT_BATCH_SIZE = 25;

export interface ExportWorkflowChoice {
	id: string;
	name: string;
	orgId: string;
	orgName: string;
	createdAt?: string | null;
	updatedAt?: string | null;
	tags?: { id?: string | null; name?: string | null }[] | null;
}

export type WorkflowExportMode = 'bundle' | 'separate';

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
type ProgressReporter = (message: string, increment?: number) => void;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function batches<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/** Runs every selected export while keeping each backend request within Rewst's limit. */
export async function runWorkflowExports(
	workflows: readonly ExportWorkflowChoice[],
	mode: WorkflowExportMode,
	exporter: Exporter,
	signal: AbortSignal,
	report: ProgressReporter = () => {},
): Promise<WorkflowExportFlowResult> {
	if (workflows.length === 0) return { results: [], failures: [], cancelled: false };

	if (mode === 'bundle') {
		const workflowBatches = batches(workflows, MAX_WORKFLOW_EXPORT_BATCH_SIZE);
		const results: WorkflowExportResult[] = [];
		const failures: WorkflowExportFailure[] = [];
		for (const [index, workflowBatch] of workflowBatches.entries()) {
			if (signal.aborted) return { results, failures, cancelled: true };
			const batchLabel = workflowBatches.length === 1 ? '' : ` batch ${index + 1}/${workflowBatches.length}`;
			report(`Bundling${batchLabel} ${workflowBatch.length} workflow${workflowBatch.length === 1 ? '' : 's'}…`);
			try {
				results.push(
					await exporter(
						workflowBatch.map(workflow => workflow.id),
						index,
						workflowBatches.length,
					),
				);
			} catch (error) {
				if (signal.aborted) return { results, failures, cancelled: true };
				failures.push({
					workflowIds: workflowBatch.map(workflow => workflow.id),
					message: errorMessage(error),
				});
			}
			report(
				`${Math.min((index + 1) * MAX_WORKFLOW_EXPORT_BATCH_SIZE, workflows.length)} of ${workflows.length} complete`,
				(100 * workflowBatch.length) / workflows.length,
			);
		}
		return { results, failures, cancelled: false };
	}

	const results: WorkflowExportResult[] = [];
	const failures: WorkflowExportFailure[] = [];
	const increment = 100 / workflows.length;
	for (const [index, workflow] of workflows.entries()) {
		if (signal.aborted) return { results, failures, cancelled: true };
		report(`Exporting ${workflow.name} (${index + 1}/${workflows.length})…`);
		try {
			results.push(await exporter([workflow.id], index, workflows.length));
		} catch (error) {
			if (signal.aborted) return { results, failures, cancelled: true };
			failures.push({ workflow, message: errorMessage(error) });
		}
		report(`${index + 1} of ${workflows.length} complete`, increment);
	}
	return { results, failures, cancelled: false };
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Produces one portable path segment while retaining readable workflow names. */
export function sanitizeWorkflowFilenamePart(value: string, maxLength = 150): string {
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
	if (!safe || safe === '.' || safe === '..') safe = 'workflow';
	if (WINDOWS_RESERVED_NAME.test(safe)) safe = `_${safe}`;
	return safe.slice(0, maxLength).replace(/[. ]+$/g, '') || 'workflow';
}

/** Names separate exports by id or, when opted in, by readable name plus a collision-safe workflow id. */
export function separateWorkflowExportFilename(
	workflow: Pick<ExportWorkflowChoice, 'id' | 'name'>,
	useWorkflowNames: boolean,
): string {
	const id = sanitizeWorkflowFilenamePart(workflow.id, 80);
	if (!useWorkflowNames) return `rewst-workflow-${id}.json`;
	return `${sanitizeWorkflowFilenamePart(workflow.name)}--${id}.json`;
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
	if (destination.kind === 'file') return destination.outputPath;
	const directory = destination.outputPath ?? defaultDirectory;
	if (mode === 'bundle') {
		return join(
			directory,
			`rewst-workflows-batch-${String(batchIndex + 1).padStart(3, '0')}-of-${String(batchCount).padStart(3, '0')}.json`,
		);
	}
	const workflow = workflows[0] ?? { id: 'workflow', name: 'workflow' };
	return join(directory, separateWorkflowExportFilename(workflow, useWorkflowNames));
}

type PathExists = (path: string) => Promise<boolean>;

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
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
	const outputPath = workflowExportOutputPath(
		destination,
		defaultDirectory,
		mode,
		workflows,
		batchIndex,
		batchCount,
		useWorkflowNames,
	);
	if (!outputPath || destination.kind === 'file' || !(await exists(outputPath))) return outputPath;

	const extension = extname(outputPath);
	const stem = outputPath.slice(0, -extension.length);
	for (let suffix = 2; ; suffix++) {
		const candidate = `${stem}-${suffix}${extension}`;
		if (!(await exists(candidate))) return candidate;
	}
}
