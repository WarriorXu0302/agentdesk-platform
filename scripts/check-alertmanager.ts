/**
 * scripts/check-alertmanager.ts — pre-production gate for Alertmanager routing.
 *
 * The shipped infra/observability/alertmanager/alertmanager.yml routes ALL
 * alerts (including severity=critical) to a no-op `null` receiver so the obs
 * stack runs without external credentials. That is correct for dev, but if an
 * operator ships it as-is to production, every critical page silently goes
 * nowhere — the worst kind of alerting failure.
 *
 * This is an explicit gate (NOT run in normal CI — the default repo config is
 * intentionally placeholder and WOULD fail it). Operators wire it into their
 * deploy pipeline: `pnpm obs:alertmanager:check`. It exits non-zero if any
 * route sends to a receiver that has no actual notification config — i.e. the
 * placeholder is still live. See deploy/README.md.
 *
 * Deliberately dependency-free (no YAML parser): the structure is simple and
 * stable, and the parse is unit-tested.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const NOTIFICATION_CONFIG_RE =
  /^\s*(slack|webhook|pagerduty|email|opsgenie|victorops|pushover|wechat|telegram|sns|msteams|discord|webex|sns)_configs\s*:/;

function uncommented(line: string): boolean {
  return !line.trimStart().startsWith('#');
}

function unquote(value: string): string {
  const v = value.trim();
  return v.replace(/^['"]|['"]$/g, '');
}

/**
 * Parse an alertmanager.yml string and return the names of receivers that are
 * ROUTED TO but have no notification config (i.e. no-op / placeholder). A
 * non-empty result means critical/warning alerts would silently go nowhere.
 * Pure + exported for testing.
 */
export function findNoopRoutedReceivers(yamlText: string): string[] {
  const lines = yamlText.split('\n');

  // 1. Receiver names that actually have a notification config block.
  //    Walk the `receivers:` section; a receiver gains "has config" if an
  //    uncommented *_configs key appears before the next `- name:`.
  const receiversWithConfig = new Set<string>();
  let inReceivers = false;
  let current: string | null = null;
  for (const line of lines) {
    if (/^receivers\s*:/.test(line)) {
      inReceivers = true;
      continue;
    }
    // A new top-level key ends the receivers section.
    if (inReceivers && /^[a-z_]+\s*:/.test(line) && !/^\s/.test(line)) {
      inReceivers = false;
      current = null;
    }
    if (!inReceivers || !uncommented(line)) continue;
    const nameMatch = /^\s*-\s*name\s*:\s*(.+)$/.exec(line);
    if (nameMatch) {
      current = unquote(nameMatch[1]);
      continue;
    }
    if (current && NOTIFICATION_CONFIG_RE.test(line)) {
      receiversWithConfig.add(current);
    }
  }

  // 2. Receivers referenced by any uncommented `receiver:` line (route tree).
  const routed = new Set<string>();
  for (const line of lines) {
    if (!uncommented(line)) continue;
    const m = /^\s*receiver\s*:\s*(.+)$/.exec(line);
    if (m) routed.add(unquote(m[1]));
  }

  // 3. Routed receivers with no config = silent black holes.
  return [...routed].filter((r) => !receiversWithConfig.has(r)).sort();
}

// CLI
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const file =
    process.argv[2] ||
    path.resolve(path.dirname(__filename), '..', 'infra', 'observability', 'alertmanager', 'alertmanager.yml');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const noop = findNoopRoutedReceivers(text);
  if (noop.length > 0) {
    console.error(
      `✗ Alertmanager routes to no-op receiver(s) with no notification config: ${noop.join(', ')}.\n` +
        `  Alerts (including critical) sent there go NOWHERE. Wire a real receiver\n` +
        `  (slack_configs / webhook_configs / pagerduty_configs / …) and point the route at it\n` +
        `  before production. See ${path.relative(process.cwd(), file)} + deploy/README.md.`,
    );
    process.exit(1);
  }
  console.log('✓ Alertmanager: every routed receiver has a notification config.');
}
