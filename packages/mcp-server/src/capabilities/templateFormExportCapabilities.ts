import { createObjectExportCapability, type ObjectExportDependencies } from './objectExportCapability';

const TEMPLATE_OWNER_QUERY = `
query RewstBuddyTemplateOwner($id: ID!) {
  template(where: { id: $id }) { id orgId name }
}
`.trim();

const FORM_OWNER_QUERY = `
query RewstBuddyFormOwner($id: ID!) {
  form(where: { id: $id }) { id orgId name }
}
`.trim();

/** Matches the workflow export bound for predictable ownership-query and bundle costs. */
export const MAX_TEMPLATES_PER_EXPORT = 25;
export const MAX_FORMS_PER_EXPORT = 25;

const sharedDescription =
	"Every export is saved as pretty JSON to an absolute outputPath under an approved local root, or to the default Rewst Exports directory when omitted. Existing directories use Rewst's sanitized recommended filename. The complete signed bundle is returned inline when outputPath is omitted; with an explicit path, set includeBundle to return it too. Writes are atomic and never replace an existing file.";

const templateExport = createObjectExportCapability({
	toolName: 'buddy_export_templates',
	objectType: 'template',
	objectLabel: 'Template',
	objectsLabel: 'templates',
	idsField: 'templateIds',
	ownerQuery: TEMPLATE_OWNER_QUERY,
	ownerResponseField: 'template',
	maxObjects: MAX_TEMPLATES_PER_EXPORT,
	description: `Export one or more templates as an unchanged signed Rewst bundle through the read-only exportObjects subscription. ${sharedDescription}`,
});

const formExport = createObjectExportCapability({
	toolName: 'buddy_export_forms',
	objectType: 'form',
	objectLabel: 'Form',
	objectsLabel: 'forms',
	idsField: 'formIds',
	ownerQuery: FORM_OWNER_QUERY,
	ownerResponseField: 'form',
	maxObjects: MAX_FORMS_PER_EXPORT,
	description: `Export one or more forms as an unchanged signed Rewst bundle through the read-only exportObjects subscription. ${sharedDescription}`,
});

export function _setTemplateExportDependenciesForTesting(dependencies?: ObjectExportDependencies): void {
	templateExport.setDependenciesForTesting(dependencies);
}

export function _setFormExportDependenciesForTesting(dependencies?: ObjectExportDependencies): void {
	formExport.setDependenciesForTesting(dependencies);
}

export const templateExportCapability = templateExport.capability;
export const formExportCapability = formExport.capability;
