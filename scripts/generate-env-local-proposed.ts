/**
 * Render the Phase 0a `.env.local.proposed` artifact for review.
 *
 * Why this script exists (ADR-0008 §Decision 子决策2 — Option A):
 *
 *   The Phase 0a implementation pack ships
 *   `openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example`,
 *   whose README naively suggests `cat env-template.example >> .env.local`.
 *   That mixes `<PLACEHOLDER>` tokens (e.g. `<MQTT_BROKER_HOST>`) with real
 *   secrets in the runtime config and violates the redaction-guardrails
 *   policy. Instead, we render the template into a separate, gitignored
 *   `.env.local.proposed`, then surface a diff so the operator can
 *   cherry-pick lines into `.env.local` manually.
 *
 * Behavior:
 *   1. Read the canonical template from the sibling V1 closeout repo if
 *      reachable (`../openclaw/CLOSEOUT/phase0-implementation-pack/
 *      env-template.example`). Falls back to an embedded copy when the
 *      sibling repo is unavailable (CI / fresh clone of MUAP only).
 *   2. Write the rendered template to `<repo>/.env.local.proposed`.
 *      Always overwrite — this file is generated, not authoritative.
 *   3. Print a short diff against the existing `.env.local` (if any) so
 *      the operator knows what to merge. Diff is line-set based: keys
 *      present in proposal but missing from `.env.local` are listed.
 *      Real values in `.env.local` are never logged.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-env-local-proposed.ts
 *
 * Optional args:
 *   --template <path>   Override template source path (debug / testing).
 *   --output <path>     Override output path (default: <repo>/.env.local.proposed).
 *   --quiet             Suppress diff hint output.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_TEMPLATE_CANDIDATES = [
  path.resolve(REPO_ROOT, '..', 'openclaw', 'CLOSEOUT', 'phase0-implementation-pack', 'env-template.example'),
];

const DEFAULT_OUTPUT = path.resolve(REPO_ROOT, '.env.local.proposed');

/**
 * Embedded fallback copy of the Phase 0a env template.
 *
 * Kept in sync with `openclaw/CLOSEOUT/phase0-implementation-pack/
 * env-template.example`. Used when the sibling closeout repo is not
 * reachable (e.g. a coding agent cloned only MUAP). The header marker
 * lets test code distinguish embedded-fallback rendering from
 * canonical-source rendering.
 */
const EMBEDDED_TEMPLATE = `# =============================================================================
# FrontLane Lab Frontdesk — Phase 0 .env Template (embedded fallback)
# =============================================================================
# Source of truth: openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example
# This embedded copy is rendered only when the sibling closeout repo is
# unreachable. Review and append (do NOT replace) into .env.local.
# Strict redaction policy: do NOT commit real values to git.
# =============================================================================

# -----------------------------------------------------------------------------
# RUNTIME MODE — MANDATORY (no default)
# -----------------------------------------------------------------------------
# simulation = use mock services (Phase 0.5 mock cluster on localhost)
# production = use real lab hardware on LAN
RUNTIME_MODE=simulation


# -----------------------------------------------------------------------------
# ERP Gateway — points at mock or real backend depending on RUNTIME_MODE
# -----------------------------------------------------------------------------
# Simulation: http://localhost:8088
# Production: https://erp-gateway.lab.internal/api/agent
ERP_GATEWAY_BASE_URL=http://localhost:8088

# Optional HMAC signing (production only — leave empty in simulation)
# ERP_GATEWAY_SIGNING_KEY=<HMAC_SHA256_KEY_PRODUCTION_ONLY>


# -----------------------------------------------------------------------------
# FrontLane Lab Frontdesk Group — wire CLI / Feishu autowire to lab desk
# -----------------------------------------------------------------------------
# Uncomment to make lab-frontdesk the default Feishu autowire target
# (instead of generic frontlane-frontdesk)
# ENTERPRISE_FRONTDESK_FOLDER=frontlane-lab-frontdesk


# -----------------------------------------------------------------------------
# V1 Hardware Endpoints (PRODUCTION mode only — leave commented in simulation)
# -----------------------------------------------------------------------------
# OPENCLAW_API_BASE_URL=<OPENCLAW_API_BASE_URL>
# OPENCLAW_API_TOKEN=<OPENCLAW_API_TOKEN>
# MQTT_BROKER_HOST=<MQTT_BROKER_HOST>
# MQTT_BROKER_PORT=8883
# MQTT_BROKER_USERNAME=<MQTT_BROKER_USERNAME>
# MQTT_BROKER_PASSWORD=<MQTT_BROKER_PASSWORD>
# MQTT_BROKER_TLS=true
# ORBBEC_CAMERA_URL=<ORBBEC_CAMERA_URL>
# LAB_WINDOWS_REMOTE_URL=<LAB_WINDOWS_REMOTE_URL>


# -----------------------------------------------------------------------------
# Lab DB / Experiment Backend (PRODUCTION mode only)
# -----------------------------------------------------------------------------
# LAB_DB_API_BASE_URL=<LOCAL_LAB_API_BASE_URL>


# -----------------------------------------------------------------------------
# Knowledge / RAG Backend (used by remote-rag-expert / rag-upload)
# -----------------------------------------------------------------------------
# RAG_BACKEND_URL=<RAG_BACKEND_URL>


# -----------------------------------------------------------------------------
# OTel + Logging (Phase 1 onwards — can leave empty in Phase 0)
# -----------------------------------------------------------------------------
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
# OTEL_SERVICE_NAME=frontlane-lab-frontdesk
# LOG_LEVEL=info


# -----------------------------------------------------------------------------
# Strict redaction reminder
# -----------------------------------------------------------------------------
# Never commit real values for any <PLACEHOLDER>. They must be loaded from
# secret managers, vault, or out-of-band config in production deployments.
`;

interface Args {
  templatePath: string | null;
  outputPath: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  let templatePath: string | null = null;
  let outputPath = DEFAULT_OUTPUT;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--template':
        if (!val) fatal('--template requires a path argument.');
        templatePath = path.resolve(val);
        i++;
        break;
      case '--output':
        if (!val) fatal('--output requires a path argument.');
        outputPath = path.resolve(val);
        i++;
        break;
      case '--quiet':
        quiet = true;
        break;
      default:
        if (key.startsWith('--')) {
          fatal(`Unknown arg: ${key}`);
        }
        break;
    }
  }

  return { templatePath, outputPath, quiet };
}

function fatal(message: string): never {
  console.error(message);
  console.error('See scripts/generate-env-local-proposed.ts header for usage.');
  process.exit(2);
}

function loadTemplate(explicitPath: string | null): { source: 'canonical' | 'embedded' | 'explicit'; content: string; from: string | null } {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      fatal(`--template path does not exist: ${explicitPath}`);
    }
    return { source: 'explicit', content: fs.readFileSync(explicitPath, 'utf-8'), from: explicitPath };
  }

  for (const candidate of DEFAULT_TEMPLATE_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return { source: 'canonical', content: fs.readFileSync(candidate, 'utf-8'), from: candidate };
    }
  }

  return { source: 'embedded', content: EMBEDDED_TEMPLATE, from: null };
}

/**
 * Extract the set of `KEY=...` variable names from a dotenv-like blob.
 * Lines beginning with `#` or matching `# KEY=...` are skipped because
 * commented entries are not active runtime config — they exist in the
 * template only as guidance.
 */
function extractActiveKeys(blob: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of blob.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      keys.add(key);
    }
  }
  return keys;
}

interface DiffSummary {
  proposalKeys: string[];
  existingKeys: string[];
  missingInExisting: string[];
  alreadyPresent: string[];
}

function computeDiff(proposalContent: string, existingPath: string): DiffSummary {
  const proposalKeys = [...extractActiveKeys(proposalContent)].sort();

  if (!fs.existsSync(existingPath)) {
    return {
      proposalKeys,
      existingKeys: [],
      missingInExisting: proposalKeys,
      alreadyPresent: [],
    };
  }

  const existingBlob = fs.readFileSync(existingPath, 'utf-8');
  const existingKeysSet = extractActiveKeys(existingBlob);
  const existingKeys = [...existingKeysSet].sort();

  const missingInExisting: string[] = [];
  const alreadyPresent: string[] = [];
  for (const key of proposalKeys) {
    if (existingKeysSet.has(key)) {
      alreadyPresent.push(key);
    } else {
      missingInExisting.push(key);
    }
  }

  return { proposalKeys, existingKeys, missingInExisting, alreadyPresent };
}

export interface RunResult {
  outputPath: string;
  templateSource: 'canonical' | 'embedded' | 'explicit';
  templateFrom: string | null;
  diff: DiffSummary;
}

export async function run(argv: string[]): Promise<RunResult> {
  const args = parseArgs(argv);
  const { source, content, from } = loadTemplate(args.templatePath);

  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, content, 'utf-8');

  const envLocalPath = path.resolve(REPO_ROOT, '.env.local');
  const diff = computeDiff(content, envLocalPath);

  if (!args.quiet) {
    console.log('');
    console.log(`Wrote env proposal: ${args.outputPath}`);
    console.log(`Template source: ${source}${from ? ` (${from})` : ''}`);
    console.log('');
    if (diff.missingInExisting.length === 0) {
      console.log('All proposal keys already present in .env.local — nothing to merge.');
    } else {
      console.log(`Keys in proposal but missing from .env.local (${diff.missingInExisting.length}):`);
      for (const k of diff.missingInExisting) console.log(`  - ${k}`);
      console.log('');
      console.log('Next step: review .env.local.proposed and selectively copy the missing keys into .env.local.');
      console.log('Strict redaction policy: replace every <PLACEHOLDER> with a real value before saving.');
    }
  }

  return { outputPath: args.outputPath, templateSource: source, templateFrom: from, diff };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
