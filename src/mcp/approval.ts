import type { WriteApproval } from '@capabilities';
import { log } from '@utils';
import vscode from 'vscode';
import { approveMutationScope, isMutationScopeApproved, type MutationScope } from '../ui/chat/tools/graphqlTool';

/**
 * Per-resource approval for MCP write capabilities. Approval is requested and
 * granted inside VS Code (never in the external client): an unapproved write
 * returns an approval_required result and pops a VS Code prompt; once the user
 * approves the resource for the session, retries run. Reuses the same session
 * approval store as the chat's GraphQL mutations, so an approval granted in
 * either surface covers the same org + resource.
 */

function toScope(approval: WriteApproval): MutationScope {
	return {
		scopeId: approval.scopeId,
		scopeName: approval.scopeName,
		orgId: approval.orgId,
		orgName: approval.orgName,
	};
}

function scopeKey(approval: WriteApproval): string {
	return JSON.stringify([approval.orgId, approval.scopeId]);
}

/** Scopes with an approval prompt already on screen, to avoid spamming retries. */
const pendingPrompts = new Set<string>();

/** Whether this org + resource has been approved this session. */
export function isWriteApproved(approval: WriteApproval): boolean {
	return isMutationScopeApproved(toScope(approval));
}

/**
 * Surfaces a non-blocking VS Code approval prompt for an MCP write, unless one is
 * already showing or the scope is already approved. Approving records the scope
 * so subsequent retries (and chat mutations) to the same resource run.
 */
export function requestWriteApproval(approval: WriteApproval, prompt: WriteApprovalPrompt = defaultPrompt): void {
	const key = scopeKey(approval);
	if (isWriteApproved(approval) || pendingPrompts.has(key)) return;
	pendingPrompts.add(key);
	prompt(approval)
		.then(approved => {
			if (approved) {
				approveMutationScope(toScope(approval));
				log.info(`MCP write approved: ${approval.action} "${approval.scopeName}" in org ${approval.orgId}`);
			} else {
				log.info(`MCP write approval dismissed: ${approval.action} "${approval.scopeName}"`);
			}
		})
		.finally(() => pendingPrompts.delete(key));
}

/** A function that asks the user to approve a write; resolves true if approved. */
export type WriteApprovalPrompt = (approval: WriteApproval) => Promise<boolean>;

const APPROVE_LABEL = 'Approve for session';

const defaultPrompt: WriteApprovalPrompt = async approval => {
	const choice = await vscode.window.showWarningMessage(
		`An external MCP agent wants to ${approval.action} "${approval.scopeName}" in org ${approval.orgName}. Allow it for this session?`,
		{ modal: false },
		APPROVE_LABEL,
	);
	return choice === APPROVE_LABEL;
};

/** Test seam: clears any in-flight prompt de-dupe state. */
export function _resetWriteApprovalPromptsForTesting(): void {
	pendingPrompts.clear();
}
