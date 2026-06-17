import type { Session } from '@sessions';
import type { ToolSpec } from '../ui/chat/tools/toolProtocol';

/**
 * A capability is one Rewst operation defined once and exposed on every surface
 * that wants it (the Cage-Free Rewsty chat tools and the MCP server). The
 * registry (registry.ts) is the single source of truth; each surface is a thin
 * adapter that filters the registry by its own gates and runs the handler.
 *
 * The handler receives a session that was already resolved and validated by the
 * surface — never raw secrets. Cookies stay inside the extension host; the MCP
 * bridge process only forwards tool names and arguments.
 */

export type CapabilityAccess = 'read' | 'write';

/**
 * Settings that gate whether a capability is offered at all, independent of any
 * surface. The MCP surface layers its own gates on top (master switch, write
 * toggle, allowlist); this is the capability's intrinsic feature gate, mirroring
 * the rewst-buddy.ai.* switches the chat tools already honor.
 */
export interface CapabilitySettings {
	enableGraphqlTool: boolean;
	enableWorkspaceTools: boolean;
	enableWebTools: boolean;
}

/**
 * The session + org a capability handler runs against. The surface resolves and
 * validates the session before calling run, so org-scoped handlers can assume it
 * is live. `session` is optional because some capabilities need no Rewst session
 * (e.g. list_template_links, web_search); those handlers ignore it. Org-scoped
 * handlers call {@link requireSession}. `sessions` is every active session, for
 * org-discovery capabilities that span orgs (e.g. list_orgs).
 */
export interface CapabilityContext {
	session?: Session;
	orgId: string;
	sessions: Session[];
}

/** Returns the context's session or throws an actionable error if absent. */
export function requireSession(ctx: CapabilityContext): Session {
	if (!ctx.session) {
		throw new Error('No active Rewst session for this operation. Sign in to Rewst in VS Code first.');
	}
	return ctx.session;
}

/**
 * Describes the single resource a write capability changes, so the MCP surface
 * can require per-resource approval inside VS Code (never in the external
 * client) before the change runs. Keyed by org + scopeId, like the chat's
 * GraphQL mutation approvals.
 */
export interface WriteApproval {
	/** Stable id of the resource being changed (e.g. a template id). */
	scopeId: string;
	/** Human-readable resource name, shown in the approval prompt. */
	scopeName: string;
	/** Org the change runs in. */
	orgId: string;
	/** Org name, shown in the approval prompt. */
	orgName: string;
	/** Verb phrase for the prompt, e.g. "update the body of template". */
	action: string;
}

export interface Capability {
	spec: ToolSpec;
	/**
	 * Whether the capability can change Rewst state. The MCP server boundary
	 * rejects access:'write' unless write tools are explicitly enabled, regardless
	 * of what the bridge forwards.
	 */
	access: CapabilityAccess;
	/** Exposed as a Cage-Free Rewsty chat tool (vscode-tool protocol). */
	chat: boolean;
	/** Exposed over the MCP server surface. */
	mcp: boolean;
	/**
	 * Whether the capability operates on a specific org. When false (e.g.
	 * list_orgs), the MCP surface does not require an `orgId` argument and the
	 * handler should use `ctx.sessions` rather than `ctx.session`. Defaults to
	 * org-scoped (true) when omitted.
	 */
	requiresOrg?: boolean;
	/** Intrinsic feature gate; surface-specific gates are applied by the surface. */
	enabled(settings: CapabilitySettings): boolean;
	/**
	 * For access:'write' capabilities: the resource the write touches, so the MCP
	 * surface can require the VS Code user's per-resource approval before run.
	 */
	approval?(input: Record<string, unknown>, ctx: CapabilityContext): WriteApproval;
	/** Runs the operation and returns text for the caller. */
	run(input: Record<string, unknown>, ctx: CapabilityContext): Promise<string>;
}
