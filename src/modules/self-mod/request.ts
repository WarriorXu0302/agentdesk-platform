/**
 * Delivery-action handlers for agent-initiated self-modification requests.
 *
 * Two actions the container can write into messages_out (via the self-mod
 * MCP tools): install_packages, add_mcp_server. Each validates input and
 * queues an approval request. The admin's approval triggers the matching
 * approval handler in ./apply.ts, which also performs the required follow-up
 * (rebuild+restart for install_packages, restart-only for add_mcp_server).
 *
 * ## Why the validation here is the real validation
 *
 * The MCP tool in the container validates first, but the container is the
 * UNTRUSTED side of the three-DB boundary — that check constrains a
 * cooperating agent, not a compromised one. Everything reaching this file is
 * agent-authored bytes out of `messages_out.content`, and it lands in the
 * agent group's `container.json`, which is GROUP-level: shared by every
 * user's container for that agent. The blast radius of one accepted payload
 * is every colleague using that agent, and the only gate in front of it is
 * one human clicking Approve.
 *
 * That makes the approval card a security control, and it imposes two rules
 * this file exists to hold (ADR-0063):
 *
 *   1. **The card must show everything that will be applied.** The old card
 *      rendered `name (command)` and silently omitted `args` and `env` — the
 *      two fields that actually decide what executes. An admin cannot consent
 *      to what they were never shown.
 *   2. **Agent text must not be able to forge the card.** The card body is
 *      Feishu markdown and the renderer expands escape sequences into real
 *      newlines, so an unescaped agent string can inject whole lines of
 *      convincing "system" text next to the Approve button. Agent-authored
 *      content is therefore fenced, and characters that could break out of
 *      the fence are rejected rather than escaped.
 *
 *      "Agent-authored" includes the agent GROUP NAME, which review caught
 *      being interpolated into the card's opening line raw. `create_agent` is
 *      itself a delivery action, and it persists the container-supplied name
 *      verbatim (only `folder` gets normalized) — so a container can mint a
 *      group whose NAME is forged card prose and then request self-mod from
 *      it. `create-agent.ts` now refuses such names at the source; this file
 *      still scrubs at the point of display, because a name that predates that
 *      check must not be able to forge a card either, and a stored name is not
 *      a good reason to refuse an otherwise valid request.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { readString, readStringArray, readStringRecord } from '../../outbound-contract.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Text that cannot alter how the approval card reads.
 *
 * Excluded, and why each one:
 *
 *   - **Backtick** — the disclosure below is a markdown fence, and a value
 *     carrying three backticks closes it early, letting the remainder render
 *     as card prose the admin reads as system text. Nothing to do with exec
 *     safety; MCP servers are spawned without a shell, so ordinary
 *     metacharacters like pipes and dollar signs are inert and stay allowed.
 *     Over-restricting those would break real invocations and buy nothing.
 *   - **Control characters (`\p{Cc}`) and line/paragraph separators** — a raw
 *     newline splits the disclosure into separately forgeable lines.
 *   - **Backslash** — this one was missed on the first pass and found in
 *     review. Rejecting real control characters is not enough, because the
 *     card renderer REWRITES the string after we validate it:
 *     `normalizeCardText` folds the two-character sequence backslash-n into a
 *     real LF (it exists so a model that emits an escape instead of a newline
 *     still renders readably). So a value containing the literal characters
 *     `\` and `n` passes a control-character check and then becomes a newline
 *     on the approver's screen. Banning the backslash outright is the robust
 *     fix: it does not depend on tracking which escapes that helper currently
 *     expands, and no legitimate MCP command, argument, or environment value
 *     in a Linux container needs one.
 *   - **Format characters (`\p{Cf}`)** — this is the subtle one. Bidi
 *     overrides (U+202E and friends) make displayed text run in a different
 *     order than the stored text, so a name can RENDER as one thing on the
 *     approver's screen and be APPLIED as another. An approval card that can
 *     display something other than what it approves is not a gate.
 *
 * Everything outside those classes is allowed, so non-Latin scripts work
 * normally — an ASCII-only rule would break every non-English deployment.
 */
const SAFE_TEXT_RE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}`\\]*$/u;

const MAX_ARGS = 32;
const MAX_ENV_ENTRIES = 32;
const MAX_FIELD_LEN = 512;

/** Markdown fence used to quote agent-authored content in the approval card. */
const FENCE = '```';

/**
 * Render agent-authored content the admin must inspect.
 *
 * A fenced block, so the payload reads as one visually distinct quoted region
 * rather than as card prose. Validation above guarantees no backtick and no
 * control character can appear inside, so the fence cannot be escaped from —
 * this function is the second half of that contract, not a substitute for it.
 */
function disclose(payload: unknown): string {
  return `${FENCE}\n${JSON.stringify(payload, null, 2)}\n${FENCE}`;
}

/**
 * Render a stored display name that originated outside this module.
 *
 * Scrubs rather than rejects: the name is already persisted, and refusing an
 * otherwise-valid self-mod request because of a historical name would punish
 * the wrong party. Everything SAFE_TEXT_RE excludes is dropped, so the header
 * line stays one line of inert text.
 */
function scrubDisplayName(name: string): string {
  const cleaned = [...name].filter((ch) => SAFE_TEXT_RE.test(ch)).join('');
  const trimmed = cleaned.trim().slice(0, 64);
  return trimmed || 'unnamed agent';
}

export async function handleInstallPackages(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return;
  }

  // Strict reads, not casts. APT_RE.test(123) PASSES — RegExp.test stringifies
  // its argument — so the previous `content.apt as string[]` let a number
  // through the name check and on into a package list destined for a shell.
  const aptR = readStringArray(content, 'apt', { maxItems: MAX_PACKAGES, maxLength: 128, pattern: APT_RE });
  if (!aptR.ok) return reject(session, 'install_packages', aptR.reason);
  const npmR = readStringArray(content, 'npm', { maxItems: MAX_PACKAGES, maxLength: 128, pattern: NPM_RE });
  if (!npmR.ok) return reject(session, 'install_packages', npmR.reason);
  const reasonR = readString(content, 'reason', { maxLength: 1024, pattern: SAFE_TEXT_RE });
  if (!reasonR.ok) return reject(session, 'install_packages', reasonR.reason);

  const apt = aptR.value;
  const npm = npmR.value;
  if (apt.length + npm.length === 0) {
    return reject(session, 'install_packages', 'at least one apt or npm package is required');
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    return reject(session, 'install_packages', `max ${MAX_PACKAGES} packages per request`);
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, reason: reasonR.value },
    title: 'Install Packages Request',
    question:
      `Agent "${scrubDisplayName(agentGroup.name)}" wants to install packages and rebuild its container image.\n` +
      `This applies to the agent GROUP — every user of this agent gets the new image.\n\n` +
      `Exactly this will be added to container.json:\n` +
      disclose({ apt, npm }) +
      (reasonR.value ? `\n\nReason given by the agent:\n${disclose(reasonR.value)}` : ''),
  });
}

export async function handleAddMcpServer(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return;
  }

  const nameR = readString(content, 'name', { required: true, maxLength: 64, pattern: MCP_NAME_RE });
  if (!nameR.ok) return reject(session, 'add_mcp_server', nameR.reason);
  const commandR = readString(content, 'command', { required: true, maxLength: 256, pattern: SAFE_TEXT_RE });
  if (!commandR.ok) return reject(session, 'add_mcp_server', commandR.reason);
  if (commandR.value.length === 0) return reject(session, 'add_mcp_server', '"command" must not be empty');
  const argsR = readStringArray(content, 'args', {
    maxItems: MAX_ARGS,
    maxLength: MAX_FIELD_LEN,
    pattern: SAFE_TEXT_RE,
  });
  if (!argsR.ok) return reject(session, 'add_mcp_server', argsR.reason);
  const envR = readStringRecord(content, 'env', {
    maxEntries: MAX_ENV_ENTRIES,
    maxLength: MAX_FIELD_LEN,
    keyPattern: ENV_KEY_RE,
    // The hole review found: the first cut checked env KEYS and left the VALUES
    // unchecked, so the one agent-controlled string that reached the card
    // unvalidated was the one most likely to carry a payload.
    valuePattern: SAFE_TEXT_RE,
  });
  if (!envR.ok) return reject(session, 'add_mcp_server', envR.reason);

  // The disclosed object is the SAME shape apply.ts writes into
  // cfg.mcpServers[name]. Keep them in lockstep: the moment the card shows a
  // projection of the payload instead of the payload itself, it stops being
  // consent to what actually happens.
  const entry = { command: commandR.value, args: argsR.value, env: envR.value };

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload: { name: nameR.value, ...entry },
    title: 'Add MCP Request',
    question:
      `Agent "${scrubDisplayName(agentGroup.name)}" wants to wire a new MCP server into its runtime.\n` +
      `This applies to the agent GROUP — it will run in every user's container for this ` +
      `agent, with the arguments and environment shown below.\n\n` +
      `Exactly this will be written to container.json under mcpServers."${nameR.value}":\n` +
      disclose(entry),
  });
}

/**
 * Tell the agent precisely what it got wrong.
 *
 * A rejected self-mod request used to surface either as a generic failure or,
 * for a type the handler did not anticipate, as a thrown TypeError that
 * dead-lettered the row with nothing said to anyone. An agent can only correct
 * a request it is told the shape of.
 */
function reject(session: Session, action: string, reason: string): void {
  notifyAgent(session, `${action} failed: ${reason}.`);
  log.warn('Self-mod request rejected at the outbound boundary', { action, reason, sessionId: session.id });
}
