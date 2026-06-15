/**
 * Operator triage CLI (ADR-0049) — observe & triage the session fleet on a
 * single-machine deployment running many concurrent users / orgs.
 *
 *   # Trace ONE request's full fan-out (frontdesk -> workers) by the root
 *   # session id of the delegation tree:
 *   pnpm exec tsx scripts/trace.ts <root_session_id>
 *
 *   # List / filter the session fleet (find a root_session_id to trace):
 *   pnpm exec tsx scripts/trace.ts --user feishu:ou_alice
 *   pnpm exec tsx scripts/trace.ts --channel feishu --status active
 *   pnpm exec tsx scripts/trace.ts --agent-group agentdesk-frontdesk --limit 50
 *
 * Read-only. Reads the operator-owned central DB; access is gated by who can run
 * the script. Companion to the SQL in docs/RUNBOOK.md.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { listSessions, traceRequest, type SessionFilter } from '../src/db/operator-queries.js';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  trace.ts <root_session_id>                   # trace one request fan-out',
      '  trace.ts --user <id>                         # filter the session fleet',
      '  trace.ts --channel <type> --status <s> --agent-group <id> --thread <id> --root <id> --limit <n>',
    ].join('\n'),
  );
  process.exit(1);
}

function parseFilters(args: string[]): SessionFilter {
  const f: SessionFilter = {};
  for (let i = 0; i < args.length; i += 2) {
    const val = args[i + 1];
    if (val === undefined) usage();
    switch (args[i]) {
      case '--user':
        f.ownerUserId = val;
        break;
      case '--channel':
        f.channelType = val;
        break;
      case '--status':
        f.status = val;
        break;
      case '--container-status':
        f.containerStatus = val;
        break;
      case '--agent-group':
        f.agentGroupId = val;
        break;
      case '--thread':
        f.threadId = val;
        break;
      case '--root':
        f.rootSessionId = val;
        break;
      case '--limit':
        f.limit = Number(val);
        break;
      default:
        usage();
    }
  }
  return f;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  // A bare first arg (not a --flag) is a root_session_id to trace.
  if (!args[0].startsWith('--')) {
    const trace = traceRequest(args[0]);
    console.log(`root_session_id: ${trace.rootSessionId}`);
    console.log(`sessions (${trace.sessions.length}):`);
    for (const s of trace.sessions) {
      console.log(
        `  - ${s.id}  group=${s.agent_group_id}  owner=${s.owner_user_id ?? '∅'}  status=${s.status}/${s.container_status}  conv=${s.conversation_thread_id ?? '∅'}`,
      );
    }
    console.log(`classifications (${trace.classifications.length}):`);
    for (const c of trace.classifications) {
      console.log(
        `  - ${c.action ?? '?'}  worker=${c.recommended_worker ?? '∅'}  user=${c.user_id ?? '∅'}  ref=${c.outcome_ref ?? '∅'}`,
      );
    }
    if (trace.sessions.length === 0) {
      console.log('(nothing found — unknown root session id)');
    }
    return;
  }

  const sessions = listSessions(parseFilters(args));
  console.log(`${sessions.length} session(s):`);
  for (const s of sessions) {
    console.log(
      `  ${s.id}  group=${s.agent_group_id}  owner=${s.owner_user_id ?? '∅'}  status=${s.status}/${s.container_status}  last_active=${s.last_active ?? '∅'}  conv=${s.conversation_thread_id ?? '∅'}`,
    );
  }
}

main();
