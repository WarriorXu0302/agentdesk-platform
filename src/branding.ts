/**
 * Branding — single source of truth for the platform's display name and
 * protocol namespace.
 *
 * Everything here is overridable via environment variables so a fork or a
 * downstream deployment can rebrand without touching code. The defaults are
 * intentionally generic ("AgentDesk") — this is an open, business-agnostic
 * enterprise agent framework, not a single product.
 *
 * | env var          | what it controls                                    |
 * |------------------|-----------------------------------------------------|
 * | `BRAND_NAME`     | Human-facing platform name (logs, system prompts).  |
 * | `BRAND_NAMESPACE`| Machine identifier used to derive every runtime tag: |
 * |                  | container labels, image base, HMAC header prefix,    |
 * |                  | metric prefix, `~/.config/<ns>/` paths, MCP server.  |
 *
 * `BRAND_NAMESPACE` must be a DNS/label-safe slug (lowercase, `[a-z0-9-]`)
 * because it ends up in Docker labels, image names, and HTTP header names.
 * It is read once at process start and treated as stable for the lifetime
 * of the process — changing it mid-flight would orphan running containers
 * and on-disk config.
 *
 * Both variables resolve as: process env → `.env` in the working directory →
 * default. `container/build.sh` resolves `BRAND_NAMESPACE` the same way, so
 * the image name it builds matches the one the host derives here.
 */
import fs from 'fs';
import path from 'path';

/**
 * Minimal `.env` fallback for the two brand variables. Inlined rather than
 * reusing `env.ts` readEnvFile because branding must stay import-cycle-free
 * (env → log → observability/tracer → branding). Parsing rules mirror
 * readEnvFile: trim, skip comments, strip one layer of matching quotes,
 * last assignment wins.
 */
function readBrandVar(key: string): string | undefined {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  let content: string;
  try {
    content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1 || trimmed.slice(0, eqIdx).trim() !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) found = value;
  }
  return found;
}

function sanitizeNamespace(raw: string | undefined, fallback: string): string {
  const slug = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/** Human-facing platform name. Used in logs, banners, default assistant name. */
export const PLATFORM_BRAND = (readBrandVar('BRAND_NAME') || 'AgentDesk').trim();

/** Full platform name for banners / startup logs. */
export const PLATFORM_NAME = `${PLATFORM_BRAND} Agent Platform`;

/**
 * Machine namespace. Lowercase slug. Derives container labels, image base,
 * signing-header prefix, metric prefix, config dirs, MCP server name.
 */
export const PLATFORM_PROTOCOL_NAMESPACE = sanitizeNamespace(readBrandVar('BRAND_NAMESPACE'), 'agentdesk');

/** Built-in MCP server name (shown to the agent provider). */
export const MCP_SERVER_NAME = PLATFORM_PROTOCOL_NAMESPACE;

/**
 * Prometheus metric prefix. Metric names allow only `[a-zA-Z0-9_:]`, so the
 * namespace's hyphens become underscores. e.g. namespace `my-brand` →
 * metric prefix `my_brand` → `my_brand_inbound_total`.
 */
export const METRIC_PREFIX = PLATFORM_PROTOCOL_NAMESPACE.replace(/-/g, '_');

/**
 * Default frontdesk agent group folder + display name. A fresh install
 * provisions one blank template frontdesk under this folder; operators add
 * their own desks/workers on top. No business-specific roles are baked in.
 */
export const DEFAULT_FRONTDESK_FOLDER = `${PLATFORM_PROTOCOL_NAMESPACE}-frontdesk`;
export const DEFAULT_FRONTDESK_NAME = `${PLATFORM_BRAND} Frontdesk`;

/** Folder prefix for worker agent groups created by the bootstrap script. */
export const DEFAULT_WORKER_FOLDER_PREFIX = PLATFORM_PROTOCOL_NAMESPACE;

/**
 * Resolve which frontdesk folder the enterprise autowire path should target.
 * Honors an explicit configured value first, then falls back to the default
 * frontdesk folder (whether or not it exists on disk yet — the autowire
 * caller logs and skips if the group is missing).
 */
export function resolveFrontdeskFolderFromGroups(_groupsDir: string, configured: string | undefined): string {
  const value = configured?.trim();
  return value || DEFAULT_FRONTDESK_FOLDER;
}

/** Build a worker agent group folder name from its local slug. */
export function buildWorkerFolder(localName: string): string {
  return `${DEFAULT_WORKER_FOLDER_PREFIX}-${localName}`;
}
