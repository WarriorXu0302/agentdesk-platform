import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  content: object,
  opts?: { platformId?: string; channelType?: string; threadId?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'What is the meaning of life?' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('does not deliver trailing DSML control markers emitted by compatible providers', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">Hi Alice</｜｜DSML｜｜parameter>\n</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Hi Alice');

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage(
      'm-discord',
      { sender: 'Alice', text: 'from discord' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' },
    );
    insertMessage(
      'm-slack',
      { sender: 'Bob', text: 'from slack' },
      { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' },
    );

    // Agent replies to both destinations
    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('bare text falls back to source-destination delivery', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    // Agent responds with bare text — no <message to="..."> wrapping. The
    // poll loop's "reply-source fallback" delivers it to the destination
    // matching the inbound channel/platform (rather than dropping to
    // scratchpad). Many models emit a final result as bare text after a
    // long tool-call chain — see poll-loop.ts handleResultText.
    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait long enough for the poll loop to process
    await sleep(1000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0]!.platform_id).toBe('chan-1');
    expect(out[0]!.channel_type).toBe('discord');
    const body = JSON.parse(out[0]!.content) as { text?: string };
    expect(body.text).toContain('thinking');

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="nonexistent">dropped</message><message to="discord-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // Only the valid destination should produce output
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const discord = out.find((m) => m.platform_id === 'chan-1');
    const slack = out.find((m) => m.platform_id === 'chan-2');
    expect(discord).toBeDefined();
    expect(JSON.parse(discord!.content).text).toBe('for discord');
    expect(slack).toBeDefined();
    expect(JSON.parse(slack!.content).text).toBe('for slack');

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-new', 'Slack New', 'channel', 'slack', 'chan-new', NULL)`,
      )
      .run();

    // Only insert a message from discord — slack-new has never sent anything
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'tell slack' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' },
    );

    const provider = new MockProvider({}, () => '<message to="slack-new">hello slack</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-new');
    expect(out[0].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage(
      'm-old',
      { sender: 'Alice', text: 'old' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old' },
    );
    insertMessage(
      'm-new',
      { sender: 'Alice', text: 'new' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new' },
    );

    const provider = new MockProvider({}, () => '<message to="discord-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('thread-new');
    expect(out[0].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () =>
        '<internal>thinking about this...</internal><message to="discord-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('handles mixed task + chat batch with correct origin metadata', async () => {
    // Seed destination for routing lookup
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'discord' });
    // Task with same routing — simulates a scheduled task in a channel session
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('t-task', 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'daily check' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('should inject destination reminder after a compacted event', async () => {
    // Two destinations — required for the reminder to fire (single-destination
    // groups have a fallback path that works without <message to="…"> wrapping).
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('discord-second', 'Discord Second', 'channel', 'discord', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'First message' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new CompactingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2500);

    await waitFor(() => getUndeliveredMessages().length > 0, 2500);
    controller.abort();

    // The reminder must arrive via pushSystemReminder (stream-reanchor), NOT
    // via push (which OpenAI would re-run as a brand-new turn / LLM call).
    expect(provider.reminders.length).toBeGreaterThanOrEqual(1);
    const reminder = provider.reminders.find((p) => p.includes('Context was just compacted'));
    expect(reminder).toBeDefined();
    expect(reminder).toContain('2 destinations');
    expect(reminder).toContain('discord-test');
    expect(reminder).toContain('discord-second');
    expect(reminder).toContain('<message to="name">');
    // Crucially, the reminder did NOT go through the new-turn push path.
    expect(provider.pushes.some((p) => p.includes('Context was just compacted'))).toBe(false);

    await loopPromise.catch(() => {});
  });

  it('should NOT inject destination reminder with a single destination', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'First message' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new CompactingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2500);

    await waitFor(() => getUndeliveredMessages().length > 0, 2500);
    controller.abort();

    // No reminder on either path, since beforeEach seeds exactly one
    // destination (single-destination groups have a fallback path).
    const reminders = provider.reminders.filter((p) => p.includes('Context was just compacted'));
    expect(reminders).toHaveLength(0);
    expect(provider.pushes.filter((p) => p.includes('Context was just compacted'))).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that emits a single compacted event mid-stream, then returns a
 * result. Captures every push() and pushSystemReminder() call so tests can
 * assert on the injected reminder content. The post-compaction destination
 * reminder must arrive via pushSystemReminder (a stream-reanchor that must NOT
 * spawn a new turn), never via push (new user input).
 */
class CompactingProvider {
  readonly supportsNativeSlashCommands = false;
  readonly pushes: string[] = [];
  readonly reminders: string[] = [];

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const pushes = this.pushes;
    const reminders = this.reminders;
    let ended = false;
    let aborted = false;
    let resolveWaiter: (() => void) | null = null;

    async function* events() {
      yield { type: 'activity' as const };
      yield { type: 'init' as const, continuation: 'compaction-test-session' };
      yield { type: 'activity' as const };
      // Carry a `summary` so the poll-loop's conversation.summary flush branch
      // (ADR-0041) is exercised. No config is loaded in this harness, so
      // getConfig() throws inside the flush — which MUST be caught (folded into
      // the promise chain) and never disrupt the loop or the reminder below.
      yield {
        type: 'compacted' as const,
        text: 'Context compacted (50,000 tokens compacted).',
        summary: 'Summarized the earlier turns.',
      };

      // Wait for poll-loop to push the reminder (or end / abort)
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
        // Belt-and-braces: don't hang forever if the reminder never arrives
        setTimeout(resolve, 200);
      });

      yield { type: 'activity' as const };
      yield { type: 'result' as const, text: '<message to="discord-test">ack</message>' };
      while (!ended && !aborted) {
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
          setTimeout(resolve, 50);
        });
      }
    }

    return {
      push(message: string) {
        pushes.push(message);
        resolveWaiter?.();
      },
      pushSystemReminder(text: string) {
        reminders.push(text);
        resolveWaiter?.();
      },
      end() {
        ended = true;
        resolveWaiter?.();
      },
      abort() {
        aborted = true;
        resolveWaiter?.();
      },
      events: events(),
    };
  }
}

// Helper: run poll loop until aborted or timeout
describe('crash-durability ordering (write order IS the crash semantics)', () => {
  /**
   * Record the ORDER in which statements actually execute against
   * outbound.db. The window between the two writes is microseconds — far too
   * small to observe by polling — so the invariant has to be asserted on the
   * execution sequence itself. Wraps `run` (not `prepare`) so what is
   * recorded is execution, not statement construction.
   */
  function recordOutboundWrites(): { sql: string[]; restore: () => void } {
    const db = getOutboundDb() as unknown as { prepare: (sql: string) => unknown };
    const sql: string[] = [];
    const origPrepare = db.prepare.bind(db);
    db.prepare = (text: string) => {
      const stmt = origPrepare(text) as { run: (...a: unknown[]) => unknown };
      const origRun = stmt.run.bind(stmt);
      stmt.run = (...args: unknown[]) => {
        sql.push(text.replace(/\s+/g, ' ').trim());
        return origRun(...args);
      };
      return stmt;
    };
    return {
      sql,
      restore: () => {
        db.prepare = origPrepare;
      },
    };
  }

  it('writes the reply to outbound.db BEFORE acking the turn — a crash in between duplicates, never silences', async () => {
    // Pins the ordering invariant documented at poll-loop.ts's markCompleted.
    // Inverted (ack first, then write), a container killed in the window
    // records the turn as done with nothing sent: the user's message is
    // answered by permanent silence and no sweep can tell. The chosen order
    // errs the other way — at-least-once, and ADR-0048's content-derived
    // idempotency key stops a replayed business write from committing twice.
    insertMessage('m1', { sender: 'Alice', text: 'status?' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider({}, () => '<message to="discord-test">all good</message>');
    const controller = new AbortController();
    const rec = recordOutboundWrites();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    try {
      await waitFor(() => rec.sql.some((q) => q.includes('processing_ack') && q.includes('completed')), 3000);
    } finally {
      controller.abort();
      rec.restore();
    }
    await loopPromise.catch(() => {});

    const reply = rec.sql.findIndex((q) => q.startsWith('INSERT INTO messages_out'));
    const ack = rec.sql.findIndex((q) => q.includes('processing_ack') && q.includes('completed'));
    expect(reply).toBeGreaterThanOrEqual(0);
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(reply).toBeLessThan(ack); // THE INVARIANT

    // And the reply really is on disk, not merely attempted.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('all good');
  });

  it('a follow-up pushed into a live query is not acked before that push happened', async () => {
    // The bigger half of the same hole: follow-ups used to be acked the
    // instant they were pushed, before the model had produced anything for
    // them — a window a whole model turn wide, and permanent (a 'completed'
    // ack is synced to messages_in and never re-driven).
    //
    // Asserted on the recorded SQL sequence, driven by THIS test's own
    // provider. An earlier version polled for a 'processing' snapshot and
    // only passed because a leaked poll loop from another test happened to
    // own the row — it failed 8/8 when run alone. The provider below holds
    // the stream open and signals when it has actually received the push, so
    // the sequence is produced here and nowhere else.
    let pushed: (() => void) | undefined;
    const sawPush = new Promise<void>((r) => {
      pushed = r;
    });
    class HoldingProvider {
      readonly supportsNativeSlashCommands = false;
      isSessionInvalid(): boolean {
        return false;
      }
      query() {
        let ended = false;
        return {
          push() {
            pushed?.();
          },
          pushSystemReminder() {},
          end() {
            ended = true;
          },
          abort() {
            ended = true;
          },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'activity' as const };
              yield { type: 'init' as const, continuation: 'holding-1' };
              // Hold the stream open so the follow-up takes the push path
              // rather than starting a fresh turn.
              while (!ended) await new Promise((r) => setTimeout(r, 10));
            },
          },
        };
      }
    }

    insertMessage('m1', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'discord' });
    const controller = new AbortController();
    const rec = recordOutboundWrites();
    const loopPromise = runPollLoopWithTimeout(
      new HoldingProvider() as unknown as MockProvider,
      controller.signal,
      5000,
    );

    // Wait until m1 is claimed and the stream is open.
    await waitFor(() => rec.sql.some((q) => q.includes("'processing'")), 3000);

    // A follow-up arrives mid-turn. trigger=0 keeps the pending-user-trigger
    // latch from deferring it, so it takes the push path — the same path a
    // scheduled task row (kind='task') takes.
    getInboundDb()
      .prepare(
        'INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content, trigger) ' +
          "VALUES ('m2', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?, 0)",
      )
      .run(JSON.stringify({ sender: 'Alice', text: 'second' }));

    await sawPush;
    // Let any ack that the push path would have issued actually land.
    await sleep(50);
    controller.abort();
    rec.restore();
    await loopPromise.catch(() => {});

    // THE ASSERTION: the push happened, and no 'completed' ack was written
    // for it. Killed here, the host re-drives m2 instead of recording it
    // answered by silence.
    const completedAcks = rec.sql.filter((q) => q.includes('processing_ack') && q.includes("'completed'"));
    expect(completedAcks).toHaveLength(0);
    // ...and the row really was claimed, so it is withheld from re-claim by
    // markProcessing rather than by an ack.
    const claimed = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('m2') as
      { status: string } | undefined;
    expect(claimed?.status).toBe('processing');
  });

  it('a turn killed before it finishes leaves the claim un-acked, so the work is re-drivable', async () => {
    // The other half of the guarantee: crash BEFORE the reply exists must not
    // leave the message looking handled.
    insertMessage('m1', { sender: 'Alice', text: 'slow one' }, { platformId: 'chan-1', channelType: 'discord' });

    // Provider that never produces a result — the container dies mid-think.
    const stalled = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query: () => ({
        push() {},
        pushSystemReminder() {},
        end() {},
        abort() {},
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'activity' as const };
            await new Promise((r) => setTimeout(r, 10_000));
          },
        },
      }),
    };
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(stalled as unknown as MockProvider, controller.signal, 600);
    await loopPromise.catch(() => {});
    controller.abort();

    const ack = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('m1') as
      { status: string } | undefined;
    expect(ack?.status).not.toBe('completed');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('reply anchor integrity (a2a return path)', () => {
  it('a reply to a peer anchors on THIS turn’s trigger, not the newest row from that peer', async () => {
    // The host routes a2a replies by dereferencing in_reply_to → origin
    // session, so an anchor stolen by a row that arrived mid-turn (another
    // user's delegation into a shared worker) is a cross-USER delivery.
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('parent-desk', 'Parent Desk', 'agent', NULL, NULL, 'ag-parent')`,
      )
      .run();
    // m1 = this turn's trigger; m2 = a second delegation from the SAME peer
    // already sitting in the db when the reply is dispatched (newest by seq).
    insertMessage(
      'm1',
      { sender: 'desk', text: 'alice asks: quarterly numbers?' },
      { platformId: 'ag-parent', channelType: 'agent' },
    );
    insertMessage(
      'm2',
      { sender: 'desk', text: 'bob asks: headcount?' },
      { platformId: 'ag-parent', channelType: 'agent' },
    );

    const provider = new MockProvider({}, () => '<message to="parent-desk">numbers attached</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 3000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    // the turn anchor (first row of the batch) — NOT the newest row m2
    expect(out[0].in_reply_to).toBe('m1');

    await loopPromise.catch(() => {});
  });
});

describe('reply anchor peer filter', () => {
  it('the turn anchor only applies to ITS OWN peer — other peers keep most-recent resolution', async () => {
    // Red-team: deleting the channel/platform predicate from the anchor
    // lookup passed the whole suite. Pin it: the turn anchor here belongs to
    // peer "other-desk" (first row of the batch); a reply to "parent-desk"
    // must NOT inherit it and falls back to parent's own newest row.
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('parent-desk', 'Parent Desk', 'agent', NULL, NULL, 'ag-parent'),
                ('other-desk', 'Other Desk', 'agent', NULL, NULL, 'ag-other')`,
      )
      .run();
    // mY first → it is the batch's turn anchor (peer: ag-other).
    insertMessage('mY', { sender: 'other', text: 'status?' }, { platformId: 'ag-other', channelType: 'agent' });
    insertMessage('m1', { sender: 'desk', text: 'numbers?' }, { platformId: 'ag-parent', channelType: 'agent' });

    const provider = new MockProvider(
      {},
      () => '<message to="other-desk">fine</message><message to="parent-desk">attached</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 3000);
    controller.abort();

    const out = getUndeliveredMessages();
    const otherOut = out.find((m) => m.platform_id === 'ag-other');
    const parentOut = out.find((m) => m.platform_id === 'ag-parent');
    expect(otherOut!.in_reply_to).toBe('mY'); // its own turn anchor
    expect(parentOut!.in_reply_to).toBe('m1'); // NOT mY — falls back to parent's newest

    await loopPromise.catch(() => {});
  });
});

describe('stale continuation recovery', () => {
  /**
   * Provider whose stream throws a stale-session error whenever a
   * continuation is passed, and succeeds fresh. Mirrors the Claude SDK's
   * behavior when the resume id points at a transcript that no longer exists
   * (e.g. a host upgrade rescoped ~/.claude — ADR-0055).
   */
  class StaleContinuationProvider {
    readonly supportsNativeSlashCommands = false;
    readonly continuations: (string | undefined)[] = [];

    isSessionInvalid(err: unknown): boolean {
      return /no conversation found/i.test(err instanceof Error ? err.message : String(err));
    }

    query(input: { prompt: string; continuation?: string }) {
      this.continuations.push(input.continuation);
      const stale = Boolean(input.continuation);
      const events = {
        async *[Symbol.asyncIterator]() {
          if (stale) throw new Error('No conversation found with session ID stale-1');
          yield { type: 'init' as const, continuation: 'fresh-1' };
          yield { type: 'result' as const, text: '<message to="discord-test">recovered</message>' };
        },
      };
      return { push() {}, pushSystemReminder() {}, end() {}, abort() {}, events };
    }
  }

  it('retries the SAME turn fresh instead of burning it on a user-facing error', async () => {
    const { setContinuation, getContinuation } = await import('./db/session-state.js');
    setContinuation('mock', 'stale-1');
    insertMessage('m1', { sender: 'Alice', text: '接着上面继续' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new StaleContinuationProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 3000);
    controller.abort();

    // first attempt resumed, second ran fresh — same turn, no error reply
    expect(provider.continuations).toEqual(['stale-1', undefined]);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('recovered');
    // the stale id was cleared and the fresh session persisted
    expect(getContinuation('mock')).toBe('fresh-1');

    await loopPromise.catch(() => {});
  });
});

async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
      // Pass the signal through — without it, aborting only rejects the race
      // while the loop (and its poll interval) keeps running in the
      // background, holding the event loop open and writing into whatever
      // test DB comes next. runPollLoop has honored config.signal all along;
      // this helper simply never handed it over.
      signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
