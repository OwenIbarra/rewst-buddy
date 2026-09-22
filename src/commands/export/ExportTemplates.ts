import { type ExportCommandDependencies, type ExportListItem, updatedDateDetail } from './ExportObjectCommand';
import ExportObjectCommand from './ExportObjectCommand';
import { MAX_TEMPLATES_PER_EXPORT } from '../../../packages/mcp-server/src/capabilities/templateFormExportCapabilities';

export class ExportTemplates extends ExportObjectCommand {
	constructor(dependencies?: ExportCommandDependencies) {
		super(
			{
				commandName: 'ExportTemplates',
				capabilityName: 'buddy_export_templates',
				idsField: 'templateIds',
				singular: 'template',
				plural: 'templates',
				maxObjectsPerExport: MAX_TEMPLATES_PER_EXPORT,
				async load(session, orgId, _dependencies, signal): Promise<ExportListItem[]> {
					const sdk = session.sdk;
					if (!sdk) throw new Error('The selected Rewst session has no SDK for loading templates.');
					const response = await sdk.listTemplates({ orgId }, undefined, signal);
					return (response.templates ?? []).map(template => ({
						id: template.id,
						name: template.name,
						detail:
							[template.description, updatedDateDetail(template.updatedAt)].filter(Boolean).join(' • ') ||
							undefined,
					}));
				},
			},
			dependencies,
		);
	}
}
