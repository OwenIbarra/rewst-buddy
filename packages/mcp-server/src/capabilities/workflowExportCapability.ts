import { createObjectExportCapability, type ObjectExportDependencies } from './objectExportCapability';
import type { ExportBundle } from '../export/exportObjects';

const WORKFLOW_OWNER_QUERY = `
query RewstBuddyWorkflowOwner($id: ID!) {
  workflow(where: { id: $id }) { id name orgId }
}
`.trim();

/** Upper bound on workflows per export; keeps per-id owner checks and the bundle bounded. */
export const MAX_WORKFLOWS_PER_EXPORT = 25;

/** Host-owned limits forwarded to editor clients when bootstrapping workflow export UI. */
export const WORKFLOW_EXPORT_BOOTSTRAP_PAYLOAD = Object.freeze({
	maxWorkflowsPerExport: MAX_WORKFLOWS_PER_EXPORT,
});

/** Structured result shared by MCP text responses and trusted editor operations. */
export interface WorkflowExportResult {
	status: 'saved';
	orgId: string;
	workflowIds: string[];
	recommendedFilename: string;
	outputPath: string | null;
	bytes: number;
	version: number;
	exportedAt: string;
	objectCount: number;
	signingPresent: boolean;
	bundle?: ExportBundle;
}

const workflowExport = createObjectExportCapability({
	toolName: 'buddy_export_workflows',
	objectType: 'workflow',
	objectLabel: 'Workflow',
	objectsLabel: 'workflows',
	idsField: 'workflowIds',
	ownerQuery: WORKFLOW_OWNER_QUERY,
	ownerResponseField: 'workflow',
	maxObjects: MAX_WORKFLOWS_PER_EXPORT,
	description:
		"Export one or more workflows through the same signed exportObjects subscription as Rewst's web Export button. The Rewst operation is read-only. Every export is also saved to disk as pretty JSON: pass an absolute outputPath under an approved local root (Downloads, an active workspace, the current Git checkout, or rewst-buddy.mcp.exportRoots) to choose the destination, or omit it to use the default export directory (Downloads/Rewst Exports unless rewst-buddy.mcp.exportDefaultDir overrides it). An existing directory saves under Rewst's sanitized recommended filename; pointing at the Downloads folder itself saves inside a Rewst Exports subfolder, created when missing. Without an explicit outputPath the complete signed bundle is still returned inline (large results can be paged with buddy_result_read); with one it is opt-in via includeBundle. Canonical path checks prevent traversal and symlink escapes; local writes are atomic and never replace an existing file.",
});

/** Replaces external boundaries in unit tests; omit arguments to restore them. */
export function _setWorkflowExportDependenciesForTesting(dependencies?: ObjectExportDependencies): void {
	workflowExport.setDependenciesForTesting(dependencies);
}

export const workflowExportCapability = workflowExport.capability;
