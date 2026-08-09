/**
 * Fork-free channel extension loader (ADR-0031).
 *
 * Lets a third-party install a channel adapter WITHOUT forking the main repo:
 * drop a directory containing a `manifest.json` + an entry module into
 * `EXTENSIONS_DIR`, and the host loads it at startup alongside the in-tree
 * `cli`/`feishu` channels. This is NOT a public plugin marketplace — there is
 * no registry, no signing, no tiers. The trust model is deployment-level: the
 * OPERATOR controls the contents of `EXTENSIONS_DIR`, and loading code from it
 * is no different from the operator editing the repo. See ADR-0031 for the
 * full trust-model rationale (explicitly NOT the clawhub model).
 *
 * Pipeline per extension directory:
 *   1. Read + parse `manifest.json` (parseChannelExtensionManifest — never throws).
 *   2. Version gate: host version must satisfy `minHostVersion` (small semver
 *      range) — else log.warn + skip (don't import incompatible code).
 *   3. Dynamic-import the resolved entry. The module is expected to call
 *      `registerChannelAdapter(...)` on import, exactly like cli/feishu.
 *   4. Contract gate: instantiate the freshly registered factory and run it
 *      through `assertChannelAdapterContract`, and require the adapter's
 *      `channelType` to match the manifest's. On violation: log.error,
 *      `unregisterChannelAdapter` (so initChannelAdapters never sets it up),
 *      and skip. Two guards make that promise actually hold (see ADR-0031's
 *      hardening patch): a REPLACED registration is rolled back here (a name
 *      diff cannot see an overwrite), and `initChannelAdapters` re-runs the
 *      contract gate on the instance it actually sets up — because the factory
 *      is invoked a second time there — while refusing to take over a
 *      channelType that is already live.
 *   5. fail-open: any error at any step is caught, logged, and that ONE
 *      extension is skipped — a single bad extension must never crash host
 *      startup.
 *
 * Backward compatibility: if `EXTENSIONS_DIR` is unset/derives to a missing
 * directory, this returns an empty summary with zero side effects — existing
 * deployments (no extensions dir) are completely unaffected.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import type { ChannelRegistration } from './adapter.js';
import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';
import { log } from '../log.js';
import { assertChannelAdapterContract } from './channel-contract.js';
import {
  getChannelRegistration,
  getRegisteredChannelNames,
  getRegisteredFactory,
  registerChannelAdapter,
  unregisterChannelAdapter,
} from './channel-registry.js';
import { parseChannelExtensionManifest } from './extension-manifest.js';
import { satisfies } from './semver-range.js';

/** Outcome for a single extension directory. */
export interface ExtensionLoadOutcome {
  /** Directory name under EXTENSIONS_DIR. */
  dir: string;
  status: 'loaded' | 'skipped';
  /** Extension id from the manifest, if it parsed far enough to have one. */
  id?: string;
  /** channelType it registered under (loaded only). */
  channelType?: string;
  /** Reason for a skip (human-readable). */
  reason?: string;
}

/** Summary returned by loadChannelExtensions. */
export interface ExtensionLoadSummary {
  /** Absolute extensions dir that was scanned (whether or not it existed). */
  dir: string;
  loaded: ExtensionLoadOutcome[];
  skipped: ExtensionLoadOutcome[];
}

export interface LoadChannelExtensionsOptions {
  /** Override the extensions directory (default: resolveExtensionsDir()). */
  extensionsDir?: string;
  /** Override the host version (default: readHostVersion()). Tests inject this. */
  hostVersion?: string;
}

const MANIFEST_FILENAME = 'manifest.json';

/**
 * Resolve the extensions directory, following the repo's existing config-path
 * style:
 *   1. explicit `EXTENSIONS_DIR` env var (absolute or resolved against cwd), else
 *   2. `~/.config/<namespace>/extensions` — sibling of the other operator-owned
 *      config dirs (mount-allowlist.json, sender-allowlist.json live under
 *      `~/.config/<namespace>/`). Kept OUTSIDE the project root, like those.
 */
export function resolveExtensionsDir(): string {
  const fromEnv = process.env.EXTENSIONS_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.config', PLATFORM_PROTOCOL_NAMESPACE, 'extensions');
}

/**
 * Read the host version from package.json at runtime. Read via fs (not a static
 * import) so it stays inside `rootDir: src` and the version isn't baked at
 * compile time. Walks up from this module to find the nearest package.json with
 * a `version`. Returns '0.0.0' if it can't be found — which causes caret/tilde
 * ranges to fail closed (extension skipped) rather than loading blindly.
 */
export function readHostVersion(): string {
  // From src/channels/ (or dist/channels/), package.json is two dirs up.
  // Walk a few levels defensively in case the layout differs.
  // fileURLToPath, NOT `new URL(...).pathname`: pathname stays percent-ENCODED,
  // so an install path containing a space or any non-ASCII character (e.g.
  // "/Users/ops/My Apps/agentdesk") made every candidate read fail, silently
  // fell through to '0.0.0', and then skipped EVERY version-gated extension
  // with a bogus "host version 0.0.0 does not satisfy ..." reason.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
    } catch {
      // not here / not readable — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

/**
 * Load all channel extensions from EXTENSIONS_DIR. Self-registers conforming
 * adapters into the channel registry (so a later initChannelAdapters() sets
 * them up like any built-in). Fail-open: returns a summary; never throws.
 */
export async function loadChannelExtensions(opts: LoadChannelExtensionsOptions = {}): Promise<ExtensionLoadSummary> {
  const dir = opts.extensionsDir ?? resolveExtensionsDir();
  const hostVersion = opts.hostVersion ?? readHostVersion();
  const summary: ExtensionLoadSummary = { dir, loaded: [], skipped: [] };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      // No extensions dir — backward-compatible zero-effect path.
      log.debug('No channel extensions dir, skipping', { dir });
    } else {
      log.warn('Failed to read channel extensions dir (skipping all)', { dir, err });
    }
    return summary;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extDir = path.join(dir, entry.name);
    const outcome = await loadOne(entry.name, extDir, hostVersion);
    if (outcome.status === 'loaded') summary.loaded.push(outcome);
    else summary.skipped.push(outcome);
  }

  log.info('Channel extensions scanned', {
    dir,
    loaded: summary.loaded.length,
    skipped: summary.skipped.length,
  });
  return summary;
}

/** Load a single extension directory. Never throws (fail-open). */
async function loadOne(name: string, extDir: string, hostVersion: string): Promise<ExtensionLoadOutcome> {
  const skip = (reason: string, id?: string): ExtensionLoadOutcome => {
    log.warn('Channel extension skipped', { dir: name, reason, id });
    return { dir: name, status: 'skipped', reason, id };
  };

  try {
    // 1. manifest
    const manifestPath = path.join(extDir, MANIFEST_FILENAME);
    let rawText: string;
    try {
      rawText = fs.readFileSync(manifestPath, 'utf-8');
    } catch {
      return skip(`missing ${MANIFEST_FILENAME}`);
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawText);
    } catch (err) {
      return skip(`invalid ${MANIFEST_FILENAME}: ${(err as Error).message}`);
    }

    const parsed = parseChannelExtensionManifest(rawJson);
    if (!parsed.ok) return skip(`manifest: ${parsed.reason}`);
    const manifest = parsed.manifest;

    // 2. version gate
    if (!satisfies(hostVersion, manifest.minHostVersion)) {
      return skip(
        `host version ${hostVersion} does not satisfy minHostVersion "${manifest.minHostVersion}"`,
        manifest.id,
      );
    }

    // 3. resolve + dynamic-import entry. Entry is relative to the manifest dir;
    //    confirm the resolved path stays inside extDir (defense-in-depth on top
    //    of the parser's `..` rejection).
    const entryAbs = path.resolve(extDir, manifest.entry);
    const rel = path.relative(extDir, entryAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return skip(`entry escapes extension dir: ${manifest.entry}`, manifest.id);
    }
    if (!fs.existsSync(entryAbs)) {
      return skip(`entry not found: ${manifest.entry}`, manifest.id);
    }

    // Snapshot the REGISTRATIONS, not just the names: `registerChannelAdapter`
    // overwrites an existing entry, and a name diff is blind to exactly that
    // case — the one where an extension takes over a built-in.
    const before = new Map<string, ChannelRegistration>();
    for (const n of getRegisteredChannelNames()) {
      const reg = getChannelRegistration(n);
      if (reg) before.set(n, reg);
    }
    try {
      await import(pathToFileURL(entryAbs).href);
    } catch (err) {
      return skip(`entry import threw: ${(err as Error).message}`, manifest.id);
    }

    const after = getRegisteredChannelNames();
    const newlyRegistered = after.filter((n) => !before.has(n));

    // HIJACK GUARD: a name that already existed but whose registration object
    // CHANGED means the entry replaced a built-in (or an earlier extension).
    // Without this the loader reported "entry did not call
    // registerChannelAdapter" — a misleading skip — while leaving the replacement
    // in the registry, so an ungated adapter reached initChannelAdapters().setup()
    // and served that channel. Restore the originals, drop anything this entry
    // added, and refuse the extension.
    const replaced = after.filter((n) => before.has(n) && getChannelRegistration(n) !== before.get(n));
    if (replaced.length > 0) {
      for (const n of replaced) registerChannelAdapter(n, before.get(n)!);
      for (const n of newlyRegistered) unregisterChannelAdapter(n);
      return skip(`entry replaced existing channel registration(s): ${replaced.join(', ')}`, manifest.id);
    }

    if (newlyRegistered.length === 0) {
      return skip('entry did not call registerChannelAdapter on import', manifest.id);
    }

    // 4. contract gate. Instantiate each newly registered factory and assert.
    //    Back out (unregister) any that don't conform so initChannelAdapters
    //    never sets them up. The expected case is exactly one new registration.
    let acceptedChannelType: string | undefined;
    let lastReason: string | undefined;
    for (const regName of newlyRegistered) {
      const factory = getRegisteredFactory(regName);
      if (!factory) continue;
      try {
        const adapter = await factory();
        if (!adapter) {
          // Factory returned null (e.g. missing creds at load time). The
          // registration stays — initChannelAdapters re-runs the factory and
          // logs the missing-creds skip there, same as a built-in. We can't
          // contract-check a null adapter, so move on.
          acceptedChannelType ??= manifest.channelType;
          continue;
        }
        assertChannelAdapterContract(adapter);
        // The manifest's declared channelType is the one value we can
        // cross-check. Enforce it (the manifest docs already say it "must match
        // the adapter's own channelType"), so an extension cannot pass the gate
        // under a harmless registry name while reporting a channelType that a
        // built-in serves. `initChannelAdapters` refuses the takeover too; this
        // rejects it earlier, with a precise reason.
        if (adapter.channelType !== manifest.channelType) {
          throw new Error(
            `adapter channelType "${adapter.channelType}" does not match manifest channelType "${manifest.channelType}"`,
          );
        }
        acceptedChannelType ??= adapter.channelType;
      } catch (err) {
        lastReason = (err as Error).message;
        log.error('Channel extension failed the contract gate; unregistering', {
          dir: name,
          id: manifest.id,
          channel: regName,
          err,
        });
        unregisterChannelAdapter(regName);
      }
    }

    if (acceptedChannelType === undefined) {
      return skip(`contract gate rejected all registrations: ${lastReason ?? 'unknown'}`, manifest.id);
    }

    log.info('Channel extension loaded', {
      dir: name,
      id: manifest.id,
      channelType: acceptedChannelType,
      registered: newlyRegistered,
    });
    return {
      dir: name,
      status: 'loaded',
      id: manifest.id,
      channelType: acceptedChannelType,
    };
  } catch (err) {
    // Catch-all fail-open: any unanticipated error skips just this extension.
    return skip(`unexpected error: ${(err as Error).message}`);
  }
}
