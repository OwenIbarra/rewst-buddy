import { randomBytes } from 'node:crypto';
import { SessionManager, type Session } from '@sessions';
import { log } from '@utils';
import vscode from 'vscode';
import { editorDataClient } from '../../backend/editorDataClient';
import {
	MAX_WORKFLOW_EXPORT_BATCH_SIZE,
	exportBatchToAvailablePath,
	pathExists,
	runCatalogExports,
	type ExportCatalogItem,
	type ExporterObjectType as EngineExporterObjectType,
	type WorkflowExportDestination,
	type ExportMode,
} from '../../commands/workflows/workflowExportEngine';
import { WORKFLOW_EXPORT_BOOTSTRAP_PAYLOAD } from '../../../packages/mcp-server/src/capabilities/workflowExportCapability';
import {
	MAX_FORMS_PER_EXPORT,
	MAX_TEMPLATES_PER_EXPORT,
} from '../../../packages/mcp-server/src/capabilities/templateFormExportCapabilities';
import {
	EXPORT_CATALOG_FIELD_SUPPORT,
	exportTagOptions,
	filterExportCatalog,
	normalizeExportCatalog,
	parseExportCatalogFilters,
} from './workflowExportModel';

export type ExporterObjectType = EngineExporterObjectType;

const OBJECT_TYPE_DETAILS: Record<
	ExporterObjectType,
	{
		singular: string;
		plural: string;
		capability?: 'buddy_export_templates' | 'buddy_export_forms';
		maxPerExport: number;
	}
> = {
	workflow: { singular: 'workflow', plural: 'workflows', maxPerExport: MAX_WORKFLOW_EXPORT_BATCH_SIZE },
	template: {
		singular: 'template',
		plural: 'templates',
		capability: 'buddy_export_templates',
		maxPerExport: MAX_TEMPLATES_PER_EXPORT,
	},
	form: {
		singular: 'form',
		plural: 'forms',
		capability: 'buddy_export_forms',
		maxPerExport: MAX_FORMS_PER_EXPORT,
	},
};

function exporterObjectType(value: unknown, fallback?: ExporterObjectType): ExporterObjectType | undefined {
	if (value === undefined) return fallback;
	return value === 'workflow' || value === 'template' || value === 'form' ? value : undefined;
}

export interface WorkflowExportOrganization {
	id: string;
	name: string;
	sessionId: string;
}

function sessionIdFor(session: Session): string | undefined {
	return session.sessionId ?? session.profile.user.id ?? undefined;
}

export function workflowExportOrganizations(sessions: readonly Session[]): WorkflowExportOrganization[] {
	const result = new Map<string, WorkflowExportOrganization>();
	for (const session of sessions) {
		const sessionId = sessionIdFor(session);
		if (!sessionId) continue;
		for (const org of [session.profile.org, ...(session.profile.allManagedOrgs ?? [])]) {
			if (!org?.id || result.has(org.id)) continue;
			result.set(org.id, { id: org.id, name: org.name || org.id, sessionId });
		}
	}
	return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function messageRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export { pathExists as workflowExportTargetExists } from '../../commands/workflows/workflowExportEngine';

export class WorkflowExportViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'rewst-buddy.workflowExporter';

	private view?: vscode.WebviewView;
	private catalog: ExportCatalogItem[] = [];
	private catalogOrgId?: string;
	private catalogObjectType?: ExporterObjectType;
	private defaultDirectory?: string;
	private destination: WorkflowExportDestination = { kind: 'directory' };
	private catalogController?: AbortController;
	private exportController?: AbortController;
	private readonly knownOutputPaths = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(SessionManager.onSessionChange(() => void this.postOrganizations()));
	}

	dispose(): void {
		this.catalogController?.abort();
		this.exportController?.abort();
		for (const disposable of this.disposables.splice(0)) disposable.dispose();
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'workflow-exporter')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		this.disposables.push(webviewView.webview.onDidReceiveMessage(message => this.handleMessage(message)));
	}

	private async post(message: Record<string, unknown>): Promise<void> {
		await this.view?.webview.postMessage(message);
	}

	private organizations(): WorkflowExportOrganization[] {
		return workflowExportOrganizations(SessionManager.getActiveSessions());
	}

	private organization(orgId: unknown): WorkflowExportOrganization | undefined {
		return typeof orgId === 'string' ? this.organizations().find(org => org.id === orgId) : undefined;
	}

	private async postOrganizations(): Promise<void> {
		await this.post({ type: 'organizations', organizations: this.organizations() });
	}

	private async bootstrap(): Promise<void> {
		try {
			this.defaultDirectory ??= await editorDataClient.getWorkflowExportDefaultDirectory();
			await this.post({
				type: 'bootstrap',
				...WORKFLOW_EXPORT_BOOTSTRAP_PAYLOAD,
				organizations: this.organizations(),
				defaultDirectory: this.defaultDirectory,
				catalogOrgId: this.catalogOrgId ?? null,
			});
		} catch (error) {
			await this.post({
				type: 'error',
				message: `Unable to initialize Rewst Exporter: ${errorMessage(error)}`,
			});
		}
	}

	private async loadCatalog(orgId: unknown, requestedObjectType: unknown): Promise<void> {
		const org = this.organization(orgId);
		if (!org) {
			await this.post({ type: 'error', message: 'Choose an active Rewst organization.' });
			return;
		}
		const objectType = exporterObjectType(requestedObjectType, 'workflow');
		if (!objectType) {
			await this.post({ type: 'error', message: 'Choose a supported export object type.' });
			return;
		}
		this.catalogController?.abort();
		const controller = new AbortController();
		this.catalogController = controller;
		this.catalog = [];
		this.catalogOrgId = org.id;
		this.catalogObjectType = objectType;
		await this.post({ type: 'catalogLoading', orgId: org.id, objectType });
		try {
			const input = { sessionId: org.sessionId, orgId: org.id };
			const options = { signal: controller.signal };
			const rows =
				objectType === 'workflow'
					? await editorDataClient.listExportWorkflows(input, options)
					: objectType === 'template'
						? await editorDataClient.listExportTemplates(input, options)
						: await editorDataClient.listExportForms(input, options);
			if (controller.signal.aborted || this.catalogController !== controller) return;
			this.catalog = normalizeExportCatalog(rows, org);
			await this.post({
				type: 'catalogLoaded',
				orgId: org.id,
				objectType,
				objects: this.catalog,
				...(objectType === 'workflow' ? { workflows: this.catalog } : {}),
				tags: exportTagOptions(this.catalog),
				fieldSupport: EXPORT_CATALOG_FIELD_SUPPORT[objectType],
				maxObjectsPerExport: OBJECT_TYPE_DETAILS[objectType].maxPerExport,
			});
		} catch (error) {
			if (!controller.signal.aborted) {
				await this.post({
					type: 'error',
					objectType,
					orgId: org.id,
					message: `Unable to load ${OBJECT_TYPE_DETAILS[objectType].plural}: ${errorMessage(error)}`,
				});
			}
		} finally {
			if (this.catalogController === controller) this.catalogController = undefined;
		}
	}

	private async applyFilters(message: Record<string, unknown>): Promise<void> {
		const objectType = exporterObjectType(message.objectType, this.catalogObjectType);
		if (!objectType && message.objectType !== undefined) {
			await this.post({ type: 'error', message: 'Choose a supported export object type.' });
			return;
		}
		const orgId = typeof message.orgId === 'string' ? message.orgId : this.catalogOrgId;
		if (!objectType || objectType !== this.catalogObjectType || orgId !== this.catalogOrgId) return;
		const filters = parseExportCatalogFilters(message.filters);
		const objectIds = filterExportCatalog(this.catalog, filters, EXPORT_CATALOG_FIELD_SUPPORT[objectType]).map(
			object => object.id,
		);
		await this.post({
			type: 'filterResult',
			objectType,
			orgId: this.catalogOrgId,
			objectIds,
			...(objectType === 'workflow' ? { workflowIds: objectIds } : {}),
		});
	}

	private async chooseFolder(requestedObjectType: unknown): Promise<void> {
		const objectType = exporterObjectType(requestedObjectType, this.catalogObjectType ?? 'workflow');
		if (!objectType) {
			await this.post({ type: 'error', message: 'Choose a supported export object type.' });
			return;
		}
		this.defaultDirectory ??= await editorDataClient.getWorkflowExportDefaultDirectory();
		const selected = await vscode.window.showOpenDialog({
			defaultUri: vscode.Uri.file(this.destination.outputPath ?? this.defaultDirectory),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Export Here',
			title: `Choose ${OBJECT_TYPE_DETAILS[objectType].singular[0].toUpperCase()}${OBJECT_TYPE_DETAILS[objectType].singular.slice(1)} Export Folder`,
		});
		if (!selected?.[0]) return;
		this.destination = { kind: 'directory', outputPath: selected[0].fsPath };
		await this.post({ type: 'destination', kind: 'directory', path: selected[0].fsPath, isDefault: false });
	}

	private async chooseFile(objectCount: unknown, requestedObjectType: unknown): Promise<void> {
		const objectType = exporterObjectType(requestedObjectType, this.catalogObjectType ?? 'workflow');
		if (!objectType) {
			await this.post({ type: 'error', message: 'Choose a supported export object type.' });
			return;
		}
		const details = OBJECT_TYPE_DETAILS[objectType];
		if (typeof objectCount !== 'number' || objectCount < 1 || objectCount > details.maxPerExport) {
			await this.post({
				type: 'error',
				message: `A single bundle file supports 1-${details.maxPerExport} selected ${details.plural}.`,
			});
			return;
		}
		this.defaultDirectory ??= await editorDataClient.getWorkflowExportDefaultDirectory();
		const selected = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.joinPath(
				vscode.Uri.file(this.defaultDirectory),
				`rewst-${details.plural}-export.json`,
			),
			filters: { JSON: ['json'] },
			saveLabel: 'Export',
			title: `Choose ${details.singular[0].toUpperCase()}${details.singular.slice(1)} Export File`,
		});
		if (!selected) return;
		if (await pathExists(selected.fsPath)) {
			await this.post({
				type: 'error',
				message: `Choose a new file name; ${details.singular} exports never overwrite files.`,
			});
			return;
		}
		this.destination = { kind: 'file', outputPath: selected.fsPath };
		await this.post({ type: 'destination', kind: 'file', path: selected.fsPath, isDefault: false });
	}

	private async useDefaultDestination(): Promise<void> {
		this.defaultDirectory ??= await editorDataClient.getWorkflowExportDefaultDirectory();
		this.destination = { kind: 'directory' };
		await this.post({ type: 'destination', kind: 'directory', path: this.defaultDirectory, isDefault: true });
	}

	private async startExport(message: Record<string, unknown>): Promise<void> {
		const objectType = exporterObjectType(message.objectType, 'workflow');
		if (!objectType) {
			await this.post({ type: 'error', message: 'Choose a supported export object type.' });
			return;
		}
		const details = OBJECT_TYPE_DETAILS[objectType];
		if (this.exportController) {
			await this.post({ type: 'error', message: `A ${details.singular} export is already running.` });
			return;
		}
		const controller = new AbortController();
		this.exportController = controller;
		try {
			const org = this.organization(message.orgId);
			if (!org || this.catalogOrgId !== org.id || this.catalogObjectType !== objectType) {
				await this.post({ type: 'error', message: 'Reload the selected organization before exporting.' });
				return;
			}
			const suppliedIds = Array.isArray(message.objectIds) ? message.objectIds : message.workflowIds;
			const selectedIds = Array.isArray(suppliedIds)
				? [...new Set(suppliedIds.filter((id): id is string => typeof id === 'string'))]
				: [];
			const selectedSet = new Set(selectedIds);
			const objects = this.catalog.filter(object => selectedSet.has(object.id));
			if (objects.length === 0 || objects.length !== selectedIds.length) {
				await this.post({
					type: 'error',
					message: `Select at least one ${details.singular} from the current catalog.`,
				});
				return;
			}
			const mode: ExportMode = message.mode === 'separate' ? 'separate' : 'bundle';
			this.defaultDirectory ??= await editorDataClient.getWorkflowExportDefaultDirectory();
			let destination = this.destination;
			if (mode === 'separate' && destination.kind === 'file') {
				destination = { kind: 'directory' };
				this.destination = destination;
				await this.post({
					type: 'destination',
					kind: 'directory',
					path: this.defaultDirectory,
					isDefault: true,
				});
			}
			if (destination.kind === 'file' && objects.length > details.maxPerExport) {
				await this.post({
					type: 'error',
					message: 'Choose a folder for exports that require multiple bundle files.',
				});
				return;
			}
			let progressValue = 0;
			await this.post({
				type: 'exportStarted',
				objectType,
				objectCount: objects.length,
				...(objectType === 'workflow' ? { workflowCount: objects.length } : {}),
				mode,
			});
			const objectsById = new Map(objects.map(object => [object.id, object]));
			const outcome = await runCatalogExports(
				objects,
				objectType,
				mode,
				async (objectIds, batchIndex, batchCount) => {
					return exportBatchToAvailablePath(
						{
							destination,
							defaultDirectory: this.defaultDirectory!,
							objectType,
							mode,
							objects: objectIds.flatMap(id => {
								const object = objectsById.get(id);
								return object ? [object] : [];
							}),
							batchIndex,
							batchCount,
							useObjectNames:
								mode === 'separate' &&
								(message.useObjectNames === true ||
									(objectType === 'workflow' && message.useWorkflowNames === true)),
						},
						async outputPath => {
							const input = { sessionId: org.sessionId, orgId: org.id, outputPath };
							return objectType === 'workflow'
								? editorDataClient.exportWorkflows(
										{ ...input, workflowIds: objectIds },
										{ signal: controller.signal },
									)
								: editorDataClient.exportObjects(
										{ ...input, objectType, objectIds },
										{ signal: controller.signal },
									);
						},
					);
				},
				controller.signal,
				(messageText, increment = 0) => {
					progressValue = Math.min(100, progressValue + increment);
					void this.post({ type: 'exportProgress', message: messageText, percent: progressValue });
				},
				details.maxPerExport,
			);
			const exportedObjectCount = outcome.results.reduce((count, result) => count + result.objectIds.length, 0);
			const outputPaths = outcome.results.flatMap(({ result }) => (result.outputPath ? [result.outputPath] : []));
			for (const outputPath of outputPaths) this.knownOutputPaths.add(outputPath);
			await this.post(
				objectType === 'workflow'
					? {
							type: 'exportComplete',
							cancelled: outcome.cancelled,
							exportedWorkflowCount: exportedObjectCount,
							fileCount: outcome.results.length,
							outputPaths,
							failures: outcome.failures.map(failure => ({
								workflowName: failure.item?.name,
								workflowId: failure.item?.id,
								workflowIds: failure.objectIds,
								message: failure.message,
							})),
						}
					: {
							type: 'exportComplete',
							objectType,
							cancelled: outcome.cancelled,
							exportedObjectCount,
							fileCount: outcome.results.length,
							outputPaths,
							failures: outcome.failures.map(failure => ({
								objectName: failure.item?.name,
								objectId: failure.item?.id,
								objectIds: failure.objectIds,
								message: failure.message,
							})),
						},
			);
		} catch (error) {
			if (controller.signal.aborted) {
				await this.post(
					objectType === 'workflow'
						? {
								type: 'exportComplete',
								cancelled: true,
								exportedWorkflowCount: 0,
								fileCount: 0,
								outputPaths: [],
								failures: [],
							}
						: {
								type: 'exportComplete',
								objectType,
								cancelled: true,
								exportedObjectCount: 0,
								fileCount: 0,
								outputPaths: [],
								failures: [],
							},
				);
			} else {
				await this.post({
					type: 'error',
					message: `${details.singular[0].toUpperCase()}${details.singular.slice(1)} export failed: ${errorMessage(error)}`,
				});
			}
		} finally {
			if (this.exportController === controller) this.exportController = undefined;
		}
	}

	private async reveal(path: unknown): Promise<void> {
		if (typeof path === 'string' && this.knownOutputPaths.has(path)) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
		}
	}

	private async handleMessage(value: unknown): Promise<void> {
		const message = messageRecord(value);
		if (!message || typeof message.type !== 'string') return;
		try {
			switch (message.type) {
				case 'ready':
					await this.bootstrap();
					break;
				case 'loadCatalog':
					await this.loadCatalog(message.orgId, message.objectType);
					break;
				case 'applyFilters':
					await this.applyFilters(message);
					break;
				case 'chooseFolder':
					await this.chooseFolder(message.objectType);
					break;
				case 'chooseFile':
					await this.chooseFile(message.objectCount ?? message.workflowCount, message.objectType);
					break;
				case 'useDefaultDestination':
					await this.useDefaultDestination();
					break;
				case 'startExport':
					await this.startExport(message);
					break;
				case 'cancelExport':
					this.exportController?.abort();
					break;
				case 'reveal':
					await this.reveal(message.path);
					break;
			}
		} catch (error) {
			log.error('Rewst Exporter sidebar failed', error);
			await this.post({ type: 'error', message: errorMessage(error) });
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'workflow-exporter', 'main.css'),
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'workflow-exporter', 'main.js'),
		);
		const nonce = randomBytes(32).toString('base64url');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>Rewst Exporter</title>
</head>
<body>
	<header><h2>Rewst Exporter</h2><p>Export workflows, templates, and forms from one place.</p></header>
	<section class="panel" aria-labelledby="object-type-heading">
		<h3 id="object-type-heading">Object type</h3>
		<div class="object-type-selector" role="tablist" aria-label="Export object type">
			<button type="button" data-object-type="workflow" role="tab" aria-selected="true">Workflows</button>
			<button type="button" data-object-type="template" role="tab" aria-selected="false">Templates</button>
			<button type="button" data-object-type="form" role="tab" aria-selected="false">Forms</button>
		</div>
	</section>
	<section class="panel" aria-labelledby="organization-heading">
		<h3 id="organization-heading">Organization</h3>
		<div class="heading-row"><p id="selectedOrganization" class="muted">Choose an organization</p><button id="changeOrganization" type="button" class="secondary" hidden>Change</button></div>
		<div id="organizationPicker">
			<input id="organizationSearch" type="search" placeholder="Search organizations…" aria-label="Search organizations">
			<div id="organizationList" class="organization-list" role="listbox" aria-label="Organizations"></div>
		</div>
		<div class="row"><button id="refreshCatalog" type="button" title="Refresh workflows">Refresh workflows</button></div>
	</section>
	<section class="panel" aria-labelledby="filters-heading">
		<div class="heading-row"><h3 id="filters-heading">Workflows</h3><span id="catalogCount">0</span></div>
		<input id="workflowSearch" type="search" placeholder="Search name or ID…" aria-label="Search workflows">
		<div id="tagFilters">
			<div class="filter-label"><span>Tags</span><span id="tagSelectionCount" class="muted">All tags</span></div>
			<div class="row"><input id="tagSearch" type="search" placeholder="Find tags…" aria-label="Find tags"><button id="clearTags" type="button" class="secondary">Clear</button></div>
			<div id="tagList" class="tag-list" role="listbox" aria-label="Workflow tags" aria-multiselectable="true"></div>
			<div class="segmented" role="group" aria-label="Tag matching"><label><input type="radio" name="tagMatch" value="any" checked> Any tag</label><label><input type="radio" name="tagMatch" value="all"> All tags</label></div>
		</div>
		<p id="tagFiltersUnavailable" class="muted" hidden>Tag metadata is not available for this object type.</p>
		<details><summary>Date filters</summary>
			<div class="date-grid"><label data-created-filter>Created from<input id="createdFrom" type="date"></label><label data-created-filter>Created to<input id="createdTo" type="date"></label><label data-updated-filter>Updated from<input id="updatedFrom" type="date"></label><label data-updated-filter>Updated to<input id="updatedTo" type="date"></label></div>
			<p id="dateFiltersUnavailable" class="muted" hidden>Date metadata is not available for this object type.</p>
		</details>
		<div class="selection-actions"><button id="selectFiltered" type="button">Select visible</button><button id="clearSelection" type="button" class="secondary">Clear selection</button></div>
		<div id="workflowList" class="workflow-list" aria-live="polite"></div>
		<p id="selectionCount" class="muted">0 selected</p>
	</section>
	<section class="panel" aria-labelledby="options-heading">
		<h3 id="options-heading">Export options</h3>
		<div class="segmented vertical"><label><input type="radio" name="mode" value="separate" checked> <span id="separateModeLabel">Separate JSON files</span></label><label><input type="radio" name="mode" value="bundle"> <span id="bundleModeLabel">Signed bundles (25 per file)</span></label></div>
		<label id="filenameOption"><input id="useWorkflowNames" type="checkbox"> <span id="filenameOptionLabel">Use workflow names for filenames</span></label>
		<p id="filenameHelp" class="muted">Names are sanitized and include the workflow ID to prevent duplicate-name collisions.</p>
		<div class="destination"><strong>Destination</strong><span id="destinationPath">Loading…</span></div>
		<div class="destination-actions"><button id="useDefault" type="button" class="secondary">Default</button><button id="chooseFolder" type="button" class="secondary">Choose folder</button><button id="chooseFile" type="button" class="secondary">Choose bundle file</button></div>
	</section>
	<section class="panel actions"><button id="startExport" type="button">Export selected</button><button id="cancelExport" type="button" class="danger" hidden>Cancel</button><progress id="progress" max="100" value="0" hidden></progress><p id="status" role="status"></p><div id="results"></div></section>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
