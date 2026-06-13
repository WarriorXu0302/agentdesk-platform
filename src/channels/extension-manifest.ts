/**
 * Channel extension manifest — the minimal contract a third-party channel
 * adapter ships so the platform can load it WITHOUT forking the main repo
 * (ADR-0031).
 *
 * An extension is just a directory placed under `EXTENSIONS_DIR` containing a
 * `manifest.json` and an entry module. The host reads the manifest, checks
 * version compatibility, dynamic-imports the entry (which self-registers via
 * `registerChannelAdapter`, exactly like the in-tree `cli`/`feishu` modules),
 * and runs the freshly registered adapter through `assertChannelAdapterContract`
 * before letting `initChannelAdapters` set it up.
 *
 * This file owns ONLY the manifest shape + a dependency-free parser. It does no
 * I/O and imports nothing from the runtime — so it can be imported by an
 * extension author's own test suite to validate their manifest offline, the
 * same way `assertChannelAdapterContract` is a reusable self-test asset.
 *
 * The parser NEVER throws on bad input: it returns a discriminated result with
 * a human-readable reason, so the loader can log-and-skip one bad extension
 * without taking down host startup (fail-open).
 */

/** Parsed, validated channel extension manifest. */
export interface ChannelExtensionManifest {
  /** Stable extension id (e.g. `acme-slack`). Used in logs and dedupe. */
  id: string;
  /** Discriminator — only channel extensions are supported today. */
  kind: 'channel';
  /** Human-facing name. */
  name: string;
  /**
   * The `channelType` the entry module will register under. Must match the
   * adapter's own `channelType` so the loader can retrieve it after import and
   * run the contract gate against it.
   */
  channelType: string;
  /** Optional capability hints (free-form, advisory only — not enforced). */
  capabilities?: string[];
  /**
   * Minimum host version this extension supports, expressed as a small semver
   * range. Supported forms (see `semver-range.ts`):
   *   - exact:  `2.0.44`
   *   - caret:  `^2.0.0`   (same major, >= the floor)
   *   - tilde:  `~2.0.0`   (same major+minor, >= the floor)
   *   - gte:    `>=2.0.0`
   *   - wildcard: `*` / `x` (any version)
   * If the running host version does not satisfy this range, the loader
   * log.warns and skips the extension instead of importing incompatible code.
   */
  minHostVersion: string;
  /**
   * Entry file path RELATIVE to the manifest's own directory (e.g. `./index.js`
   * or `dist/index.js`). Resolved to an absolute path and dynamic-imported.
   * Must stay inside the extension directory — `..` traversal is rejected.
   */
  entry: string;
}

/** Discriminated parse result — never throws. */
export type ManifestParseResult = { ok: true; manifest: ChannelExtensionManifest } | { ok: false; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Parse + validate a raw manifest object (already JSON-parsed). Returns a
 * structured result with a reason on failure; NEVER throws. The reason strings
 * are intentionally specific so an extension author running this in their own
 * test sees exactly which field is wrong.
 */
export function parseChannelExtensionManifest(raw: unknown): ManifestParseResult {
  if (!isObject(raw)) {
    return { ok: false, reason: `manifest must be a JSON object, got ${raw === null ? 'null' : typeof raw}` };
  }

  if (raw.kind !== 'channel') {
    return {
      ok: false,
      reason: `\`kind\` must be the string "channel" (got ${JSON.stringify(raw.kind)})`,
    };
  }

  if (!isNonEmptyString(raw.id)) return { ok: false, reason: '`id` must be a non-empty string' };
  if (!isNonEmptyString(raw.name)) return { ok: false, reason: '`name` must be a non-empty string' };
  if (!isNonEmptyString(raw.channelType)) return { ok: false, reason: '`channelType` must be a non-empty string' };
  if (!isNonEmptyString(raw.minHostVersion)) {
    return { ok: false, reason: '`minHostVersion` must be a non-empty semver range string' };
  }
  if (!isNonEmptyString(raw.entry)) return { ok: false, reason: '`entry` must be a non-empty relative path string' };

  // Reject path traversal / absolute entry — the entry must stay inside the
  // extension directory. The loader resolves it relative to the manifest dir,
  // so we forbid `..` segments and absolute paths defensively here too.
  const entry = raw.entry.trim();
  if (entry.startsWith('/') || entry.startsWith('\\') || /(^|[\\/])\.\.([\\/]|$)/.test(entry)) {
    return {
      ok: false,
      reason: `\`entry\` must be a relative path inside the extension dir (got ${JSON.stringify(entry)})`,
    };
  }

  let capabilities: string[] | undefined;
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities) || !raw.capabilities.every((c) => typeof c === 'string')) {
      return { ok: false, reason: '`capabilities`, when present, must be an array of strings' };
    }
    capabilities = raw.capabilities as string[];
  }

  return {
    ok: true,
    manifest: {
      id: raw.id.trim(),
      kind: 'channel',
      name: raw.name.trim(),
      channelType: raw.channelType.trim(),
      capabilities,
      minHostVersion: raw.minHostVersion.trim(),
      entry,
    },
  };
}
