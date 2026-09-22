import type { ExportCatalogRow, ExportWorkflowRow } from '../../backend/editorDataClient';
import type {
	ExportCatalogItem,
	ExporterObjectType,
	ExportWorkflowChoice,
} from '../../commands/workflows/workflowExportEngine';

export type ExportTagMatch = 'any' | 'all';
/** Compatibility name retained for workflow model callers. */
export type WorkflowTagMatch = ExportTagMatch;

export interface ExportCatalogFilters {
	search: string;
	tagIds: string[];
	tagMatch: ExportTagMatch;
	createdFrom?: string;
	createdTo?: string;
	updatedFrom?: string;
	updatedTo?: string;
}

/** Compatibility name retained for workflow model callers. */
export type WorkflowCatalogFilters = ExportCatalogFilters;

export interface ExportTagOption {
	id: string;
	name: string;
}

/** Compatibility name retained for workflow model callers. */
export type WorkflowTagOption = ExportTagOption;

export interface WorkflowExportOrganizationOption {
	id: string;
	name: string;
}

export interface ExportCatalogFieldSupport {
	tags: boolean;
	createdAt: boolean;
	updatedAt: boolean;
}

/** Fields verified against the generated Rewst GraphQL schema. */
export const EXPORT_CATALOG_FIELD_SUPPORT: Record<ExporterObjectType, ExportCatalogFieldSupport> = {
	workflow: { tags: true, createdAt: true, updatedAt: true },
	template: { tags: true, createdAt: true, updatedAt: true },
	form: { tags: true, createdAt: true, updatedAt: true },
};

function clean(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function filterWorkflowOrganizations(
	organizations: readonly WorkflowExportOrganizationOption[],
	query: string,
): WorkflowExportOrganizationOption[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	return organizations.filter(organization =>
		`${organization.name} ${organization.id}`.toLocaleLowerCase().includes(normalizedQuery),
	);
}

export function normalizeWorkflowCatalog(
	rows: readonly ExportWorkflowRow[],
	org: { id: string; name: string },
): ExportWorkflowChoice[] {
	return normalizeExportCatalog(rows, org);
}

export function normalizeExportCatalog(
	rows: readonly ExportCatalogRow[],
	org: { id: string; name: string },
): ExportCatalogItem[] {
	const seen = new Set<string>();
	return rows.flatMap(row => {
		const id = clean(row.id);
		if (!id || seen.has(id)) return [];
		seen.add(id);
		const tags = (row.tags ?? []).flatMap(tag => {
			const tagId = clean(tag?.id);
			if (!tagId) return [];
			return [{ id: tagId, name: clean(tag?.name) ?? tagId }];
		});
		return [
			{
				id,
				name: clean(row.name) ?? id,
				orgId: clean(row.orgId) ?? org.id,
				orgName: org.name,
				createdAt: row.createdAt ?? null,
				updatedAt: row.updatedAt ?? null,
				tags,
			},
		];
	});
}

export function workflowTagOptions(workflows: readonly ExportWorkflowChoice[]): WorkflowTagOption[] {
	return exportTagOptions(workflows);
}

export function exportTagOptions(objects: readonly ExportCatalogItem[]): ExportTagOption[] {
	const tags = new Map<string, string>();
	for (const object of objects) {
		for (const tag of object.tags ?? []) {
			const id = clean(tag.id);
			if (id && !tags.has(id)) tags.set(id, clean(tag.name) ?? id);
		}
	}
	return [...tags].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

function timestamp(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value)) {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return undefined;
		const epochMilliseconds = value.length <= 10 ? numeric * 1000 : numeric;
		return Number.isFinite(new Date(epochMilliseconds).getTime()) ? epochMilliseconds : undefined;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function dateFloor(value: string | undefined): number | undefined {
	return value ? Date.parse(`${value}T00:00:00.000Z`) : undefined;
}

function dateCeiling(value: string | undefined): number | undefined {
	return value ? Date.parse(`${value}T23:59:59.999Z`) : undefined;
}

function withinDateRange(value: string | null | undefined, from?: string, to?: string): boolean {
	if (!from && !to) return true;
	const actual = timestamp(value);
	if (actual === undefined) return false;
	const minimum = dateFloor(from);
	const maximum = dateCeiling(to);
	return (minimum === undefined || actual >= minimum) && (maximum === undefined || actual <= maximum);
}

function matchesSelectedTags(
	object: ExportCatalogItem,
	selectedTags: readonly string[],
	match: ExportTagMatch,
	tagsSupported: boolean,
): boolean {
	if (selectedTags.length === 0) return true;
	if (!tagsSupported) return false;
	const objectTags = new Set<string>();
	for (const tag of object.tags ?? []) {
		const id = clean(tag.id);
		if (id) objectTags.add(id);
	}
	return match === 'all'
		? selectedTags.every(tag => objectTags.has(tag))
		: selectedTags.some(tag => objectTags.has(tag));
}

export function filterWorkflowCatalog(
	workflows: readonly ExportWorkflowChoice[],
	filters: WorkflowCatalogFilters,
): ExportWorkflowChoice[] {
	return filterExportCatalog(workflows, filters);
}

export function filterExportCatalog(
	objects: readonly ExportCatalogItem[],
	filters: ExportCatalogFilters,
	fieldSupport: ExportCatalogFieldSupport = { tags: true, createdAt: true, updatedAt: true },
): ExportCatalogItem[] {
	const query = filters.search.trim().toLocaleLowerCase();
	const selectedTags = [...new Set(filters.tagIds.filter(Boolean))];
	const hasCreatedFilter = Boolean(filters.createdFrom || filters.createdTo);
	const hasUpdatedFilter = Boolean(filters.updatedFrom || filters.updatedTo);
	return objects.filter(object => {
		const searchable = `${object.name}\n${object.id}\n${object.orgName}\n${object.orgId}`.toLocaleLowerCase();
		if (query && !searchable.includes(query)) return false;
		if (!matchesSelectedTags(object, selectedTags, filters.tagMatch, fieldSupport.tags)) return false;
		if ((hasCreatedFilter && !fieldSupport.createdAt) || (hasUpdatedFilter && !fieldSupport.updatedAt))
			return false;
		return (
			withinDateRange(object.createdAt, filters.createdFrom, filters.createdTo) &&
			withinDateRange(object.updatedAt, filters.updatedFrom, filters.updatedTo)
		);
	});
}

export function parseWorkflowCatalogFilters(value: unknown): WorkflowCatalogFilters {
	return parseExportCatalogFilters(value);
}

export function parseExportCatalogFilters(value: unknown): ExportCatalogFilters {
	const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	const tagIds = Array.isArray(input.tagIds) ? input.tagIds.flatMap(id => (clean(id) ? [clean(id)!] : [])) : [];
	return {
		search: clean(input.search) ?? '',
		tagIds: [...new Set(tagIds)],
		tagMatch: input.tagMatch === 'all' ? 'all' : 'any',
		createdFrom: clean(input.createdFrom),
		createdTo: clean(input.createdTo),
		updatedFrom: clean(input.updatedFrom),
		updatedTo: clean(input.updatedTo),
	};
}
