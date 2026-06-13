import os from 'os';
import path from 'path';

import { PLATFORM_BRAND, PLATFORM_PROTOCOL_NAMESPACE } from './branding.js';
import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'ONECLI_URL', 'ONECLI_API_KEY', 'TZ']);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || PLATFORM_BRAND;
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', PLATFORM_PROTOCOL_NAMESPACE, 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  PLATFORM_PROTOCOL_NAMESPACE,
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share a single
// brand-namespaced image (e.g. `<namespace>-agent-v2-<slug>:latest`) and clobber
// each other on rebuild. The actual name is derived from BRAND_NAMESPACE + the
// install slug — see getDefaultContainerImage in install-slug.ts.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `${PLATFORM_PROTOCOL_NAMESPACE}-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
// Hard cap on concurrently running agent containers. Prevents a burst of
// inbound traffic from fork-bombing the host. Sessions that can't be woken
// because the cap is full stay pending — the host sweep (60s) will retry
// them on its next tick once earlier containers have exited.
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '10', 10) || 10);

// --- Outbound delivery resilience (see ADR-0016) ---
// Timeout for a single channel-adapter deliver() call. A timed-out attempt
// counts as failed and is retried with backoff, but the underlying send may
// still land — timeouts open an at-least-once duplicate window, so keep this
// comfortably above the channel's p99 send latency.
export const DELIVERY_TIMEOUT_MS = Math.max(1000, parseInt(process.env.DELIVERY_TIMEOUT_MS || '30000', 10) || 30000);
// How many sessions the delivery poll loops drain concurrently. Bounds
// cross-session head-of-line blocking without letting a burst of sessions
// fan out into unbounded parallel channel calls. Per-session ordering is
// unaffected (delivery.ts serializes drains within a session).
export const DELIVERY_CONCURRENCY = Math.max(1, parseInt(process.env.DELIVERY_CONCURRENCY || '4', 10) || 4);
// Persistent retry policy for failed deliveries (delivered.status='failed').
// Attempts beyond the schedule's length reuse its last entry; after
// DELIVERY_MAX_ATTEMPTS the row stops auto-retrying and waits for
// scripts/dlq.ts. Deliberately not env-tunable: the cap interacts with the
// delivered-table semantics in src/db/session-db.ts.
export const DELIVERY_MAX_ATTEMPTS = 10;
export const DELIVERY_BACKOFF_SCHEDULE_SEC = [60, 300, 1800, 7200, 21600]; // 1m / 5m / 30m / 2h / 6h cap

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
