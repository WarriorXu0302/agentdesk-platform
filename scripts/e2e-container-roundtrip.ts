/**
 * scripts/e2e-container-roundtrip.ts — REAL-container end-to-end smoke.
 *
 * The bug class that twice shipped broken this session (env not reaching the
 * MCP child, argv assembled wrong) is now covered by fast unit tests
 * (src/container-runner.test.ts buildContainerArgs / buildMounts /
 * mcp-child-env / config). Those test the SPAWN-ARG + MOUNT ASSEMBLY. This
 * complements them by testing the RUNTIME seam they can't: that the actually-
 * built image boots, the runner polls a cross-mounted inbound.db, runs a
 * provider, and writes a reply to the cross-mounted outbound.db that the host
 * can read back — the host↔container↔DB round trip over a real Docker mount.
 *
 * Uses the `mock` provider so it needs NO LLM credentials and NO OneCLI vault
 * (container-runner skips the gateway for mock). Self-contained: a throwaway
 * temp session dir, the real INBOUND/OUTBOUND schema, the real entrypoint tail
 * (appendImageAndCommand) + the real CONTAINER_IMAGE — no repo data/ or groups/
 * pollution.
 *
 * Runs in the CI `image-smoke` job (after that job builds the image), NOT in the
 * default `pnpm test` / vitest suite — it needs Docker + the built image and is
 * slow. Run locally: `pnpm container:build && pnpm exec tsx scripts/e2e-container-roundtrip.ts`.
 * Exit 0 on a delivered mock reply, non-zero otherwise.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { PLATFORM_PROTOCOL_NAMESPACE } from '../src/branding.js';
import { CONTAINER_IMAGE, TIMEZONE } from '../src/config.js';
import { appendImageAndCommand } from '../src/container-runner.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { ensureSchema } from '../src/db/session-db.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WAIT_MS = 90_000;
const POLL_MS = 1000;

function fail(msg: string): never {
  console.error(`✗ e2e-container-roundtrip: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-e2e-'));
  const sessionDir = path.join(tmp, 'session');
  const agentDir = path.join(sessionDir, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'outbox'), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, '.claude'), { recursive: true });

  const inboundPath = path.join(sessionDir, 'inbound.db');
  const outboundPath = path.join(sessionDir, 'outbound.db');
  ensureSchema(inboundPath, 'inbound');
  ensureSchema(outboundPath, 'outbound');

  // Seed ONE trigger-eligible pending inbound message (what the host writes) +
  // exactly ONE destination. With a single destination the poll loop's fallback
  // routes the agent's bare text without requiring a <message to="..."> wrapper,
  // so the mock provider's canned reply gets dispatched to outbound.db.
  const inDb = new Database(inboundPath);
  inDb.pragma('journal_mode = DELETE');
  inDb
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('e2e-out', 'E2E Out', 'channel', 'cli', 'e2e-chan', NULL)`,
    )
    .run();
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger, series_id)
       VALUES ('m-e2e', 2, 'chat', datetime('now'), 'pending', ?, 1, 'm-e2e')`,
    )
    .run(JSON.stringify({ senderId: 'e2e:user', text: 'ping' }));
  inDb.close();

  // Redacted-free container.json with the mock provider.
  fs.writeFileSync(
    path.join(agentDir, 'container.json'),
    JSON.stringify(
      {
        provider: 'mock',
        agentGroupId: 'e2e-group',
        groupName: 'E2E',
        assistantName: 'E2E',
        skills: [],
        mcpServers: {},
      },
      null,
      2,
    ),
  );

  // Preflight: the image must already exist (CI's image-smoke job builds it
  // first; locally run `pnpm container:build`). Fail fast with the resolved tag
  // so a tag/slug-derivation mismatch is obvious instead of surfacing as a 90s
  // poll timeout. Use `images -q` (lists by reference), NOT `image inspect`:
  // with Docker Desktop's containerd image store, `image inspect <repo:tag>`
  // gives false negatives even when `docker images`/`docker run` resolve it.
  const imgQuery = spawnSync(CONTAINER_RUNTIME_BIN, ['images', '-q', CONTAINER_IMAGE], { encoding: 'utf8' });
  if (imgQuery.status !== 0 || !imgQuery.stdout.trim()) {
    fail(
      `image not found: ${CONTAINER_IMAGE} — build it first (pnpm container:build). ` +
        `If CI built a different tag, the install-slug/brand derivation diverged from src/config.ts.`,
    );
  }

  const containerName = `${PLATFORM_PROTOCOL_NAMESPACE}-e2e-roundtrip-${process.pid}`;
  // Mirror container-runner.ts buildContainerArgs: run as the host uid so the
  // container can WRITE outbound.db into the host-owned bind mount. On native
  // Linux Docker (CI) the image's default `node` uid (1000) cannot write a mount
  // owned by a different host uid (the CI runner user); Docker Desktop on macOS
  // transparently remaps ownership, which is why omitting this only bit in CI.
  // Same guard as the real runner: skip when root (0) or already the image's uid.
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  const userArgs = hostUid != null && hostUid !== 0 && hostUid !== 1000 ? ['--user', `${hostUid}:${hostGid}`] : [];
  // Mirror the essential mounts buildMounts produces (the mock path needs the
  // session dir for the DBs + the agent-runner source; node_modules is baked in
  // the image). container.json sits inside the session dir's agent/ so it lands
  // at /workspace/agent/container.json with no extra mount.
  const args: string[] = [
    'run',
    '--rm',
    '--name',
    containerName,
    ...userArgs,
    '-e',
    `TZ=${TIMEZONE}`,
    '-e',
    `BRAND_NAMESPACE=${PLATFORM_PROTOCOL_NAMESPACE}`,
    '-e',
    'AGENTDESK_IDLE_EXIT_MS=5000',
    '-v',
    `${sessionDir}:/workspace`,
    '-v',
    `${path.join(REPO_ROOT, 'container', 'agent-runner', 'src')}:/app/src:ro`,
    '-v',
    `${path.join(REPO_ROOT, 'container', 'CLAUDE.md')}:/app/CLAUDE.md:ro`,
  ];
  appendImageAndCommand(args, CONTAINER_IMAGE);

  console.log(`▶ docker ${args.join(' ')}`);
  const child = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrTail = '';
  let childExit: number | null = null;
  child.stdout.on('data', (d) => process.stdout.write(`[container] ${d}`));
  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d).slice(-2000);
    process.stderr.write(`[container] ${d}`);
  });
  child.on('exit', (code) => {
    childExit = code ?? 0;
  });

  // Poll the cross-mounted outbound.db for the mock reply.
  const deadline = Date.now() + WAIT_MS;
  let replied = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    // Check for the reply FIRST — the container idle-exits (code 0) shortly
    // after writing, and a reply-then-exit must still count as success.
    try {
      const outDb = new Database(outboundPath, { readonly: true });
      const row = outDb.prepare("SELECT id, content FROM messages_out WHERE kind != 'llm-usage' LIMIT 1").get() as
        | { id: string; content: string }
        | undefined;
      outDb.close();
      if (row) {
        console.log(
          `✓ container wrote a reply to the cross-mounted outbound.db: ${row.id} → ${row.content.slice(0, 120)}`,
        );
        replied = true;
        break;
      }
    } catch {
      /* outbound.db may be momentarily locked by the container writer; retry */
    }
    // No reply yet: if the container already died with a non-zero code, fail
    // fast with its stderr rather than waiting out the full poll deadline (a
    // crash, an unwritable mount, or a missing dep manifests here).
    if (childExit != null && childExit !== 0) {
      fail(
        `container exited with code ${childExit} before writing a reply.\n--- container stderr (tail) ---\n${stderrTail}`,
      );
    }
  }

  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  try {
    spawn(CONTAINER_RUNTIME_BIN, ['rm', '-f', containerName], { stdio: 'ignore' });
  } catch {
    /* best-effort */
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (!replied) fail(`no reply in outbound.db within ${WAIT_MS}ms — the container↔host round trip did not complete`);
  console.log('✓ e2e-container-roundtrip PASSED — host↔container↔DB round trip works on the real image.');
}

main().catch((err) => fail(err instanceof Error ? err.stack || err.message : String(err)));
