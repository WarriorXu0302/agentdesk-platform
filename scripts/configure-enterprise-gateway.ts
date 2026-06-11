/**
 * Configure the built-in backend gateway tools for enterprise agent groups.
 *
 * This writes the shared HTTP gateway config into `groups/<folder>/container.json`
 * so frontdesk and worker agents all call the same backend contract even if
 * the real backend implementation (ERP, CRM, internal API, ticketing, …)
 * differs behind the gateway.
 *
 * Usage:
 *   pnpm exec tsx scripts/configure-enterprise-gateway.ts \
 *     --base-url https://gateway.internal/api/agent
 *
 *   pnpm exec tsx scripts/configure-enterprise-gateway.ts \
 *     --base-url https://gateway.internal/api/agent \
 *     --folders my-frontdesk,my-finance-worker \
 *     --timeout-ms 20000 \
 *     --memory-mode gateway \
 *     --header x-tenant=a \
 *     --header x-env=prod
 *
 * The base URL falls back to `process.env.GATEWAY_BASE_URL` (or the legacy
 * `ERP_GATEWAY_BASE_URL`) when --base-url is omitted.
 *
 * By default this targets only the template frontdesk. Pass `--folders` to
 * target your own desks/workers.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DEFAULT_FRONTDESK_FOLDER } from '../src/branding.js';
import { GROUPS_DIR } from '../src/config.js';
import { updateContainerConfig } from '../src/container-config.js';

const DEFAULT_FOLDERS = [DEFAULT_FRONTDESK_FOLDER];

interface Args {
  baseUrl: string;
  folders: string[];
  timeoutMs: number | null;
  headers: Record<string, string>;
  memoryMode: 'workspace' | 'gateway';
}

function parseArgs(argv: string[]): Args {
  let baseUrl = '';
  let foldersRaw: string | undefined;
  let timeoutMs: number | null = null;
  const headers: Record<string, string> = {};
  let memoryMode: Args['memoryMode'] = 'gateway';

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--base-url':
        baseUrl = val?.trim() || '';
        i++;
        break;
      case '--folders':
        foldersRaw = val;
        i++;
        break;
      case '--timeout-ms': {
        const parsed = Number(val);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          fatal(`Invalid --timeout-ms: ${val}`);
        }
        timeoutMs = parsed;
        i++;
        break;
      }
      case '--header': {
        const raw = val?.trim() || '';
        const eq = raw.indexOf('=');
        if (eq <= 0) fatal(`Invalid --header: ${raw} (expected key=value)`);
        const headerName = raw.slice(0, eq).trim();
        const headerValue = raw.slice(eq + 1).trim();
        if (!headerName || !headerValue) fatal(`Invalid --header: ${raw} (expected key=value)`);
        headers[headerName] = headerValue;
        i++;
        break;
      }
      case '--memory-mode':
        if (val !== 'workspace' && val !== 'gateway') {
          fatal(`Invalid --memory-mode: ${val}`);
        }
        memoryMode = val;
        i++;
        break;
      default:
        if (key.startsWith('--')) fatal(`Unknown arg: ${key}`);
        break;
    }
  }

  if (!baseUrl) {
    const fromEnv = (process.env.GATEWAY_BASE_URL || process.env.ERP_GATEWAY_BASE_URL)?.trim();
    if (fromEnv) {
      baseUrl = fromEnv;
    } else {
      fatal('Missing required arg: --base-url (or set GATEWAY_BASE_URL in the environment).');
    }
  }

  const folders = (foldersRaw ? foldersRaw.split(',') : DEFAULT_FOLDERS).map((value) => value.trim()).filter(Boolean);
  if (folders.length === 0) fatal('No target folders resolved.');

  return { baseUrl, folders, timeoutMs, headers, memoryMode };
}

function fatal(message: string): never {
  console.error(message);
  console.error('See scripts/configure-enterprise-gateway.ts header for usage.');
  process.exit(2);
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  for (const requestedFolder of args.folders) {
    const folder = requestedFolder;
    const groupDir = path.join(GROUPS_DIR, folder);
    if (!fs.existsSync(groupDir)) {
      throw new Error(`Group folder not found: ${requestedFolder}`);
    }

    updateContainerConfig(folder, (config) => {
      const existingHeaders = config.backendGateway?.defaultHeaders ?? {};
      const mergedHeaders = { ...existingHeaders, ...args.headers };
      const hasHeaders = Object.keys(mergedHeaders).length > 0;

      config.backendGateway = {
        baseUrl: args.baseUrl,
        timeoutMs: args.timeoutMs ?? config.backendGateway?.timeoutMs,
        defaultHeaders: hasHeaders ? mergedHeaders : undefined,
      };
      config.memoryMode = args.memoryMode;
      config.a2aSessionMode = 'root-session';
    });

    console.log(`Configured backend gateway for ${folder}`);
  }

  console.log('');
  console.log('Backend gateway configuration updated.');
  console.log(`  baseUrl: ${args.baseUrl}`);
  console.log(`  folders: ${args.folders.join(', ')}`);
  console.log(`  memoryMode: ${args.memoryMode}`);
  console.log('  a2aSessionMode: root-session');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
