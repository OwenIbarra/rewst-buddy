import { type ExportCommandDependencies, type ExportListItem, updatedDateDetail } from './ExportObjectCommand';
import ExportObjectCommand from './ExportObjectCommand';
import { MAX_FORMS_PER_EXPORT } from '../../../packages/mcp-server/src/capabilities/templateFormExportCapabilities';

export class ExportForms extends ExportObjectCommand {
	constructor(dependencies?: ExportCommandDependencies) {
		super(
			{
				commandName: 'ExportForms',
				capabilityName: 'buddy_export_forms',
				idsField: 'formIds',
				singular: 'form',
				plural: 'forms',
				maxObjectsPerExport: MAX_FORMS_PER_EXPORT,
				async load(session, orgId, commandDependencies, signal): Promise<ExportListItem[]> {
					const forms = await commandDependencies.listForms(session, orgId, signal);
					return forms
						.filter(
							(form): form is typeof form & { id: string } =>
								typeof form.id === 'string' && form.id.length > 0,
						)
						.map(form => ({
							id: form.id,
							name: typeof form.name === 'string' && form.name.length > 0 ? form.name : form.id,
							detail: updatedDateDetail(form.updatedAt),
						}));
				},
			},
			dependencies,
		);
	}
}
