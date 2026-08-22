/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Input is checked here at the tool boundary AND re-validated on the host
 * side. The two layers are NOT redundant, and the host's is the real one:
 * this process is the untrusted side of the outbound boundary, so a check
 * here constrains a cooperating agent, not a compromised runner. What it buys
 * is feedback — the agent learns the shape it got wrong in the same tool call
 * instead of having the row silently rejected downstream.
 *
 * The rules below MIRROR src/modules/self-mod/request.ts (ADR-0063). The host
 * decides; these only decide how FAST the agent learns.
 *
 * Drift is not symmetric, and the first version of this comment got the
 * consequence backwards. If this side is STRICTER, the cost is only a
 * needlessly early rejection. If this side is LOOSER, a payload sails through
 * the tool call and is rejected later by the host — still safe, but the agent
 * is told at the wrong time. Neither direction is a security hole, because the
 * host revalidates everything; both are a usability bug, and the looser
 * direction is the one that hides a real host-side gap behind a passing tool
 * call. (That is exactly what happened: this side checked env VALUES while the
 * host did not, so the host's hole stayed invisible until review.)
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/**
 * Text that cannot alter how the host's approval card reads: no backtick (it
 * would close the card's disclosure fence early), no control characters or
 * line separators (they would split the disclosure into forgeable lines), no
 * format characters (bidi overrides make displayed text differ from stored
 * text), and no backslash — the card renderer folds the two-character sequence
 * backslash-n into a real newline AFTER the host validates, so banning the
 * character is what makes the check survive that rewrite. Non-Latin scripts are
 * unaffected: the rule is about Unicode classes, not ASCII.
 */
const SAFE_TEXT_RE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}`\\]*$/u;
const MAX_ARGS = 32;
const MAX_ENV_ENTRIES = 32;
const MAX_FIELD_LEN = 512;

/** Strict: a non-string is a rejection, never a stringification. */
function checkStrings(label: string, value: unknown, re: RegExp, maxLen: number): string | null {
  if (!Array.isArray(value)) return `${label} must be an array of strings`;
  if (value.length > MAX_ARGS) return `${label} may hold at most ${MAX_ARGS} entries`;
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== 'string') return `${label}[${i}] must be a string`;
    if (item.length > maxLen) return `${label}[${i}] exceeds ${maxLen} characters`;
    // Type first, THEN pattern: RegExp.test stringifies its argument, so a
    // pattern check on an unvalidated type silently accepts numbers.
    if (!re.test(item)) return `${label}[${i}] contains a disallowed character`;
  }
  return null;
}

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: {
          type: 'array',
          items: { type: 'string' },
          description: 'apt packages to install (names only, no version specs or flags)',
        },
        npm: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm packages to install globally (names only, no version specs)',
        },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = args.apt === undefined ? [] : args.apt;
    const npm = args.npm === undefined ? [] : args.npm;
    if (!Array.isArray(apt) || !Array.isArray(npm)) return err('apt and npm must be arrays of strings');
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const badApt = checkStrings('apt', apt, APT_RE, 128);
    if (badApt) return err(`${badApt}. Only lowercase letters, digits, and ._+- allowed.`);
    const badNpm = checkStrings('npm', npm, NPM_RE, 128);
    if (badNpm) return err(`${badNpm}. No version specs or shell characters.`);
    const reason = args.reason === undefined ? '' : args.reason;
    if (typeof reason !== 'string') return err('reason must be a string');
    if (!SAFE_TEXT_RE.test(reason)) return err('reason must not contain newlines, backticks, or bidi characters');
    if (reason.length > 1024) return err('reason exceeds 1024 characters');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason,
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config — you must already know the exact `command` + `args` to invoke it (e.g. `npx @modelcontextprotocol/server-github`). Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        env: { type: 'object', description: 'Environment variables for the server' },
      },
      required: ['name', 'command'],
    },
  },
  async handler(args) {
    const name = args.name;
    const command = args.command;
    if (typeof name !== 'string' || typeof command !== 'string') return err('name and command must be strings');
    if (!name || !command) return err('name and command are required');
    if (!MCP_NAME_RE.test(name))
      return err('name must be 1-64 chars of letters, digits, and ._- (no spaces or newlines)');
    if (command.length > 256 || !SAFE_TEXT_RE.test(command)) {
      return err('command must be under 256 chars with no newlines, backticks, or bidi characters');
    }
    const mcpArgs = args.args === undefined ? [] : args.args;
    const badArgs = checkStrings('args', mcpArgs, SAFE_TEXT_RE, MAX_FIELD_LEN);
    if (badArgs) return err(`${badArgs}. No newlines, backticks, or bidi characters.`);
    const env = args.env === undefined ? {} : args.env;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) return err('env must be an object');
    const envEntries = Object.entries(env as Record<string, unknown>);
    if (envEntries.length > MAX_ENV_ENTRIES) return err(`env may hold at most ${MAX_ENV_ENTRIES} variables`);
    for (const [k, v] of envEntries) {
      if (!ENV_KEY_RE.test(k)) return err(`env key "${k}" must match [A-Za-z_][A-Za-z0-9_]*`);
      if (typeof v !== 'string') return err(`env.${k} must be a string`);
      if (v.length > MAX_FIELD_LEN || !SAFE_TEXT_RE.test(v)) {
        return err(`env.${k} must be under ${MAX_FIELD_LEN} chars with no control or bidi characters`);
      }
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        command,
        args: mcpArgs,
        env,
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

registerTools([installPackages, addMcpServer]);
