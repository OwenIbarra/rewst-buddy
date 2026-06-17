import { runToolRequests, WORKSPACE_TOOL_SPECS } from '../ui/chat/tools/workspaceTools';
import { WEB_TOOL_SPECS } from '../ui/chat/tools/webTools';
import type { ToolSpec } from '../ui/chat/tools/toolProtocol';
import type { Capability } from './Capability';

/**
 * Migrates the Cage-Free Rewsty chat-only tools (list_template_links, web_search)
 * into capabilities. These need no Rewst session, so they are requiresOrg:false
 * and chat-only (mcp:false). Execution delegates to runToolRequests, the chat's
 * existing dispatcher, which routes each by name to the same underlying handler;
 * a failure there becomes a thrown error for the surface to format.
 */

function runViaToolRequests(name: string): (input: Record<string, unknown>) => Promise<string> {
	return async input => {
		const [result] = await runToolRequests([{ tool: name, args: input }]);
		if (!result.ok) throw new Error(result.output);
		return result.output;
	};
}

function chatCapability(spec: ToolSpec, enabled: Capability['enabled']): Capability {
	return {
		spec,
		access: 'read',
		chat: true,
		mcp: false,
		requiresOrg: false,
		enabled,
		run: runViaToolRequests(spec.name),
	};
}

export const WORKSPACE_CAPABILITIES: Capability[] = [
	...WORKSPACE_TOOL_SPECS.map(spec => chatCapability(spec, settings => settings.enableWorkspaceTools)),
	...WEB_TOOL_SPECS.map(spec => chatCapability(spec, settings => settings.enableWebTools)),
];
