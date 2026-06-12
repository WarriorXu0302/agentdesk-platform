/**
 * Known-weak secret rejection (ADR-0025).
 *
 * The platform's identity trust chain (HMAC signing, /metrics auth, OneCLI,
 * Feishu callback verification) is only as strong as the secrets feeding it.
 * A common failure mode is copying `.env.example` and shipping with one of its
 * obvious placeholders still in place — or a lazy `changeme` / `password`.
 * Those values silently "work" while leaving the deployment forgeable.
 *
 * This module is the deny-list half of the defense: it pairs with
 * `.env.example` (the placeholders below are literally the example values
 * shipped there) and is enforced at host startup by src/config-validate.ts.
 *
 * Design mirrors openclaw's src/gateway/known-weak-gateway-secrets.ts:
 * assertGatewayAuthNotKnownWeak — a small, explicit sentinel set plus a few
 * universally-weak values, matched after case/whitespace normalization, with
 * an actionable error that names the offending variable.
 *
 * Scope note: this only rejects *known* placeholders/trivially-weak values. It
 * is not an entropy meter — a deliberately-chosen real secret of any length
 * passes. The goal is to make "forgot to replace the placeholder" a hard
 * startup error, not to grade secret quality.
 */

/**
 * Normalize a candidate secret for comparison: trim surrounding whitespace and
 * lowercase. Matching is intentionally generous so `ChangeMe `, `CHANGEME`, and
 * `changeme` all collapse to the same weak value.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Sentinel placeholders that MUST be rejected. The first group is the exact
 * set of secret example values shipped in `.env.example` (kept in sync by
 * hand — if you add a secret placeholder there, add it here). The second group
 * is the usual catalogue of lazy throwaways. All are compared after normalize().
 */
const RAW_KNOWN_WEAK_SECRETS: string[] = [
  // --- exact placeholders shipped in .env.example (keep in sync) ---
  'replace-me-openssl-rand-hex-32', // GATEWAY_SIGNING_KEY
  'replace-me-metrics-auth-token', // METRICS_AUTH_TOKEN
  'replace-me-onecli-api-key', // ONECLI_API_KEY
  'replace-me-feishu-encrypt-key', // FEISHU_ENCRYPT_KEY
  'replace-me-feishu-verification-token', // FEISHU_VERIFICATION_TOKEN
  'your-feishu-app-secret', // FEISHU_APP_SECRET
  'sk-your-openai-api-key', // OPENAI_API_KEY

  // --- universally weak / lazy values ---
  'changeme',
  'change-me',
  'change_me',
  'secret',
  'password',
  'passwd',
  'test',
  'testing',
  'xxx',
  'xxxx',
  'todo',
  'tbd',
  'placeholder',
  'example',
  'default',
  'none',
  'null',
  'admin',
];

/**
 * Frozen set of normalized known-weak secret strings. Exported so tests (and
 * any future callers) can assert membership without re-deriving the list.
 */
export const KNOWN_WEAK_SECRET_PLACEHOLDERS: ReadonlySet<string> = Object.freeze(
  new Set(RAW_KNOWN_WEAK_SECRETS.map(normalize)),
) as ReadonlySet<string>;

/**
 * Pattern half of the deny-list: catches the `your-*-here` / `replace-me-*` /
 * `your-*` placeholder shapes regardless of the exact middle, so a renamed but
 * still-templated value is caught too. Matched against the normalized value.
 */
const WEAK_SECRET_PATTERNS: RegExp[] = [
  /^your-.*-here$/, // your-anything-here
  /^replace-me\b/, // replace-me / replace-me-...
  /^your-.+-(secret|key|token|password)$/, // your-x-secret / -key / -token
  /^sk-your-/, // sk-your-openai-api-key and any renamed sk-your-* placeholder
];

/**
 * Return true if `value` is a known weak/placeholder secret (after
 * normalization). Empty/whitespace-only values are NOT treated as weak here —
 * "is this set at all?" is a separate concern owned by config-validate.ts, so
 * this function does not fire on the empty string.
 */
export function isKnownWeakSecret(value: string): boolean {
  const normalized = normalize(value);
  if (!normalized) return false;
  if (KNOWN_WEAK_SECRET_PLACEHOLDERS.has(normalized)) return true;
  return WEAK_SECRET_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Throw if `value` is a known weak/placeholder secret for the named variable.
 * No-op when the value is a real secret (or empty — see isKnownWeakSecret).
 * The error names the variable and gives a concrete remediation so an operator
 * can fix it without reading source.
 */
export function assertSecretNotKnownWeak(name: string, value: string): void {
  if (isKnownWeakSecret(value)) {
    throw new Error(
      `${name} is set to a known placeholder/weak value — this leaves the ` +
        `identity trust chain forgeable. Replace it with a real secret. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
}
