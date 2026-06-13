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
 *     --header x-env=prod \
 *     --signing-key "$GATEWAY_SIGNING_KEY"
 *
 * The base URL falls back to `process.env.GATEWAY_BASE_URL` (or the legacy
 * `ERP_GATEWAY_BASE_URL`) when --base-url is omitted. The signing key falls
 * back to `process.env.GATEWAY_SIGNING_KEY` so it need not appear in shell
 * history; pass `--signing-headers a,b,c` only if the gateway mandates
 * non-default header names (timestamp,nonce,signature in that order).
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
import { readEnvFile } from '../src/env.js';
import { isKnownWeakSecret } from '../src/security/known-weak-secrets.js';

/**
 * Resolve a config value with the SAME precedence the host uses (process env →
 * `.env` file). The host reads `.env` via readEnvFile; this script runs under
 * `tsx`, which does NOT auto-load `.env` into process.env — so without this an
 * operator who put GATEWAY_SIGNING_KEY in `.env` (exactly as `.env.example`
 * documents) would have the script silently provision an UNSIGNED gateway while
 * the host believed it was signed.
 */
function resolveConfigValue(key: string): string | undefined {
  const fromProc = process.env[key]?.trim();
  if (fromProc) return fromProc;
  return readEnvFile([key])[key]?.trim() || undefined;
}

const DEFAULT_FOLDERS = [DEFAULT_FRONTDESK_FOLDER];

/** Order in which --signing-headers CSV slots map onto the three names. */
const SIGNING_HEADER_SLOTS = ['timestamp', 'nonce', 'signature'] as const;

interface Args {
  baseUrl: string;
  folders: string[];
  timeoutMs: number | null;
  headers: Record<string, string>;
  memoryMode: 'workspace' | 'gateway';
  signingKey: string | null;
  signingHeaders: { timestamp: string; nonce: string; signature: string } | null;
}

function parseArgs(argv: string[]): Args {
  let baseUrl = '';
  let foldersRaw: string | undefined;
  let timeoutMs: number | null = null;
  const headers: Record<string, string> = {};
  let memoryMode: Args['memoryMode'] = 'gateway';
  let signingKey: string | null = null;
  let signingHeaders: Args['signingHeaders'] = null;

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
      case '--signing-key': {
        const raw = val?.trim() || '';
        if (!raw) fatal('Invalid --signing-key: empty value');
        // ADR-0025 known-weak defense, runtime parity (ADR-0018/0023): the live
        // HMAC key is the one written into each group's container.json, not just
        // env. A placeholder/lazy key here would silently leave the trust chain
        // forgeable, so reject it at write time the same way host startup rejects
        // a weak env GATEWAY_SIGNING_KEY.
        if (isKnownWeakSecret(raw)) {
          fatal(
            '--signing-key is a known placeholder/weak value — writing it into container.json would ' +
              'leave gateway requests forgeable. Generate a real key with: openssl rand -hex 32',
          );
        }
        signingKey = raw;
        i++;
        break;
      }
      case '--signing-headers': {
        // Three comma-separated header names in timestamp,nonce,signature
        // order. Only needed when the gateway mandates non-default names —
        // omit to keep the brand-namespaced defaults (x-<ns>-timestamp …).
        const parts = (val ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        if (parts.length !== SIGNING_HEADER_SLOTS.length) {
          fatal(`Invalid --signing-headers: ${val} (expected 3 names: timestamp,nonce,signature)`);
        }
        signingHeaders = { timestamp: parts[0], nonce: parts[1], signature: parts[2] };
        i++;
        break;
      }
      default:
        if (key.startsWith('--')) fatal(`Unknown arg: ${key}`);
        break;
    }
  }

  if (!baseUrl) {
    const fromEnv = resolveConfigValue('GATEWAY_BASE_URL') || resolveConfigValue('ERP_GATEWAY_BASE_URL');
    if (fromEnv) {
      baseUrl = fromEnv;
    } else {
      fatal('Missing required arg: --base-url (or set GATEWAY_BASE_URL in the environment / .env).');
    }
  }

  if (!signingKey) {
    const fromEnv = resolveConfigValue('GATEWAY_SIGNING_KEY');
    if (fromEnv) {
      // Same known-weak defense as the --signing-key path: never write a
      // placeholder env key into container.json.
      if (isKnownWeakSecret(fromEnv)) {
        fatal(
          'GATEWAY_SIGNING_KEY (from the environment) is a known placeholder/weak value — refusing to ' +
            'write it into container.json. Generate a real key with: openssl rand -hex 32',
        );
      }
      signingKey = fromEnv;
    }
  }
  if (signingHeaders && !signingKey) {
    fatal('--signing-headers requires --signing-key (or GATEWAY_SIGNING_KEY).');
  }

  const folders = (foldersRaw ? foldersRaw.split(',') : DEFAULT_FOLDERS).map((value) => value.trim()).filter(Boolean);
  if (folders.length === 0) fatal('No target folders resolved.');

  return { baseUrl, folders, timeoutMs, headers, memoryMode, signingKey, signingHeaders };
}

/** Mask a signing key for console output — never print it in the clear. */
function maskSigningKey(key: string | null): string {
  if (!key) return 'not set';
  return `set (${key.slice(0, 4)}…, ${key.length} chars)`;
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
        // Leave any previously-set signingKey/signingHeaders intact when the
        // run doesn't pass new ones — clearing them silently would be a
        // surprise downgrade from signed to unsigned.
        signingKey: args.signingKey ?? config.backendGateway?.signingKey,
        signingHeaders: args.signingHeaders ?? config.backendGateway?.signingHeaders,
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
  console.log(`  signingKey: ${maskSigningKey(args.signingKey)}`);
  if (args.signingHeaders) {
    console.log(
      `  signingHeaders: ${args.signingHeaders.timestamp}, ${args.signingHeaders.nonce}, ${args.signingHeaders.signature}`,
    );
  }
  if (!args.signingKey) {
    console.log('  (gateway requests will be UNSIGNED — pass --signing-key once your gateway can verify HMAC.)');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
