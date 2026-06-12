/**
 * scripts/replay-inbound.ts — operator tool for the inbound ingress recovery
 * ledger (ADR-0022).
 *
 * The host persists every inbound envelope to the central inbound_ingress table
 * BEFORE routing it, so a failure between webhook-200 and the messages_in write
 * (session inbound.db SQLITE_BUSY, attachment IO, transient central-DB error,
 * host crash mid-route) leaves a recoverable row instead of silently dropping
 * the message. This tool lists those rows and, on explicit request, replays
 * them by re-feeding the stored envelope through routeInbound.
 *
 * Usage:
 *   pnpm exec tsx scripts/replay-inbound.ts --list          # failed + received rows
 *   pnpm exec tsx scripts/replay-inbound.ts --replay <id>   # replay one row
 *   pnpm exec tsx scripts/replay-inbound.ts --replay-all    # replay every row
 *
 * !!! WARNING — replay can DOUBLE-DELIVER !!!
 *   Adapter-layer dedup (markInboundSeen, keyed on the channel event_id) runs
 *   BEFORE routeInbound, so replaying here RE-ENTERS routing BELOW the dedup
 *   boundary. If the original message was actually delivered (e.g. it failed on
 *   a second fan-out agent after the first already wrote messages_in, or the
 *   row was orphaned at status='received' by a crash that happened after the
 *   write), replay will deliver it a SECOND time. Only replay rows you have
 *   confirmed were NOT processed. Inspect last_error / attempts and the
 *   downstream session before replaying.
 *
 * Single-writer caution (mirrors scripts/dlq.ts): the inbound_ingress ledger
 * lives in the host-single-writer central v2.db, so this tool's own ledger
 * writes are safe. But a replay calls routeInbound, which writes each target
 * session's host-owned inbound.db — the SAME files the live host writes. Run
 * replays while the host is STOPPED or during a low-traffic window so the
 * replay process and the host don't contend for those per-session locks.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import {
  deleteIngress,
  getIngress,
  listIngress,
  markIngressFailed,
  type IngressRow,
} from '../src/db/inbound-ingress.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { routeInbound } from '../src/router.js';
import type { InboundEvent } from '../src/channels/adapter.js';

function usage(): never {
  console.error('usage: pnpm exec tsx scripts/replay-inbound.ts [--list | --replay <id> | --replay-all]');
  process.exit(2);
}

/** Short, single-line view of the stored envelope's text/sender for the listing. */
function summarizeEnvelope(messageJson: string): string {
  try {
    const event = JSON.parse(messageJson) as InboundEvent;
    let text = '';
    try {
      const content = JSON.parse(event.message?.content ?? '') as Record<string, unknown>;
      if (typeof content.text === 'string') text = content.text;
    } catch {
      text = event.message?.content ?? '';
    }
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return `msgId=${event.message?.id ?? '?'} "${oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine}"`;
  } catch {
    return '(envelope unparseable)';
  }
}

function printRow(row: IngressRow): void {
  console.log(
    `  ${row.id}  status=${row.status}  attempts=${row.attempts}  received_at=${row.received_at}  ` +
      `channel=${row.channel_type}  platform=${row.platform_id}  thread=${row.thread_id ?? 'none'}`,
  );
  console.log(`      ${summarizeEnvelope(row.message_json)}`);
  if (row.last_error) console.log(`      last_error: ${row.last_error}`);
}

function listAll(): void {
  const rows = listIngress({ limit: 1000 });
  if (rows.length === 0) {
    console.log('No inbound ingress rows. (Nothing in-flight or failed.)');
    return;
  }
  const failed = rows.filter((r) => r.status === 'failed');
  const received = rows.filter((r) => r.status === 'received');
  if (failed.length > 0) {
    console.log(`${failed.length} FAILED row(s) — threw during routing:`);
    for (const row of failed) printRow(row);
  }
  if (received.length > 0) {
    console.log(`${received.length} RECEIVED row(s) — likely crash-orphaned in-flight envelopes:`);
    for (const row of received) printRow(row);
  }
  console.log('');
  console.log('!!! Replay re-enters routeInbound BELOW adapter dedup and can double-deliver. !!!');
  console.log('    Only replay rows you have confirmed were NOT processed. Prefer host stopped / low traffic.');
}

/**
 * Replay one row: re-feed the stored envelope through routeInbound. On success
 * the row is deleted (it has now been routed). On failure the row is kept and
 * its attempts/last_error are updated so a later pass can see the new state.
 */
async function replayRow(row: IngressRow): Promise<boolean> {
  let event: InboundEvent;
  try {
    event = JSON.parse(row.message_json) as InboundEvent;
  } catch (err) {
    console.error(`  ${row.id}: stored envelope is unparseable, skipping (${String(err)})`);
    return false;
  }
  console.log(`  replaying ${row.id} — WARNING: may double-deliver if already processed`);
  try {
    // persistIngress: false — this CLI owns row.id's lifecycle. Letting
    // routeInbound persist its own row would leak an orphan on failure and
    // duplicate the envelope (re-routable by a later --replay-all).
    await routeInbound(event, { persistIngress: false });
    deleteIngress(row.id);
    console.log(`  ${row.id}: replayed OK, row removed.`);
    return true;
  } catch (err) {
    markIngressFailed(row.id, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    console.error(`  ${row.id}: replay failed, row kept (attempts bumped): ${String(err)}`);
    return false;
  }
}

async function replayOne(id: string): Promise<void> {
  const row = getIngress(id);
  if (!row) {
    console.error(`No inbound ingress row with id ${id}.`);
    process.exit(1);
  }
  const ok = await replayRow(row);
  process.exit(ok ? 0 : 1);
}

async function replayAll(): Promise<void> {
  const rows = listIngress({ limit: 1000 });
  if (rows.length === 0) {
    console.log('Nothing to replay.');
    return;
  }
  console.log(`Replaying ${rows.length} row(s). WARNING: may double-deliver any already-processed messages.`);
  let ok = 0;
  for (const row of rows) {
    if (await replayRow(row)) ok++;
  }
  console.log(`Replayed ${ok}/${rows.length} row(s). Failed rows remain in the ledger for re-inspection.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Init the central DB the same way the host does so routeInbound's getDb()
  // calls (and the ledger reads/writes) resolve against the real v2.db.
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  if (argv[0] === '--list' && argv.length === 1) {
    listAll();
  } else if (argv[0] === '--replay' && argv.length === 2) {
    await replayOne(argv[1]);
  } else if (argv[0] === '--replay-all' && argv.length === 1) {
    await replayAll();
  } else {
    usage();
  }
}

main().catch((err) => {
  console.error('replay-inbound failed:', err);
  process.exit(1);
});
