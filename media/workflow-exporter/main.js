/* global acquireVsCodeApi, document, window */
(function () {
	const vscode = acquireVsCodeApi();
	const objectTypes = {
		workflow: { singular: 'workflow', plural: 'workflows', title: 'Workflows' },
		template: { singular: 'template', plural: 'templates', title: 'Templates' },
		form: { singular: 'form', plural: 'forms', title: 'Forms' },
	};
	const emptyFilters = () => ({
		search: '',
		tagIds: [],
		tagMatch: 'any',
		createdFrom: '',
		createdTo: '',
		updatedFrom: '',
		updatedTo: '',
	});
	const defaultState = {
		objectType: 'workflow',
		organizations: [],
		organizationSearch: '',
		organizationPickerOpen: false,
		selectedOrgId: '',
		catalogOrgId: '',
		catalogObjectType: '',
		objects: [],
		visibleIds: [],
		selectedIds: [],
		tags: [],
		tagSearch: '',
		filters: emptyFilters(),
		fieldSupport: { tags: true, createdAt: true, updatedAt: true },
		mode: 'separate',
		useObjectNames: false,
		destination: { kind: 'directory', isDefault: true },
		exporting: false,
		maxObjectsPerExport: 25,
	};
	const persistedState = vscode.getState() || {};
	const state = Object.assign({}, defaultState, persistedState, {
		filters: Object.assign(emptyFilters(), persistedState.filters || {}),
		destination: Object.assign({}, defaultState.destination, persistedState.destination || {}),
		fieldSupport: Object.assign({}, defaultState.fieldSupport, persistedState.fieldSupport || {}),
	});
	if (!objectTypes[state.objectType]) state.objectType = 'workflow';
	state.useObjectNames = persistedState.useObjectNames === true || persistedState.useWorkflowNames === true;
	state.objects = Array.isArray(persistedState.objects)
		? persistedState.objects
		: state.objectType === 'workflow' && Array.isArray(persistedState.workflows)
			? persistedState.workflows
			: [];
	// Upgrade workflow-only webview state without discarding its current catalog
	// and selection. The generalized catalog keys did not exist in that version.
	if (
		state.objectType === 'workflow' &&
		Array.isArray(persistedState.workflows) &&
		!persistedState.catalogOrgId &&
		!persistedState.catalogObjectType
	) {
		state.catalogOrgId = state.selectedOrgId;
		state.catalogObjectType = 'workflow';
	}
	if (state.catalogObjectType !== state.objectType || state.catalogOrgId !== state.selectedOrgId) {
		state.objects = [];
		state.visibleIds = [];
		state.selectedIds = [];
		state.tags = [];
	}

	const app = document;
	function details() {
		return objectTypes[state.objectType];
	}
	function save() {
		vscode.setState(
			Object.assign({}, state, {
				workflows: state.objectType === 'workflow' ? state.objects : [],
				organizationSearch: '',
				tagSearch: '',
				filters: Object.assign({}, state.filters, { search: '' }),
			}),
		);
	}
	function esc(value) {
		return String(value ?? '').replace(
			/[&<>'"]/g,
			character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character],
		);
	}
	function dateValue(value) {
		if (!value) return undefined;
		const number = Number(value);
		const date = Number.isFinite(number)
			? new Date(number < 1000000000000 ? number * 1000 : number)
			: new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}
	function tagsOf(object) {
		return Array.isArray(object.tags) ? object.tags.filter(tag => tag && tag.id) : [];
	}
	function selected() {
		return new Set(state.selectedIds);
	}
	function setStatus(value, error) {
		const node = app.getElementById('status');
		node.textContent = value || '';
		node.className = error ? 'error' : '';
	}
	function clearCatalog() {
		state.catalogOrgId = '';
		state.catalogObjectType = '';
		state.objects = [];
		state.visibleIds = [];
		state.selectedIds = [];
		state.tags = [];
		state.filters.tagIds = [];
		app.getElementById('results').innerHTML = '';
	}
	function catalogIsCurrent() {
		return state.catalogOrgId === state.selectedOrgId && state.catalogObjectType === state.objectType;
	}
	function sendFilters() {
		if (!catalogIsCurrent()) return;
		vscode.postMessage({
			type: 'applyFilters',
			objectType: state.objectType,
			orgId: state.selectedOrgId,
			filters: state.filters,
		});
	}
	function renderObjectType() {
		const objectDetails = details();
		for (const button of app.querySelectorAll('[data-object-type]')) {
			const isSelected = button.dataset.objectType === state.objectType;
			button.classList.toggle('selected', isSelected);
			button.setAttribute('aria-selected', String(isSelected));
			button.disabled = state.exporting;
		}
		app.getElementById('filters-heading').textContent = objectDetails.title;
		app.getElementById('workflowSearch').placeholder = `Search ${objectDetails.singular} name, ID, or org…`;
		app.getElementById('workflowSearch').setAttribute('aria-label', `Search ${objectDetails.plural}`);
		app.getElementById('refreshCatalog').textContent = `Refresh ${objectDetails.plural}`;
		app.getElementById('refreshCatalog').title = `Refresh ${objectDetails.plural}`;
		app.getElementById('tagList').setAttribute('aria-label', `${objectDetails.title} tags`);
		app.getElementById('filenameOptionLabel').textContent = `Use ${objectDetails.singular} names for filenames`;
		app.getElementById('filenameHelp').textContent =
			`Names are sanitized and include the ${objectDetails.singular} ID to prevent duplicate-name collisions.`;
		app.getElementById('bundleModeLabel').textContent = `Signed bundles (${state.maxObjectsPerExport} per file)`;
	}
	function renderOrganizations() {
		const search = (state.organizationSearch || '').trim().toLocaleLowerCase();
		const matching = state.organizations.filter(org =>
			`${org.name} ${org.id}`.toLocaleLowerCase().includes(search),
		);
		const list = app.getElementById('organizationList');
		const selectedOrg = state.organizations.find(org => org.id === state.selectedOrgId);
		app.getElementById('organizationSearch').value = state.organizationSearch || '';
		app.getElementById('selectedOrganization').textContent = selectedOrg
			? `Selected: ${selectedOrg.name}`
			: 'Choose an organization';
		app.getElementById('changeOrganization').hidden = !selectedOrg;
		app.getElementById('changeOrganization').disabled = state.exporting;
		app.getElementById('organizationPicker').hidden = Boolean(selectedOrg && !state.organizationPickerOpen);
		list.innerHTML =
			matching
				.map(
					org =>
						`<button type="button" class="organization-option${org.id === state.selectedOrgId ? ' selected' : ''}" data-org-id="${esc(org.id)}" role="option" aria-selected="${org.id === state.selectedOrgId}"><strong>${esc(org.name)}</strong><small>${esc(org.id)}</small></button>`,
				)
				.join('') || '<p class="muted">No organizations match this search.</p>';
		for (const button of list.querySelectorAll('[data-org-id]')) {
			button.disabled = state.exporting;
			button.onclick = event => {
				if (state.exporting) return;
				const id = event.currentTarget.dataset.orgId;
				if (!state.organizations.some(org => org.id === id)) return;
				state.selectedOrgId = id;
				state.organizationSearch = '';
				state.organizationPickerOpen = false;
				clearCatalog();
				save();
				render();
				loadCatalog();
			};
		}
	}
	function renderFieldSupport() {
		const support = state.fieldSupport || {};
		app.getElementById('tagFilters').hidden = !support.tags;
		app.getElementById('tagFiltersUnavailable').hidden = Boolean(support.tags);
		for (const label of app.querySelectorAll('[data-created-filter]')) label.hidden = !support.createdAt;
		for (const label of app.querySelectorAll('[data-updated-filter]')) label.hidden = !support.updatedAt;
		app.getElementById('dateFiltersUnavailable').hidden = Boolean(support.createdAt || support.updatedAt);
	}
	function renderTags() {
		if (!state.fieldSupport.tags) return;
		const search = (state.tagSearch || '').trim().toLocaleLowerCase();
		const selectedTags = new Set(state.filters.tagIds);
		const matching = state.tags.filter(
			tag => !search || `${tag.name} ${tag.id}`.toLocaleLowerCase().includes(search) || selectedTags.has(tag.id),
		);
		const list = app.getElementById('tagList');
		app.getElementById('tagSearch').value = state.tagSearch || '';
		app.getElementById('tagSelectionCount').textContent = selectedTags.size
			? `${selectedTags.size} selected`
			: 'All tags';
		app.getElementById('clearTags').disabled = selectedTags.size === 0;
		list.innerHTML =
			matching
				.map(
					tag =>
						`<button type="button" class="tag-option${selectedTags.has(tag.id) ? ' selected' : ''}" data-tag-id="${esc(tag.id)}" role="option" aria-selected="${selectedTags.has(tag.id)}">${esc(tag.name)}<span>${selectedTags.has(tag.id) ? '✓' : '+'}</span></button>`,
				)
				.join('') || '<p class="muted">No tags match this search.</p>';
		for (const button of list.querySelectorAll('[data-tag-id]'))
			button.onclick = event => {
				const id = event.currentTarget.dataset.tagId;
				state.filters.tagIds = selectedTags.has(id)
					? state.filters.tagIds.filter(value => value !== id)
					: [...state.filters.tagIds, id];
				save();
				renderTags();
				sendFilters();
			};
		for (const radio of app.querySelectorAll('input[name="tagMatch"]'))
			radio.checked = radio.value === state.filters.tagMatch;
	}
	function renderObjects() {
		const picked = selected();
		const visible = new Set(state.visibleIds);
		const list = app.getElementById('workflowList');
		const objectDetails = details();
		list.innerHTML =
			state.objects
				.filter(object => visible.has(object.id))
				.map(object => {
					const tags = tagsOf(object)
						.map(tag => `<span class="pill">${esc(tag.name || tag.id)}</span>`)
						.join('');
					const edited = dateValue(object.updatedAt);
					const dateLabel = state.fieldSupport.updatedAt
						? ` · edited ${edited ? esc(edited.toLocaleDateString()) : 'unknown'}`
						: '';
					return `<button type="button" class="workflow${picked.has(object.id) ? ' selected' : ''}" data-object-id="${esc(object.id)}" aria-pressed="${picked.has(object.id)}"><span class="workflow-check" aria-hidden="true">${picked.has(object.id) ? '✓' : ''}</span><span class="workflow-main"><strong>${esc(object.name || object.id)}</strong><small>${esc(object.id)}${dateLabel}</small><span>${tags}</span></span></button>`;
				})
				.join('') || `<p class="muted">No ${objectDetails.plural} match the current filters.</p>`;
		app.getElementById('catalogCount').textContent = `${state.visibleIds.length} / ${state.objects.length}`;
		app.getElementById('selectionCount').textContent =
			`${picked.size} selected · ${state.visibleIds.length} visible`;
		for (const input of app.querySelectorAll('[data-object-id]'))
			input.onclick = event => {
				const id = event.currentTarget.dataset.objectId;
				state.selectedIds = picked.has(id)
					? state.selectedIds.filter(value => value !== id)
					: [...new Set([...state.selectedIds, id])];
				save();
				renderObjects();
				renderActions();
			};
	}
	function renderDestination() {
		const destination = state.destination || { kind: 'directory', isDefault: true };
		app.getElementById('destinationPath').textContent = destination.isDefault
			? destination.path || 'Default Rewst export folder'
			: destination.path || 'Selected folder';
		app.getElementById('chooseFile').disabled =
			state.exporting || state.mode !== 'bundle' || selected().size > state.maxObjectsPerExport;
		app.getElementById('chooseFolder').disabled = state.exporting;
		app.getElementById('useDefault').disabled = state.exporting;
	}
	function renderActions() {
		const count = selected().size;
		app.getElementById('startExport').disabled =
			state.exporting || count === 0 || !state.selectedOrgId || !catalogIsCurrent();
		app.getElementById('cancelExport').hidden = !state.exporting;
		app.getElementById('useWorkflowNames').disabled = state.exporting || state.mode !== 'separate';
		app.getElementById('refreshCatalog').disabled = state.exporting;
		renderDestination();
		renderObjectType();
	}
	function restoreControls() {
		app.getElementById('workflowSearch').value = state.filters.search || '';
		for (const id of ['createdFrom', 'createdTo', 'updatedFrom', 'updatedTo']) {
			app.getElementById(id).value = state.filters[id] || '';
		}
		for (const radio of app.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === state.mode;
		app.getElementById('useWorkflowNames').checked = state.useObjectNames === true;
	}
	function render() {
		restoreControls();
		renderObjectType();
		renderOrganizations();
		renderFieldSupport();
		renderTags();
		renderObjects();
		renderActions();
	}
	function loadCatalog() {
		if (!state.selectedOrgId) return;
		vscode.postMessage({ type: 'loadCatalog', orgId: state.selectedOrgId, objectType: state.objectType });
	}
	function wire() {
		for (const button of app.querySelectorAll('[data-object-type]'))
			button.onclick = event => {
				if (state.exporting) return;
				const objectType = event.currentTarget.dataset.objectType;
				if (!objectTypes[objectType] || objectType === state.objectType) return;
				state.objectType = objectType;
				clearCatalog();
				setStatus('');
				save();
				render();
				loadCatalog();
			};
		app.getElementById('organizationSearch').oninput = event => {
			state.organizationSearch = event.target.value;
			renderOrganizations();
		};
		app.getElementById('changeOrganization').onclick = () => {
			if (state.exporting) return;
			state.organizationPickerOpen = true;
			save();
			renderOrganizations();
			app.getElementById('organizationSearch').focus();
		};
		app.getElementById('refreshCatalog').onclick = () => {
			clearCatalog();
			render();
			loadCatalog();
		};
		app.getElementById('workflowSearch').oninput = event => {
			state.filters.search = event.target.value;
			sendFilters();
		};
		app.getElementById('tagSearch').oninput = event => {
			state.tagSearch = event.target.value;
			renderTags();
		};
		app.getElementById('clearTags').onclick = () => {
			state.filters.tagIds = [];
			save();
			renderTags();
			sendFilters();
		};
		for (const radio of app.querySelectorAll('input[name="tagMatch"]'))
			radio.onchange = event => {
				state.filters.tagMatch = event.target.value;
				save();
				sendFilters();
			};
		for (const id of ['createdFrom', 'createdTo', 'updatedFrom', 'updatedTo'])
			app.getElementById(id).onchange = event => {
				state.filters[id] = event.target.value;
				save();
				sendFilters();
			};
		app.getElementById('selectFiltered').onclick = () => {
			state.selectedIds = [...new Set([...state.selectedIds, ...state.visibleIds])];
			save();
			renderObjects();
			renderActions();
		};
		app.getElementById('clearSelection').onclick = () => {
			state.selectedIds = [];
			save();
			renderObjects();
			renderActions();
		};
		for (const radio of app.querySelectorAll('input[name="mode"]'))
			radio.onchange = event => {
				state.mode = event.target.value;
				save();
				renderActions();
			};
		app.getElementById('useWorkflowNames').onchange = event => {
			state.useObjectNames = event.target.checked;
			save();
		};
		app.getElementById('useDefault').onclick = () => vscode.postMessage({ type: 'useDefaultDestination' });
		app.getElementById('chooseFolder').onclick = () =>
			vscode.postMessage({ type: 'chooseFolder', objectType: state.objectType });
		app.getElementById('chooseFile').onclick = () =>
			vscode.postMessage({ type: 'chooseFile', objectType: state.objectType, objectCount: selected().size });
		app.getElementById('startExport').onclick = () => {
			if (!catalogIsCurrent()) return;
			state.exporting = true;
			save();
			render();
			vscode.postMessage({
				type: 'startExport',
				objectType: state.objectType,
				orgId: state.selectedOrgId,
				objectIds: state.selectedIds,
				mode: state.mode,
				useObjectNames: state.useObjectNames,
			});
		};
		app.getElementById('cancelExport').onclick = () => vscode.postMessage({ type: 'cancelExport' });
	}
	window.addEventListener('message', event => {
		const message = event.data || {};
		if (message.type === 'bootstrap') {
			state.organizations = message.organizations || [];
			state.exporting = false;
			state.maxObjectsPerExport =
				message.maxObjectsPerExport || message.maxWorkflowsPerExport || state.maxObjectsPerExport;
			if (!state.organizations.some(org => org.id === state.selectedOrgId)) {
				state.selectedOrgId = state.organizations[0]?.id || '';
				clearCatalog();
			}
			if (!state.destination || state.destination.isDefault !== false) {
				state.destination = {
					kind: (state.destination && state.destination.kind) || 'directory',
					path: message.defaultDirectory ?? (state.destination && state.destination.path),
					isDefault: true,
				};
			}
			app.getElementById('progress').hidden = true;
			app.getElementById('progress').value = 0;
			save();
			render();
			if (state.selectedOrgId && !catalogIsCurrent()) loadCatalog();
		}
		if (message.type === 'organizations') {
			state.organizations = message.organizations || [];
			if (!state.organizations.some(org => org.id === state.selectedOrgId)) {
				state.selectedOrgId = '';
				clearCatalog();
			}
			save();
			render();
		}
		if (message.type === 'catalogLoading') {
			const objectType = message.objectType || 'workflow';
			const orgId = message.orgId || state.selectedOrgId;
			if (objectType !== state.objectType || orgId !== state.selectedOrgId) return;
			setStatus(`Loading ${details().plural}…`);
			app.getElementById('refreshCatalog').disabled = true;
		}
		if (message.type === 'catalogLoaded') {
			const objectType = message.objectType || 'workflow';
			const orgId = message.orgId || state.selectedOrgId;
			if (objectType !== state.objectType || orgId !== state.selectedOrgId) return;
			state.catalogObjectType = objectType;
			state.catalogOrgId = orgId;
			state.objects = message.objects || message.workflows || [];
			state.visibleIds = state.objects.map(object => object.id);
			state.tags = message.tags || [];
			const defaultFieldSupport =
				objectType === 'workflow'
					? { tags: true, createdAt: true, updatedAt: true }
					: { tags: false, createdAt: false, updatedAt: false };
			state.fieldSupport = Object.assign(defaultFieldSupport, message.fieldSupport || {});
			state.maxObjectsPerExport =
				message.maxObjectsPerExport || message.maxWorkflowsPerExport || state.maxObjectsPerExport;
			if (!state.fieldSupport.tags) state.filters.tagIds = [];
			if (!state.fieldSupport.createdAt) {
				state.filters.createdFrom = '';
				state.filters.createdTo = '';
			}
			if (!state.fieldSupport.updatedAt) {
				state.filters.updatedFrom = '';
				state.filters.updatedTo = '';
			}
			state.filters.tagIds = state.filters.tagIds.filter(id => state.tags.some(tag => tag.id === id));
			state.selectedIds = [];
			app.getElementById('refreshCatalog').disabled = false;
			setStatus(`Loaded ${state.objects.length} ${details().plural}.`);
			save();
			render();
			sendFilters();
		}
		if (message.type === 'filterResult') {
			if (message.objectType !== state.objectType || message.orgId !== state.selectedOrgId) return;
			state.visibleIds = message.objectIds || message.workflowIds || [];
			save();
			renderObjects();
		}
		if (message.type === 'destination') {
			state.destination = { kind: message.kind, path: message.path, isDefault: message.isDefault === true };
			save();
			renderDestination();
		}
		if (message.type === 'exportStarted') {
			if (message.objectType && message.objectType !== state.objectType) return;
			state.exporting = true;
			app.getElementById('progress').hidden = false;
			app.getElementById('progress').value = 0;
			setStatus(`Exporting ${message.objectCount ?? message.workflowCount} ${details().plural}…`);
			save();
			render();
		}
		if (message.type === 'exportProgress') {
			app.getElementById('progress').value = message.percent || 0;
			setStatus(message.message || 'Exporting…');
		}
		if (message.type === 'exportComplete') {
			if (message.objectType && message.objectType !== state.objectType) return;
			state.exporting = false;
			const summary = message.cancelled
				? `Export cancelled. ${message.fileCount || 0} files saved.`
				: `Exported ${message.exportedObjectCount ?? message.exportedWorkflowCount ?? 0} ${details().plural} to ${message.fileCount || 0} files.`;
			setStatus(message.failures?.length ? `${summary} ${message.failures.length} export(s) failed.` : summary);
			const results = app.getElementById('results');
			results.innerHTML = (message.outputPaths || [])
				.map(
					path =>
						`<button class="link" data-reveal="${esc(path)}">Reveal ${esc(path.split(/[\\/]/).pop())}</button>`,
				)
				.join('');
			for (const button of results.querySelectorAll('[data-reveal]'))
				button.onclick = event =>
					vscode.postMessage({ type: 'reveal', path: event.currentTarget.dataset.reveal });
			save();
			render();
		}
		if (message.type === 'error') {
			if (
				(message.objectType && message.objectType !== state.objectType) ||
				(message.orgId && message.orgId !== state.selectedOrgId)
			)
				return;
			state.exporting = false;
			app.getElementById('refreshCatalog').disabled = false;
			setStatus(message.message || 'Export failed.', true);
			save();
			render();
		}
	});
	wire();
	render();
	vscode.postMessage({ type: 'ready' });
})();
