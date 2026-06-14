import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard: conversation_thread_id (ADR-0039) is a PURE CORRELATION id — it must
 * never become an authz/routing lookup key. Routing binds to platform_id /
 * agent_destinations / source_session_id / root_session_id and identity to the
 * host-validated origin_user_id; the thread id is written and read only by the
 * classification_log / messages_in INSERTs, the host-owned stamp UPDATE, and
 * observability reads.
 *
 * The one structural tell of misuse is an EQUALITY FILTER on the column —
 * `WHERE ... conversation_thread_id = ?` — i.e. "look something up BY thread
 * id", which is how it would start feeding a decision. The legitimate writes
 * use `SET conversation_thread_id = ?` (the host stamp); the legitimate read
 * uses `WHERE conversation_thread_id IS NOT NULL` (observability). This test
 * fails if any `conversation_thread_id = <bind>` appears OUTSIDE a `SET` clause.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = __dirname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('conversation_thread_id is correlation-only (ADR-0039 guard)', () => {
  it('is never used as an equality lookup/filter key (only SET on the host stamp)', () => {
    const offenders: string[] = [];
    // Matches `conversation_thread_id = ?` / `= @x`, capturing whether `SET`
    // immediately precedes it (the allowed host-stamp UPDATE).
    const re = /(\bSET\s+)?conversation_thread_id\s*=\s*[?@]/gi;
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!m[1]) {
          // No `SET` before it → it's a WHERE/JOIN equality filter. Disallowed.
          offenders.push(`${path.relative(SRC, file)}: ${m[0]}`);
        }
      }
    }
    expect(
      offenders,
      `conversation_thread_id must not be an equality lookup/authz key (ADR-0039): ${offenders.join('; ')}`,
    ).toHaveLength(0);
  });
});
