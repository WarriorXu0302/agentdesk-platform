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
  /**
   * Optional platform handle of the single user allowed to action this card.
   * Approval producers thread the chosen approver's handle here so the
   * card-action gate scopes to a KNOWN identity rather than relying on the
   * incidental id-type of the delivery target (see
   * `approverExpectedUserId` + the Feishu render reconcile). Channel renderers
   * that don't enforce per-user card scoping ignore it — the field is additive.
   */
  expectedUserId?: string;
}

/**
 * Derive the `expectedUserId` for an approval card from the chosen approver's
 * user id. Approver ids are namespaced `kind:handle` (e.g. `feishu:ou_xxx`),
 * but the card-action gate compares against the raw operator handle (Feishu's
 * `open_id`), so we strip the channel namespace here.
 *
 * IMPORTANT (the landmine): the stripped handle must be in the SAME id-space
 * the operator callback reports. For Feishu that's the `open_id` (`ou_…`) —
 * `extractAndUpsertUser` stores the sender's open_id, and the card-action
 * handler reads `operator.open_id` first. Passing a non-open_id handle here
 * would make the gate reject the legitimate approver, so the Feishu render
 * only honors an open_id-shaped value and otherwise falls back to its
 * delivery-target derivation.
 *
 * Returns undefined for an empty/unnamespaced id so callers can spread it
 * conditionally.
 */
export function approverExpectedUserId(approverUserId: string | undefined): string | undefined {
  if (!approverUserId) return undefined;
  const idx = approverUserId.indexOf(':');
  const handle = (idx >= 0 ? approverUserId.slice(idx + 1) : approverUserId).trim();
  return handle || undefined;
}
