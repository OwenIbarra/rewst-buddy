/**
 * Prompt scaffolding for messages sent to the Rewst AI assistant. (Chat
 * attachments/selections are inlined by the chat UI itself in model-provider
 * mode, so the old reference-resolution helpers are gone.)
 */

import { truncateToBudget } from '../../utils/messageBudget';

/**
 * Cap on the standing instructions carried by one turn. The setting is
 * user-authored and unbounded, and the instructions are placed AHEAD of the
 * user's actual question — so without a cap a very long value would crowd the
 * question out of the message the backend accepts, and the transport clamp would
 * drop the request rather than the preamble.
 */
export const MAX_STANDING_INSTRUCTIONS_CHARS = 8_000;

/**
 * Prepends the user's standing instructions to a message. Not a real system
 * prompt — RoboRewsty's system prompt is server-side and immutable — but the
 * assistant honors per-message preambles in practice.
 */
export function prependInstructions(message: string, instructions: string | undefined): string {
	const trimmed = instructions?.trim();
	if (!trimmed) return message;
	const bounded = truncateToBudget(trimmed, MAX_STANDING_INSTRUCTIONS_CHARS);
	return `${PREAMBLE_LABEL}${bounded}\n\n---\n\n${message}`;
}

const PREAMBLE_LABEL = "User's standing instructions: ";

/**
 * What {@link prependInstructions} will actually add to a message, so callers can
 * budget the elastic parts of a turn against the bounded cost rather than the raw
 * setting's length.
 */
export function standingInstructionsCost(instructions: string | undefined): number {
	const trimmed = instructions?.trim();
	if (!trimmed) return 0;
	return PREAMBLE_LABEL.length + Math.min(trimmed.length, MAX_STANDING_INSTRUCTIONS_CHARS) + '\n\n---\n\n'.length;
}
