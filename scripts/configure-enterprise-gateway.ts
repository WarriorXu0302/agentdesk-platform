/**
 * Configure the built-in ERP gateway tools for enterprise agent groups.
 *
 * This writes the shared HTTP gateway config into `groups/<folder>/container.json`
 * so frontdesk and worker agents all call the same backend contract even if
 * the real ERP implementation differs behind the gateway.
 *
 * Usage:
 *   pnpm exec tsx scripts/configure-enterprise-gateway.ts \
 *     --base-url https://erp-gateway.internal/api/agent
 *
 *   pnpm exec tsx scripts/configure-enterprise-gateway.ts \
 *     --base-url https://erp-gateway.internal/api/agent \
 *     --folders frontlane-frontdesk,frontlane-finance-worker \
 *     --timeout-ms 20000 \
 *     --memory-mode erp \
 *     --header x-tenant=erp-a \
 *     --header x-env=prod
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  buildLegacyWorkerFolder,
  buildWorkerFolder,
  DEFAULT_FRONTDESK_FOLDER,
  LEGACY_FRONTDESK_FOLDER,
} from '../src/branding.js';
import { GROUPS_DIR } from '../src/config.js';
import { updateContainerConfig } from '../src/container-config.js';

const DEFAULT_FOLDERS = [
  DEFAULT_FRONTDESK_FOLDER,
  buildWorkerFolder('access-worker'),
  buildWorkerFolder('sales-worker'),
  buildWorkerFolder('finance-worker'),
  buildWorkerFolder('approval-worker'),
  buildWorkerFolder('ops-worker'),
];

interface Args {
  baseUrl: string;
  folders: string[];
  timeoutMs: number | null;
  headers: Record<string, string>;
  memoryMode: 'workspace' | 'erp';
}

function parseArgs(argv: string[]): Args {
  let baseUrl = '';
  let foldersRaw: string | undefined;
  let timeoutMs: number | null = null;
  const headers: Record<string, string> = {};
  let memoryMode: Args['memoryMode'] = 'erp';

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
        if (val !== 'workspace' && val !== 'erp') {
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
    fatal('Missing required arg: --base-url');
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
    let folder = requestedFolder;
    let groupDir = path.join(GROUPS_DIR, folder);
    if (!fs.existsSync(groupDir)) {
      if (folder === DEFAULT_FRONTDESK_FOLDER) {
        const legacyDir = path.join(GROUPS_DIR, LEGACY_FRONTDESK_FOLDER);
        if (fs.existsSync(legacyDir)) {
          folder = LEGACY_FRONTDESK_FOLDER;
          groupDir = legacyDir;
        }
      } else if (folder.startsWith('frontlane-')) {
        const localName = folder.slice('frontlane-'.length);
        const legacyFolder = buildLegacyWorkerFolder(localName);
        const legacyDir = path.join(GROUPS_DIR, legacyFolder);
        if (fs.existsSync(legacyDir)) {
          folder = legacyFolder;
          groupDir = legacyDir;
        }
      }
    }
    if (!fs.existsSync(groupDir)) {
      throw new Error(`Group folder not found: ${requestedFolder}`);
    }

    updateContainerConfig(folder, (config) => {
      config.enterpriseGateway = {
        baseUrl: args.baseUrl,
        timeoutMs: args.timeoutMs ?? undefined,
        defaultHeaders: Object.keys(args.headers).length > 0 ? args.headers : undefined,
      };
      config.memoryMode = args.memoryMode;
      config.a2aSessionMode = 'root-session';
    });

    console.log(`Configured ERP gateway for ${folder}`);
  }

  console.log('');
  console.log('Enterprise gateway configuration updated.');
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
