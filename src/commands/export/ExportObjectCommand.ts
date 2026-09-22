import type { Session } from '@sessions';
import { pickOrganization } from '@ui';
import { log } from '@utils';
import path from 'node:path';
import vscode from 'vscode';
import { editorDataClient, type ExportFormRow } from '../../backend/editorDataClient';
import GenericCommand from '../GenericCommand';
import { exportBatchToAvailablePath, runCatalogExports } from '../workflows/workflowExportEngine';

export type ExportCapabilityName = 'buddy_export_templates' | 'buddy_export_forms';
export type ExportIdsField = 'templateIds' | 'formIds';

export interface ExportListItem {
	id: string;
	name: string;
	detail?: string;
}

interface ExportQuickPickItem extends vscode.QuickPickItem {
	id: string;
}

interface DestinationChoice extends vscode.QuickPickItem {
	destinationType: 'default' | 'folder';
}

export interface ExportCommandDependencies {
	pickOrganization: typeof pickOrganization;
	listForms(session: Session, orgId: string, signal: AbortSignal): Promise<ExportFormRow[]>;
	getDefaultDirectory(signal: AbortSignal): Promise<string>;
	runCapability(
		input: {
			sessionId: string;
			orgId: string;
			name: ExportCapabilityName;
			arguments: Record<string, unknown>;
		},
		signal: AbortSignal,
	): Promise<string>;
}

export const defaultExportCommandDependencies: ExportCommandDependencies = {
	pickOrganization,
	listForms: async (session, orgId, signal) =>
		editorDataClient.listExportForms({ sessionId: requireSessionId(session), orgId }, { signal }),
	getDefaultDirectory: signal => editorDataClient.getWorkflowExportDefaultDirectory({ signal }),
	runCapability: (input, signal) => editorDataClient.runExportCapability(input, { signal }),
};

export interface ExportCommandConfig {
	commandName: 'ExportTemplates' | 'ExportForms';
	capabilityName: ExportCapabilityName;
	idsField: ExportIdsField;
	singular: 'template' | 'form';
	plural: 'templates' | 'forms';
	maxObjectsPerExport: number;
	load(
		session: Session,
		orgId: string,
		dependencies: ExportCommandDependencies,
		signal: AbortSignal,
	): Promise<ExportListItem[]>;
}

const CANCELLED = Symbol('cancelled');

async function withCancellableProgress<T>(
	options: vscode.ProgressOptions,
	operation: (signal: AbortSignal, progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>,
): Promise<T | typeof CANCELLED> {
	return vscode.window.withProgress({ ...options, cancellable: true }, async (progress, token) => {
		const controller = new AbortController();
		const cancelListener = token.onCancellationRequested(() => controller.abort());
		if (token.isCancellationRequested) controller.abort();
		try {
			const result = await operation(controller.signal, progress);
			return controller.signal.aborted ? CANCELLED : result;
		} catch (error) {
			if (controller.signal.aborted) return CANCELLED;
			throw error;
		} finally {
			cancelListener.dispose();
		}
	});
}

function requireSessionId(session: Session): string {
	const id = session.sessionId ?? session.profile.user.id;
	if (typeof id !== 'string' || id.length === 0) throw new Error('Selected Rewst session has no user id.');
	return id;
}

export function exportQuickPickItems(items: readonly ExportListItem[]): ExportQuickPickItem[] {
	return items.map(item => ({
		label: item.name || item.id,
		description: item.id,
		detail: item.detail,
		id: item.id,
	}));
}

export function updatedDateDetail(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return `Updated ${Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()}`;
}

function defaultDirectoryDescription(): string {
	const configured = vscode.workspace.getConfiguration('rewst-buddy').get<string>('mcp.exportDefaultDir', '').trim();
	return configured || 'Downloads/Rewst Exports';
}

async function pickDestination(plural: string): Promise<{ outputPath?: string } | undefined> {
	const choice = await vscode.window.showQuickPick<DestinationChoice>(
		[
			{
				label: 'Use default export directory',
				description: defaultDirectoryDescription(),
				destinationType: 'default',
			},
			{ label: 'Choose an existing folder…', description: 'Open folder picker', destinationType: 'folder' },
		],
		{ placeHolder: `Choose where to save the ${plural} export` },
	);
	if (!choice) return undefined;
	if (choice.destinationType === 'default') return {};

	const configured = vscode.workspace.getConfiguration('rewst-buddy').get<string>('mcp.exportDefaultDir', '').trim();
	const defaultUri = path.isAbsolute(configured)
		? vscode.Uri.file(configured)
		: vscode.workspace.workspaceFolders?.[0]?.uri;
	const selected = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Export Here',
		title: `Export ${plural}`,
		defaultUri,
	});
	return selected?.[0] ? { outputPath: selected[0].fsPath } : undefined;
}

function parseExportResult(value: string): { outputPath?: string } {
	const parsed = JSON.parse(value) as unknown;
	if (!parsed || typeof parsed !== 'object') throw new Error('Exporter returned an invalid result.');
	const outputPath = (parsed as { outputPath?: unknown }).outputPath;
	if (typeof outputPath !== 'string' || outputPath.length === 0) {
		throw new Error('Exporter did not report a saved output path.');
	}
	return { outputPath };
}

export default abstract class ExportObjectCommand extends GenericCommand {
	readonly commandName: string;

	protected constructor(
		private readonly config: ExportCommandConfig,
		private readonly dependencies: ExportCommandDependencies = defaultExportCommandDependencies,
	) {
		super();
		this.commandName = config.commandName;
	}

	async execute(): Promise<void> {
		try {
			const pickedOrg = await this.dependencies.pickOrganization();
			if (!pickedOrg) return;
			const { session, org } = pickedOrg;

			const objects = await withCancellableProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Loading Rewst ${this.config.plural}…` },
				signal => this.config.load(session, org.id, this.dependencies, signal),
			);
			if (objects === CANCELLED) return;
			if (objects.length === 0) {
				log.notifyWarn(`No ${this.config.plural} found for ${org.name}.`);
				return;
			}

			const selected = await vscode.window.showQuickPick(exportQuickPickItems(objects), {
				placeHolder: `Select ${this.config.plural} to export`,
				canPickMany: true,
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (!selected || selected.length === 0) return;

			const destination = await pickDestination(this.config.plural);
			if (!destination) return;

			const catalogItems = selected.map(item => ({
				id: item.id,
				name: item.label,
				orgId: org.id,
				orgName: org.name,
			}));
			const catalogItemsById = new Map(catalogItems.map(item => [item.id, item]));
			const exportOutcome = await withCancellableProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Exporting ${selected.length} ${selected.length === 1 ? this.config.singular : this.config.plural}…`,
				},
				async (signal, progress) => {
					const targetDirectory =
						destination.outputPath ?? (await this.dependencies.getDefaultDirectory(signal));
					return runCatalogExports(
						catalogItems,
						this.config.singular,
						'bundle',
						async (ids, batchIndex, totalBatches) => {
							if (totalBatches === 1) {
								const rawResult = await this.dependencies.runCapability(
									{
										sessionId: requireSessionId(session),
										orgId: org.id,
										name: this.config.capabilityName,
										arguments: {
											orgId: org.id,
											[this.config.idsField]: ids,
											includeBundle: false,
											...(targetDirectory ? { outputPath: targetDirectory } : {}),
										},
									},
									signal,
								);
								return parseExportResult(rawResult);
							}
							return exportBatchToAvailablePath(
								{
									destination: { kind: 'directory', outputPath: destination.outputPath },
									defaultDirectory: targetDirectory,
									objectType: this.config.singular,
									mode: 'bundle',
									objects: ids.flatMap(id => {
										const item = catalogItemsById.get(id);
										return item ? [item] : [];
									}),
									batchIndex,
									batchCount: totalBatches,
								},
								async outputPath => {
									const rawResult = await this.dependencies.runCapability(
										{
											sessionId: requireSessionId(session),
											orgId: org.id,
											name: this.config.capabilityName,
											arguments: {
												orgId: org.id,
												[this.config.idsField]: ids,
												includeBundle: false,
												...(outputPath ? { outputPath } : {}),
											},
										},
										signal,
									);
									return parseExportResult(rawResult);
								},
							);
						},
						signal,
						(message, increment) => progress.report({ message, increment }),
						this.config.maxObjectsPerExport,
					);
				},
			);
			if (exportOutcome === CANCELLED || exportOutcome.cancelled) return;
			if (exportOutcome.failures.length > 0) {
				const exportedCount = exportOutcome.results.reduce(
					(count, result) => count + result.objectIds.length,
					0,
				);
				const details = exportOutcome.failures
					.map(failure => `Batch (${failure.objectIds?.join(', ') ?? 'unknown ids'}): ${failure.message}`)
					.join('\n');
				if (exportedCount === 0) log.notifyError(`Failed to export ${this.config.plural}.`, new Error(details));
				else
					log.notifyWarn(
						`Exported ${exportedCount} of ${selected.length} ${this.config.plural}. ${exportOutcome.failures.length} batch${exportOutcome.failures.length === 1 ? '' : 'es'} failed. ${details}`,
					);
				return;
			}
			if (exportOutcome.results.length === 1) {
				log.notifyInfo(
					`Exported ${selected.length} ${selected.length === 1 ? this.config.singular : this.config.plural} to ${exportOutcome.results[0].result.outputPath}.`,
				);
			} else {
				log.notifyInfo(
					`Exported ${selected.length} ${this.config.plural} across ${exportOutcome.results.length} signed bundle files.`,
				);
			}
		} catch (error) {
			log.notifyError(`Failed to export ${this.config.plural}.`, error);
		}
	}
}
