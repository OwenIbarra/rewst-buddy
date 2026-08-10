import { truncateToBudget } from '@utils';
import vscode from 'vscode';

const MAX_ENTRY_CHARS = 8_000;
/**
 * Default ceiling when the caller passes no budget. Kept under the backend's
 * per-message cap; the provider passes a tighter, computed budget that accounts
 * for the directive and tool manifest sharing the same message.
 */
const MAX_TOTAL_CHARS = 48_000;
// Terminal-reading tools (VS Code agent mode's run_in_terminal, get_terminal_output,
// etc.) can surface scrollback from an unrelated session in the same integrated
// terminal. Cap and frame that output much tighter than other tool results so the
// backend doesn't treat leftover terminal text as an implicit directive (#168).
const TERMINAL_TOOL_NAME_PATTERN = /terminal/i;
const MAX_TERMINAL_OUTPUT_CHARS = 2_000;
const TERMINAL_OUTPUT_FRAME =
	'(raw terminal output — likely unrelated to the current request unless the user explicitly asked about the terminal)';

const OPEN_TAG = '<visible_chat_transcript>';
const CLOSE_TAG = '</visible_chat_transcript>';
const TRANSCRIPT_INSTRUCTION =
	'The user is talking from VS Code. Treat this visible transcript as the authoritative conversation context. Answer only the latest USER entry; use earlier entries only as context.';
const ENTRY_SEPARATOR = '\n\n';
/** Wrapper tags, instruction line and the newlines joining them to the entries. */
const FRAME_CHARS = OPEN_TAG.length + CLOSE_TAG.length + TRANSCRIPT_INSTRUCTION.length + 4;
/** Headroom for the "(N earlier message(s) omitted)" disclosure when it appears. */
const OMISSION_RESERVE = 40;

type RequestMessage = Pick<vscode.LanguageModelChatRequestMessage, 'role' | 'content'>;

interface ToolCallInfo {
	name: string;
	input: unknown;
}

interface PartLike {
	value?: unknown;
	callId?: unknown;
	name?: unknown;
	input?: unknown;
	content?: unknown;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function textOf(part: unknown): string {
	if (typeof part === 'string') return part;
	const candidate = part as PartLike;
	return typeof candidate?.value === 'string' ? candidate.value : '';
}

function stripActivity(text: string): string {
	return text.replace(/^> _.*_$/gm, '').trim();
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)} ...(truncated)` : text;
}

function roleLabel(role: vscode.LanguageModelChatMessageRole): string {
	if (role === vscode.LanguageModelChatMessageRole.User) return 'USER';
	if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'ASSISTANT';
	return 'MESSAGE';
}

function collectCalls(messages: readonly RequestMessage[]): Map<string, ToolCallInfo> {
	const calls = new Map<string, ToolCallInfo>();
	for (const message of messages) {
		for (const part of message.content) {
			const candidate = part as PartLike;
			if (typeof candidate?.callId === 'string' && typeof candidate.name === 'string') {
				calls.set(candidate.callId, { name: candidate.name, input: candidate.input });
			}
		}
	}
	return calls;
}

function serializePart(part: unknown, calls: ReadonlyMap<string, ToolCallInfo>): string {
	const text = stripActivity(textOf(part));
	if (text) return text;

	const candidate = part as PartLike;
	if (typeof candidate?.callId !== 'string') return '';

	if (typeof candidate.name === 'string') {
		const args = candidate.input === undefined ? '' : ` ${safeJson(candidate.input)}`;
		return `Requested editor tool: ${candidate.name}${args}`;
	}

	if (Array.isArray(candidate.content)) {
		const call = calls.get(candidate.callId);
		const name = call?.name ?? 'tool';
		const args = call?.input === undefined ? '' : ` ${safeJson(call.input)}`;
		const rawOutput = candidate.content.map(textOf).filter(Boolean).join('\n');
		if (TERMINAL_TOOL_NAME_PATTERN.test(name)) {
			const output = truncate(rawOutput, MAX_TERMINAL_OUTPUT_CHARS);
			return `Editor tool result: ${name}${args}\n${TERMINAL_OUTPUT_FRAME}\n${output}`;
		}
		return `Editor tool result: ${name}${args}\n${rawOutput}`;
	}

	return '';
}

/**
 * Serializes the visible chat for a stateless turn, within `maxTotalChars`.
 * Oldest entries are dropped first; if the newest entry alone still overflows it
 * is truncated, so the caller's overall message budget always holds (#189).
 */
export function serializeVisibleChat(messages: readonly RequestMessage[], maxTotalChars = MAX_TOTAL_CHARS): string {
	const calls = collectCalls(messages);
	const entries: string[] = [];

	for (const message of messages) {
		const body = message.content
			.map(part => serializePart(part, calls))
			.filter(Boolean)
			.join('\n')
			.trim();
		if (!body) continue;
		entries.push(
			`${roleLabel(message.role as vscode.LanguageModelChatMessageRole)}: ${truncate(body, MAX_ENTRY_CHARS)}`,
		);
	}

	if (entries.length === 0) return '';

	// maxTotalChars bounds the WHOLE serialized transcript, so the wrapper tags,
	// the fixed instruction line, the omission disclosure and the separators
	// between entries are reserved before any entry is kept.
	const entryBudget = Math.max(
		0,
		maxTotalChars - FRAME_CHARS - (entries.length - 1) * ENTRY_SEPARATOR.length - OMISSION_RESERVE,
	);

	let dropped = 0;
	let total = entries.reduce((sum, entry) => sum + entry.length, 0);
	while (total > entryBudget && entries.length > 1) {
		const removed = entries.shift();
		if (removed === undefined) break;
		total -= removed.length;
		dropped++;
	}
	// The newest entry is kept even when it alone exceeds the budget (dropping it
	// would discard the actual request), so trim it to fit.
	if (total > entryBudget && entries.length === 1) {
		entries[0] = truncateToBudget(entries[0], entryBudget);
	}

	const omitted = dropped > 0 ? `\n(${dropped} earlier message(s) omitted)` : '';
	return `${OPEN_TAG}\n${TRANSCRIPT_INSTRUCTION}${omitted}\n\n${entries.join(ENTRY_SEPARATOR)}\n${CLOSE_TAG}`;
}
