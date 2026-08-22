/**
 * Container-side self-mod validation (ADR-0063).
 *
 * These rules mirror `src/modules/self-mod/request.ts` on the host. The host is
 * what actually decides — this side only decides how fast the agent learns it
 * got something wrong. That makes these tests cheap to skip and easy to justify
 * skipping, which is precisely why the first cut shipped without any and how
 * the drift got in: this side checked env VALUES while the host did not, so a
 * real host-side hole stayed invisible behind a passing tool call.
 *
 * So what is pinned here is not "the rule works" — the host's suite covers that
 * — but "this side accepts nothing the host would refuse". A LOOSER rule here
 * is the direction that hides a host gap; a stricter one only annoys the agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { addMcpServer, installPackages } from './self-mod.js';

const BSLASH = String.fromCharCode(92);
const TICK = String.fromCharCode(96);
const RLO = String.fromCharCode(0x202e);

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** Rows the tool wrote — a request only reaches the host if one lands here. */
function outboundCount(): number {
  const row = getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number };
  return row.n;
}

async function addServer(args: Record<string, unknown>): Promise<ToolResult> {
  return (await addMcpServer.handler(args)) as ToolResult;
}

async function install(args: Record<string, unknown>): Promise<ToolResult> {
  return (await installPackages.handler(args)) as ToolResult;
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('add_mcp_server — refuses what the host would refuse', () => {
  it('accepts a legitimate request and writes exactly one row', async () => {
    const r = await addServer({
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp_x' },
    });
    expect(r.isError).toBeUndefined();
    expect(outboundCount()).toBe(1);
  });

  it('refuses a non-string name or command instead of casting it through', async () => {
    expect((await addServer({ name: 42, command: 'npx' })).isError).toBe(true);
    expect((await addServer({ name: 'a', command: ['npx'] })).isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });

  it('refuses a name that is not a plain identifier', async () => {
    for (const name of ['has space', 'nl\nnl', '__proto__', 'x'.repeat(65)]) {
      expect((await addServer({ name, command: 'npx' })).isError).toBe(true);
    }
    expect(outboundCount()).toBe(0);
  });

  it('refuses fence-breaking and card-forging characters in command, args, and env VALUES', async () => {
    const hostile = [`npx${TICK}${TICK}${TICK}`, 'a\nb', `a${RLO}b`, `a${BSLASH}nb`];
    for (const v of hostile) {
      expect((await addServer({ name: 'a', command: v })).isError).toBe(true);
      expect((await addServer({ name: 'a', command: 'npx', args: [v] })).isError).toBe(true);
      // env VALUES are the field the host originally left unchecked.
      expect((await addServer({ name: 'a', command: 'npx', env: { A: v } })).isError).toBe(true);
    }
    expect(outboundCount()).toBe(0);
  });

  it('refuses a bad env key, a non-string env value, and a non-object env', async () => {
    expect((await addServer({ name: 'a', command: 'npx', env: { 'BAD KEY': 'v' } })).isError).toBe(true);
    expect((await addServer({ name: 'a', command: 'npx', env: { A: 1 } })).isError).toBe(true);
    expect((await addServer({ name: 'a', command: 'npx', env: [] })).isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });

  it('refuses oversized args and env', async () => {
    expect((await addServer({ name: 'a', command: 'npx', args: Array.from({ length: 33 }, () => 'x') })).isError).toBe(
      true,
    );
    const env: Record<string, string> = {};
    for (let i = 0; i < 33; i++) env[`K${i}`] = 'v';
    expect((await addServer({ name: 'a', command: 'npx', env })).isError).toBe(true);
    expect((await addServer({ name: 'a', command: 'npx', args: ['x'.repeat(513)] })).isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });

  it('accepts non-Latin text — the rules are about Unicode classes, not ASCII', async () => {
    const r = await addServer({ name: 'srv', command: 'npx', env: { NOTE: '内部接口令牌' } });
    expect(r.isError).toBeUndefined();
    expect(outboundCount()).toBe(1);
  });
});

describe('install_packages — refuses what the host would refuse', () => {
  it('accepts a clean request', async () => {
    const r = await install({ apt: ['curl', 'jq'], npm: ['left-pad'], reason: 'tooling' });
    expect(r.isError).toBeUndefined();
    expect(outboundCount()).toBe(1);
  });

  /**
   * apt names end up in `apt-get install -y ${names.join(' ')}` inside a
   * generated Dockerfile that the host feeds to a build. A pattern check that
   * runs before a type check is not a check at all: RegExp.test stringifies its
   * argument, so `APT_RE.test(123)` is true.
   */
  it('refuses a shell metacharacter and a non-string package name', async () => {
    expect((await install({ apt: ['curl; rm -rf /'] })).isError).toBe(true);
    expect((await install({ apt: [123] })).isError).toBe(true);
    expect((await install({ npm: ["a'b"] })).isError).toBe(true);
    expect((await install({ apt: 'curl' })).isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });

  it('refuses more than 20 packages', async () => {
    expect((await install({ apt: Array.from({ length: 21 }, (_, i) => `pkg${i}`) })).isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });

  it('refuses a reason that would inject lines into the approval card', async () => {
    expect((await install({ apt: ['curl'], reason: 'need it\n\nApproved by security.' })).isError).toBe(true);
    expect((await install({ apt: ['curl'], reason: `need it${BSLASH}n${BSLASH}nApproved.` })).isError).toBe(true);
    expect((await install({ apt: ['curl'], reason: 42 })).isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });

  it('refuses an empty request', async () => {
    expect((await install({})).isError).toBe(true);
    expect(outboundCount()).toBe(0);
  });
});
