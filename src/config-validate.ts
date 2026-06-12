/**
 * Startup configuration validation (ADR-0025).
 *
 * Closes the "48-variable black hole": env is read piecemeal across ~15 files,
 * there was no single place that checked a deployment is internally consistent
 * before it starts taking traffic. This runs once in the host startup sequence
 * (src/index.ts, after cleanupOrphans, before initChannelAdapters) and does two
 * things:
 *
 *   1. Feature-scoped fail-fast — when a feature is enabled, demand the inputs
 *      it cannot run without (e.g. webhook mode needs Feishu verification
 *      secrets). Missing → throw, so a misconfigured deploy dies loudly at
 *      boot instead of silently rejecting every event.
 *
 *   2. Known-weak secret rejection — for the security-critical secrets that ARE
 *      set, reject obvious `.env.example` placeholders / lazy values
 *      (src/security/known-weak-secrets.ts).
 *
 * Conservatism is the whole point. We must NOT regress an existing working
 * deployment, so:
 *   - A check only fires when its feature is actually enabled. A minimal
 *     CLI-only / claude-only deploy that sets none of the relevant vars sails
 *     through untouched.
 *   - Anything that can safely degrade is a `log.warn`, not a throw.
 *   - Optional secrets that are simply unset are never weak-checked — only
 *     present, non-empty values are.
 *
 * Values come from BOTH process.env and `.env` (the host parses `.env` itself
 * via readEnvFile rather than loading it into process.env), with process.env
 * taking precedence — mirroring how the rest of the host resolves config.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { assertSecretNotKnownWeak } from './security/known-weak-secrets.js';

/**
 * Security-critical secrets that get the known-weak check IF they are set.
 * Unset/empty values are skipped here — "is X required?" is a separate,
 * feature-scoped concern handled below, so an operator who doesn't use a
 * feature is never tripped by its placeholder.
 */
const SECURITY_CRITICAL_SECRET_KEYS = [
  'GATEWAY_SIGNING_KEY',
  'METRICS_AUTH_TOKEN',
  'ONECLI_API_KEY',
  'FEISHU_APP_SECRET',
  'FEISHU_ENCRYPT_KEY',
  'FEISHU_VERIFICATION_TOKEN',
  'OPENAI_API_KEY',
] as const;

/** All keys this validator inspects (so we read `.env` once). */
const INSPECTED_KEYS = [
  ...SECURITY_CRITICAL_SECRET_KEYS,
  'FEISHU_EVENT_MODE',
  'FEISHU_APP_ID',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_TIMEOUT_MS',
  'OPENAI_COMPACT_MODEL',
  'OTEL_CAPTURE_CONTENT',
] as const;

/**
 * Resolve an env value from process.env first, then `.env`. Returns undefined
 * when unset or empty-after-trim (so callers can treat "" as "not set").
 */
function resolveValue(key: string, dotenv: Record<string, string>): string | undefined {
  const raw = process.env[key] ?? dotenv[key];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Validate startup configuration. Throws on a hard misconfiguration (the host
 * should not continue), warns on soft issues. Pure w.r.t. side effects beyond
 * reading config + logging — safe to call once at boot. Returns nothing; the
 * contract is "returns ⇒ config is safe enough to start".
 *
 * @throws Error with a message naming the offending variable(s).
 */
export function validateStartupConfig(): void {
  const dotenv = readEnvFile([...INSPECTED_KEYS]);
  const get = (key: string): string | undefined => resolveValue(key, dotenv);

  const errors: string[] = [];

  // --- 1. Known-weak secret rejection (only for values that are set) ---
  for (const key of SECURITY_CRITICAL_SECRET_KEYS) {
    const value = get(key);
    if (value === undefined) continue; // optional + unset → not our concern here
    try {
      assertSecretNotKnownWeak(key, value);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // --- 2. Feature-scoped required-config checks (conservative) ---

  // 2a. Feishu webhook/hybrid mode needs the verification secrets, else every
  //     inbound signature check is guaranteed to fail.
  const eventMode = get('FEISHU_EVENT_MODE')?.toLowerCase();
  if (eventMode === 'webhook' || eventMode === 'hybrid') {
    if (!get('FEISHU_ENCRYPT_KEY')) {
      errors.push(
        `FEISHU_ENCRYPT_KEY is required when FEISHU_EVENT_MODE=${eventMode} ` +
          `(webhook payloads cannot be decrypted without it).`,
      );
    }
    if (!get('FEISHU_VERIFICATION_TOKEN')) {
      errors.push(
        `FEISHU_VERIFICATION_TOKEN is required when FEISHU_EVENT_MODE=${eventMode} ` +
          `(callback verification cannot succeed without it).`,
      );
    }
  }

  // 2b. Feishu app id/secret must be configured as a pair — a lone half can
  //     never authenticate.
  const hasAppId = !!get('FEISHU_APP_ID');
  const hasAppSecret = !!get('FEISHU_APP_SECRET');
  if (hasAppId && !hasAppSecret) {
    errors.push('FEISHU_APP_SECRET is required when FEISHU_APP_ID is set (app credentials must be a pair).');
  }
  if (hasAppSecret && !hasAppId) {
    errors.push('FEISHU_APP_ID is required when FEISHU_APP_SECRET is set (app credentials must be a pair).');
  }

  // 2c. OpenAI provider needs an API key. The active provider is resolved
  //     per-session (sessions → agent_group → container.json), so we can't read
  //     a single "provider" var here. Instead we use the detectable signal:
  //     any OPENAI_* config var set while OPENAI_API_KEY is absent means the
  //     operator intends to use the openai provider but forgot the key. A
  //     claude-only / CLI-only deploy sets none of these and is never tripped.
  const openaiConfigured =
    !!get('OPENAI_BASE_URL') ||
    !!get('OPENAI_MODEL') ||
    !!get('OPENAI_REASONING_EFFORT') ||
    !!get('OPENAI_TIMEOUT_MS') ||
    !!get('OPENAI_COMPACT_MODEL');
  if (openaiConfigured && !get('OPENAI_API_KEY')) {
    errors.push(
      'OPENAI_API_KEY is required when the OpenAI provider is configured ' +
        '(OPENAI_BASE_URL / OPENAI_MODEL / etc. are set but OPENAI_API_KEY is missing).',
    );
  }

  // --- 3. Soft warnings (degrade gracefully, never block startup) ---

  // /metrics is public when no auth token is set. Recommend, don't require.
  if (!get('METRICS_AUTH_TOKEN')) {
    log.warn(
      'METRICS_AUTH_TOKEN is not set — /metrics is publicly readable. Set it or isolate /metrics behind a proxy.',
    );
  }

  // OTEL_CAPTURE_CONTENT=true puts FULL PLAINTEXT (chat bodies, LLM messages,
  // tool args + gateway/ERP result text) into traces (ADR-0027). The container
  // only enables capture on the literal value 'true' (agent-runner tracer.ts),
  // so we warn on exactly that — loud enough that an operator who flipped it on
  // (or copied a stale .env) is reminded the open-source default is OFF and the
  // compliance burden is theirs. Observability stays read-only; this is purely
  // a heads-up, never a block.
  if (get('OTEL_CAPTURE_CONTENT')?.toLowerCase() === 'true') {
    log.warn(
      'OTEL_CAPTURE_CONTENT=true — full plaintext content capture is ENABLED: chat bodies, ' +
        'LLM input/output, and tool/gateway payloads are written to your traces UNREDACTED (ADR-0027). ' +
        'Confirm Phoenix runs on a controlled internal network and that you accept the data-compliance responsibility. ' +
        'The open-source baseline keeps this OFF.',
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Startup configuration validation failed (${errors.length} issue${errors.length > 1 ? 's' : ''}):\n` +
        errors.map((e) => `  - ${e}`).join('\n'),
    );
  }

  log.info('Startup configuration validated');
}
