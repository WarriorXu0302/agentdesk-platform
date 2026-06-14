/**
 * Shared ask_question payload schema + normalization.
 *
 * Producers (host-side approvals, container-side ask_user_question MCP tool)
 * emit an `ask_question` payload. Options may be bare strings for ergonomics,
 * but are normalized here into a consistent shape before delivery, persistence,
 * and rendering.
 */

/**
 * Sentinel `selectedOption` value used when a pending question is resolved by an
 * out-of-band cancel (ADR-0042, roadmap 6.6) rather than a real answer. It rides
 * the SAME `question_response` path a button click uses, so no new container
 * contract is needed; the container returns it to the agent and the convention
 * in `container/CLAUDE.md` tells the agent it means "user withdrew the request —
 * stop and roll back, do not retry". The accompanying `cancelled: true` field is
 * additive (older readers ignore it).
 */
export const CANCEL_SENTINEL = '__cancelled__';

export interface OptionInput {
  label: string;
  selectedLabel?: string;
  value?: string;
}

export type RawOption = string | OptionInput;

export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
}

export function normalizeOption(raw: RawOption): NormalizedOption {
  if (typeof raw === 'string') {
    return { label: raw, selectedLabel: raw, value: raw };
  }
  const label = raw.label;
  return {
    label,
    selectedLabel: raw.selectedLabel ?? label,
    value: raw.value ?? label,
  };
}

export function normalizeOptions(raws: RawOption[]): NormalizedOption[] {
  return raws.map(normalizeOption);
}

export interface AskQuestionPayload {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}
