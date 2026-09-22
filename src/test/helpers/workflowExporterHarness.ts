import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

export class FakeWorkflowExporterElement {
	value = '';
	checked = false;
	disabled = false;
	hidden = false;
	textContent = '';
	className = '';
	innerHTML = '';
	placeholder = '';
	title = '';
	onclick?: (event: { currentTarget: FakeWorkflowExporterElement; target: FakeWorkflowExporterElement }) => void;
	oninput?: (event: { target: FakeWorkflowExporterElement }) => void;
	onchange?: (event: { target: FakeWorkflowExporterElement }) => void;
	dataset: Record<string, string> = {};
	private readonly attributes = new Map<string, string>();
	classList = { toggle: (_name: string, _enabled?: boolean) => false };

	querySelectorAll(): FakeWorkflowExporterElement[] {
		return [];
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	focus(): void {}
}

export function createWorkflowExporterHarness(persistedState?: Record<string, unknown>) {
	const elements = new Map<string, FakeWorkflowExporterElement>();
	const element = (id: string): FakeWorkflowExporterElement => {
		let result = elements.get(id);
		if (!result) {
			result = new FakeWorkflowExporterElement();
			elements.set(id, result);
		}
		return result;
	};
	const modeRadios = ['separate', 'bundle'].map(value => Object.assign(new FakeWorkflowExporterElement(), { value }));
	const tagRadios = ['any', 'all'].map(value => Object.assign(new FakeWorkflowExporterElement(), { value }));
	const objectButtons = ['workflow', 'template', 'form'].map(objectType =>
		Object.assign(new FakeWorkflowExporterElement(), { dataset: { objectType } }),
	);
	const createdFilters = [new FakeWorkflowExporterElement(), new FakeWorkflowExporterElement()];
	const updatedFilters = [new FakeWorkflowExporterElement(), new FakeWorkflowExporterElement()];
	const collections: Record<string, FakeWorkflowExporterElement[]> = {
		'[data-object-type]': objectButtons,
		'[data-workflow-only]': [],
		'[data-created-filter]': createdFilters,
		'[data-updated-filter]': updatedFilters,
		'[data-object-id]': [],
		'input[name="tagMatch"]': tagRadios,
		'input[name="mode"]': modeRadios,
	};
	let listener: ((event: { data: unknown }) => void) | undefined;
	let savedState: Record<string, unknown> | undefined;
	let saveCount = 0;
	const postedMessages: unknown[] = [];
	const source = readFileSync(join(process.cwd(), 'media/workflow-exporter/main.js'), 'utf8');
	vm.runInNewContext(source, {
		acquireVsCodeApi: () => ({
			getState: () => persistedState,
			setState: (value: Record<string, unknown>) => {
				savedState = value;
				saveCount++;
			},
			postMessage: (message: unknown) => postedMessages.push(message),
		}),
		document: {
			getElementById: element,
			querySelectorAll: (selector: string) => {
				if (!(selector in collections)) throw new Error(`Unexpected workflow exporter selector: ${selector}`);
				return collections[selector];
			},
		},
		window: {
			addEventListener: (type: string, handler: (event: { data: unknown }) => void) => {
				if (type !== 'message') throw new Error(`Unexpected workflow exporter event: ${type}`);
				listener = handler;
			},
		},
		Set,
		Date,
		Number,
		String,
	});
	return {
		element,
		modeRadios,
		tagRadios,
		objectButtons,
		createdFilters,
		updatedFilters,
		postedMessages,
		get savedState() {
			return savedState;
		},
		get saveCount() {
			return saveCount;
		},
		send: (data: unknown) => listener?.({ data }),
	};
}
