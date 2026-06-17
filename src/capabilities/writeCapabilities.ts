import type { ToolSpec } from '../ui/chat/tools/toolProtocol';
import { requireSession, type Capability, type CapabilityContext, type WriteApproval } from './Capability';

/**
 * Write capabilities exposed over MCP. They are gated twice: the MCP boundary
 * rejects them unless rewst-buddy.mcp.enableWriteTools is on, and each change
 * additionally requires the VS Code user's per-resource approval (the approval
 * happens in VS Code, never in the external client). Limited to operations the
 * typed SDK supports; export_workflow / import_bundle are deferred until their
 * Rewst API surface is confirmed.
 *
 * Descriptions stay plain and factual: they enter an external agent's context.
 */

function asString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function requireString(input: Record<string, unknown>, key: string): string {
	const value = asString(input, key);
	if (!value) throw new Error(`Missing required string argument "${key}".`);
	return value;
}

/** The display name of an org id within a session's managed orgs. */
function orgName(ctx: CapabilityContext, orgId: string): string {
	const session = ctx.session;
	const match = session?.profile.allManagedOrgs.find(org => org.id === orgId);
	return match?.name ?? session?.profile.org.name ?? orgId;
}

const ORG_ID_PROP = {
	orgId: { type: 'string', description: 'Rewst organization id the change runs in (from list_orgs).' },
} as const;

const updateTemplateBodySpec: ToolSpec = {
	name: 'update_template_body',
	args: '{"orgId": string, "templateId": string, "body": string, "templateName"?: string}',
	description:
		'Replace the body of an existing Rewst template. Changes Rewst data, so it requires the VS Code user to approve this template for the session before it runs.',
	inputSchema: {
		type: 'object',
		properties: {
			...ORG_ID_PROP,
			templateId: { type: 'string', description: 'Id of the template to update.' },
			body: { type: 'string', description: 'New template body (replaces the existing body).' },
			templateName: { type: 'string', description: 'Optional template name, shown in the approval prompt.' },
		},
		required: ['orgId', 'templateId', 'body'],
	},
};

const createTemplateSpec: ToolSpec = {
	name: 'create_template',
	args: '{"orgId": string, "name": string, "body": string}',
	description:
		'Create a new Rewst template in an organization. Changes Rewst data, so it requires the VS Code user to approve before it runs.',
	inputSchema: {
		type: 'object',
		properties: {
			...ORG_ID_PROP,
			name: { type: 'string', description: 'Name for the new template.' },
			body: { type: 'string', description: 'Body for the new template.' },
		},
		required: ['orgId', 'name', 'body'],
	},
};

async function runUpdateTemplateBody(input: Record<string, unknown>, ctx: CapabilityContext): Promise<string> {
	requireString(input, 'orgId');
	const templateId = requireString(input, 'templateId');
	const body = typeof input.body === 'string' ? input.body : undefined;
	if (body === undefined) throw new Error('Missing required string argument "body".');
	const response = await requireSession(ctx).sdk?.updateTemplateBody({ id: templateId, body });
	const updated = response?.template;
	if (!updated) throw new Error(`Template not updated: ${templateId}`);
	return `Updated body of template "${updated.name}" (${updated.id}); updatedAt ${updated.updatedAt}.`;
}

function approveUpdateTemplateBody(input: Record<string, unknown>, ctx: CapabilityContext): WriteApproval {
	const orgId = requireString(input, 'orgId');
	const templateId = requireString(input, 'templateId');
	return {
		scopeId: templateId,
		scopeName: asString(input, 'templateName') ?? templateId,
		orgId,
		orgName: orgName(ctx, orgId),
		action: 'update the body of template',
	};
}

async function runCreateTemplate(input: Record<string, unknown>, ctx: CapabilityContext): Promise<string> {
	const orgId = requireString(input, 'orgId');
	const name = requireString(input, 'name');
	const body = typeof input.body === 'string' ? input.body : undefined;
	if (body === undefined) throw new Error('Missing required string argument "body".');
	const response = await requireSession(ctx).sdk?.createTemplateMinimal({ name, orgId, body });
	const created = response?.template;
	if (!created) throw new Error(`Template not created: ${name}`);
	return `Created template "${created.name}" (${created.id}).`;
}

function approveCreateTemplate(input: Record<string, unknown>, ctx: CapabilityContext): WriteApproval {
	const orgId = requireString(input, 'orgId');
	const name = requireString(input, 'name');
	return {
		// A new template has no id yet; scope approval by org + intended name.
		scopeId: `create-template:${name}`,
		scopeName: name,
		orgId,
		orgName: orgName(ctx, orgId),
		action: 'create template',
	};
}

export const WRITE_CAPABILITIES: Capability[] = [
	{
		spec: updateTemplateBodySpec,
		access: 'write',
		chat: false,
		mcp: true,
		enabled: () => true,
		approval: approveUpdateTemplateBody,
		run: runUpdateTemplateBody,
	},
	{
		spec: createTemplateSpec,
		access: 'write',
		chat: false,
		mcp: true,
		enabled: () => true,
		approval: approveCreateTemplate,
		run: runCreateTemplate,
	},
];
