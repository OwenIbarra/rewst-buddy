import { invoke } from './operations';
import type { CrateDetail, UnpackSuccess } from '../crates/crateUnpack';
import type { WorkflowExportResult } from '../../packages/mcp-server/src/capabilities/workflowExportCapability';
import type { ExportCatalogRow } from '../../packages/mcp-server/src/editorData';

export type { ExportCatalogRow } from '../../packages/mcp-server/src/editorData';

export interface EditorDataInvokeOptions {
	onEvent?: (event: unknown) => void;
	signal?: AbortSignal;
}

export interface JinjaFilterDoc {
	name: string;
	signature?: string;
	documentation: string;
}

export interface JinjaRenderResult {
	ok: boolean;
	value?: unknown;
	jinjaError?: string;
	hasControlCharacter?: boolean;
}

export interface PreviewWorkflowRow {
	id?: string | null;
	name?: string | null;
	orgId?: string | null;
	createdAt?: string | null;
	updatedAt?: string | null;
	tags?: { id?: string | null; name?: string | null }[] | null;
}

export type ExportWorkflowRow = PreviewWorkflowRow;

export type ExportTemplateRow = ExportCatalogRow;

export interface PreviewExecutionRow {
	id?: string | null;
	status?: string | null;
	createdAt?: string | null;
	numSuccessfulTasks?: number | null;
	orgId?: string | null;
	originatingExecutionId?: string | null;
	parentExecutionId?: string | null;
}

export interface CrateListRow {
	id?: string | null;
	name?: string | null;
	category?: string | null;
	description?: string | null;
	isUnpackedForSelectedOrg?: boolean | null;
}

export type ExportFormRow = ExportCatalogRow;

export interface EditorObjectExportResult {
	status: 'saved';
	orgId: string;
	objectType: 'template' | 'form';
	objectIds: string[];
	recommendedFilename?: string;
	outputPath: string | null;
	bytes?: number;
	version?: unknown;
	exportedAt?: unknown;
	objectCount?: number;
	signingPresent?: boolean;
}

function call<T>(operation: string, input: Record<string, unknown>, options?: EditorDataInvokeOptions): Promise<T> {
	return invoke<T>(operation, input, options);
}

export const editorDataClient = {
	renderJinja(
		input: { sessionId: string; orgId: string; template: string; vars: Record<string, unknown> },
		options?: EditorDataInvokeOptions,
	) {
		return call<JinjaRenderResult>('jinja.render', input, options);
	},
	getJinjaFilters(input: { sessionId: string }, options?: EditorDataInvokeOptions) {
		return call<JinjaFilterDoc[]>('jinja.filters', input, options);
	},
	listPreviewWorkflows(input: { sessionId: string; orgId: string }, options?: EditorDataInvokeOptions) {
		return call<PreviewWorkflowRow[]>('preview.workflows', input, options);
	},
	listPreviewExecutions(
		input: { sessionId: string; orgId: string; workflowId: string },
		options?: EditorDataInvokeOptions,
	) {
		return call<PreviewExecutionRow[]>('preview.executions', input, options);
	},
	getPreviewContext(
		input: { sessionId: string; orgId: string; executionId: string },
		options?: EditorDataInvokeOptions,
	) {
		return call<Record<string, unknown>>('preview.context', input, options);
	},
	listExportWorkflows(input: { sessionId: string; orgId: string }, options?: EditorDataInvokeOptions) {
		return call<ExportWorkflowRow[]>('workflows.export.catalog', input, options);
	},
	getWorkflowExportDefaultDirectory(options?: EditorDataInvokeOptions) {
		return call<string>('workflows.export.defaultDirectory', {}, options);
	},
	exportWorkflows(
		input: { sessionId: string; orgId: string; workflowIds: string[]; outputPath?: string },
		options?: EditorDataInvokeOptions,
	) {
		return call<WorkflowExportResult>('workflows.export.run', input, options);
	},
	listCrates(input: { sessionId: string; orgId: string }, options?: EditorDataInvokeOptions) {
		return call<CrateListRow[]>('crates.list', input, options);
	},
	getCrateDetail(input: { sessionId: string; orgId: string; crateId: string }, options?: EditorDataInvokeOptions) {
		return call<CrateDetail | null>('crates.detail', input, options);
	},
	listExportForms(input: { sessionId: string; orgId: string }, options?: EditorDataInvokeOptions) {
		return call<ExportFormRow[]>('exports.forms.list', input, options);
	},
	listExportTemplates(input: { sessionId: string; orgId: string }, options?: EditorDataInvokeOptions) {
		return call<ExportTemplateRow[]>('exports.templates.list', input, options);
	},
	exportObjects(
		input: {
			sessionId: string;
			orgId: string;
			objectType: 'template' | 'form';
			objectIds: string[];
			outputPath?: string;
		},
		options?: EditorDataInvokeOptions,
	) {
		return call<EditorObjectExportResult>('exports.objects.run', input, options);
	},
	runExportCapability(
		input: {
			sessionId: string;
			orgId: string;
			name: 'buddy_export_templates' | 'buddy_export_forms';
			arguments: Record<string, unknown>;
		},
		options?: EditorDataInvokeOptions,
	) {
		return call<string>('exports.run', input, options);
	},
	unpackCrate(
		input: {
			sessionId: string;
			orgId: string;
			crateId: string;
			workflowName?: string;
			tokenValues: Record<string, string | string[]>;
			enableTriggers: boolean;
		},
		options?: EditorDataInvokeOptions,
	) {
		const streamId = createStreamId();
		const onEvent = options?.onEvent;
		return call<UnpackSuccess>(
			'crates.unpack',
			{ ...input, streamId },
			onEvent
				? {
						...options,
						onEvent: event => {
							if (
								event &&
								typeof event === 'object' &&
								(event as { streamId?: unknown }).streamId === streamId
							) {
								onEvent(event);
							}
						},
					}
				: options,
		);
	},
};

export type EditorDataClient = typeof editorDataClient;

function createStreamId(): string {
	const randomUUID = globalThis.crypto?.randomUUID;
	if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
	return `crate-unpack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
