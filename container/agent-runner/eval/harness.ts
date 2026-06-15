/**
 * Agent eval / replay harness (benchmark lesson #2 — Rasa/ADK-style assertable
 * trajectories, see docs/decisions/ADR-0047).
 *
 * AgentDesk's "everything is a message row" IO model means a seeded `inbound.db`
 * + the resulting `outbound.db` IS a replayable, assertable trajectory — no new
 * instrumentation needed. This harness turns that into a declarative regression
 * gate: each case seeds destinations + inbound messages, drives the REAL
 * poll-loop in-process (no Docker) with a scripted provider response, and
 * asserts the outbound rows with a small domain vocabulary
 * (delegates_to / delivers_to / text_contains / …).
 *
 * MODES:
 *  - PLUMBING (this file, default): a scripted MockProvider response exercises
 *    the deterministic runner surface — output parsing, destination resolution,
 *    a2a delegation routing, batching, reply-source fallback, thread/identity
 *    propagation. Locally runnable under `bun test`, gated in CI.
 *  - QUALITY (future, opt-in): swap MockProvider for a real provider + an
 *    LLM-judge assertion to test classification/answer quality. Same case shape;
 *    the real provider invokes the MCP tools the mock cannot. See README.
 *
 * A scripted mock cannot invoke MCP tools, so a `<message to="worker">` against
 * an `type:'agent'` destination is how PLUMBING mode exercises delegation: the
 * poll-loop resolves it to a `channel_type='agent'` outbound row — exactly the
 * routing the misroute/nack feedback (ADR-0040) is about.
 */
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../src/db/connection.js';
import { getUndeliveredMessages } from '../src/db/messages-out.js';
import { MockProvider } from '../src/providers/mock.js';
import { runPollLoop } from '../src/poll-loop.js';

export interface EvalDestination {
  name: string;
  displayName?: string;
  type: 'channel' | 'agent';
  channelType?: string | null;
  platformId?: string | null;
  agentGroupId?: string | null;
}

export interface EvalMessage {
  id: string;
  text: string;
  sender?: string;
  senderId?: string;
  kind?: 'chat' | 'task';
  platformId?: string | null;
  channelType?: string | null;
  threadId?: string | null;
}

/** One assertion = exactly one key. Unknown keys fail loudly (catch typos). */
export interface EvalAssertion {
  outboundCount?: number;
  delegatesTo?: string; // agent_group_id of a channel_type='agent' outbound
  deliversTo?: { platformId?: string; channelType?: string };
  textContains?: string;
  textEquals?: string;
  inReplyTo?: string;
  threadId?: string;
  noOutput?: boolean;
}

export interface EvalCase {
  name: string;
  description?: string;
  destinations?: EvalDestination[];
  messages: EvalMessage[];
  /** Scripted provider output for PLUMBING mode (one turn). */
  agentResponse: string;
  assert: EvalAssertion[];
}

export interface EvalResult {
  name: string;
  pass: boolean;
  failures: string[];
}

interface OutboundRow {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  content: string;
}

const ASSERT_KEYS = new Set<keyof EvalAssertion>([
  'outboundCount',
  'delegatesTo',
  'deliversTo',
  'textContains',
  'textEquals',
  'inReplyTo',
  'threadId',
  'noOutput',
]);

function textOf(row: OutboundRow): string {
  try {
    const c = JSON.parse(row.content) as { text?: string };
    return typeof c.text === 'string' ? c.text : '';
  } catch {
    return '';
  }
}

/** Check one assertion against the outbound rows; return a failure string or null. */
function checkOne(a: EvalAssertion, out: OutboundRow[]): string | null {
  const keys = Object.keys(a).filter((k) => a[k as keyof EvalAssertion] !== undefined);
  if (keys.length !== 1) return `assertion must have exactly one key, got: [${keys.join(', ')}]`;
  const key = keys[0] as keyof EvalAssertion;
  if (!ASSERT_KEYS.has(key)) return `unknown assertion key: ${key}`;

  if (a.outboundCount !== undefined) {
    return out.length === a.outboundCount ? null : `expected outboundCount=${a.outboundCount}, got ${out.length}`;
  }
  if (a.noOutput) {
    return out.length === 0 ? null : `expected no output, got ${out.length} row(s)`;
  }
  if (a.delegatesTo !== undefined) {
    const hit = out.some((r) => r.channel_type === 'agent' && r.platform_id === a.delegatesTo);
    if (hit) return null;
    return `expected a2a delegation to "${a.delegatesTo}" (channel_type=agent); got: ${summary(out)}`;
  }
  if (a.deliversTo !== undefined) {
    const { platformId, channelType } = a.deliversTo;
    const hit = out.some(
      (r) =>
        (platformId === undefined || r.platform_id === platformId) &&
        (channelType === undefined || r.channel_type === channelType),
    );
    return hit ? null : `expected delivery to ${JSON.stringify(a.deliversTo)}; got: ${summary(out)}`;
  }
  if (a.textContains !== undefined) {
    const hit = out.some((r) => textOf(r).includes(a.textContains as string));
    if (hit) return null;
    return `expected outbound text to contain "${a.textContains}"; got: ${out.map(textOf).join(' | ')}`;
  }
  if (a.textEquals !== undefined) {
    const hit = out.some((r) => textOf(r) === a.textEquals);
    if (hit) return null;
    return `expected outbound text to equal "${a.textEquals}"; got: ${out.map(textOf).join(' | ')}`;
  }
  if (a.inReplyTo !== undefined) {
    const hit = out.some((r) => r.in_reply_to === a.inReplyTo);
    if (hit) return null;
    return `expected in_reply_to="${a.inReplyTo}"; got: ${out.map((r) => r.in_reply_to).join(', ')}`;
  }
  if (a.threadId !== undefined) {
    const hit = out.some((r) => r.thread_id === a.threadId);
    if (hit) return null;
    return `expected thread_id="${a.threadId}"; got: ${out.map((r) => r.thread_id).join(', ')}`;
  }
  return `unhandled assertion: ${JSON.stringify(a)}`;
}

function summary(out: OutboundRow[]): string {
  return JSON.stringify(out.map((r) => ({ kind: r.kind, channel_type: r.channel_type, platform_id: r.platform_id })));
}

/**
 * Run a single eval case in-process (no Docker) and return pass/failures.
 * Caller is responsible for `bun test` assertions (eval.test.ts) — this keeps
 * the harness usable both as a test and as a standalone script.
 */
export async function runEvalCase(c: EvalCase): Promise<EvalResult> {
  initTestSessionDb();
  try {
    const inDb = getInboundDb();
    for (const d of c.destinations ?? []) {
      inDb
        .prepare(
          `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          d.name,
          d.displayName ?? d.name,
          d.type,
          d.channelType ?? null,
          d.platformId ?? null,
          d.agentGroupId ?? null,
        );
    }
    for (const m of c.messages) {
      const content =
        m.kind === 'task'
          ? { prompt: m.text }
          : { sender: m.sender ?? 'User', senderId: m.senderId ?? 'u1', text: m.text };
      inDb
        .prepare(
          `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
           VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
        )
        .run(
          m.id,
          m.kind ?? 'chat',
          m.platformId ?? null,
          m.channelType ?? null,
          m.threadId ?? null,
          JSON.stringify(content),
        );
    }

    const provider = new MockProvider({}, () => c.agentResponse);
    const controller = new AbortController();
    const loop = Promise.race([
      runPollLoop({ provider, providerName: 'mock', cwd: '/tmp' }),
      new Promise<void>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')))),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);

    const expectNoOutput = c.assert.some((a) => a.noOutput);
    if (expectNoOutput) {
      await sleep(900); // let the loop run a full cycle; assert nothing came out
    } else {
      await waitFor(() => getUndeliveredMessages().length > 0, 3000).catch(() => {});
      await sleep(150); // settle: allow a multi-message turn to finish writing all rows
    }
    controller.abort();
    await loop.catch(() => {});

    const out = getUndeliveredMessages() as unknown as OutboundRow[];
    const failures = c.assert.map((a) => checkOne(a, out)).filter((f): f is string => f !== null);
    return { name: c.name, pass: failures.length === 0, failures };
  } finally {
    closeSessionDb();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}
