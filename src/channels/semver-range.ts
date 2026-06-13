/**
 * Minimal semver-satisfies — just enough to gate channel extensions against
 * the host version (ADR-0031). The repo has no `semver` dependency, and pulling
 * one in for a single range check is not worth a new dependency category, so
 * this is a tiny inline implementation covering the range forms the manifest
 * spec advertises.
 *
 * Supported ranges:
 *   - `*` / `x` / `X`     — any version
 *   - `1.2.3`             — exact (host must equal)
 *   - `>=1.2.3`           — host >= floor
 *   - `^1.2.3`            — same major, host >= floor (major 0 stays caret-loose
 *                           here — we do NOT special-case 0.x, see note)
 *   - `~1.2.3`            — same major+minor, host >= floor
 *
 * Anything we don't recognize returns false (treated as "not satisfied"), so a
 * malformed range gates the extension OUT rather than letting unknown code in.
 *
 * Prerelease/build metadata is ignored (split on `-`/`+`). This is a
 * compatibility gate, not a full semver engine; if richer ranges are ever
 * needed, swap in `semver` and write an ADR.
 */

interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `x.y.z` (ignoring any `-prerelease`/`+build`). Returns null if malformed. */
export function parseVersion(raw: string): Version | null {
  const core = raw.trim().split('+')[0]!.split('-')[0]!;
  const parts = core.split('.');
  if (parts.length < 1 || parts.length > 3) return null;
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) return NaN;
    return Number(p);
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  return {
    major: nums[0] ?? 0,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
  };
}

/** -1 / 0 / 1 ordering of two parsed versions. */
function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Return true if `version` satisfies the (small) `range`. Conservative: any
 * unrecognized or malformed input returns false.
 */
export function satisfies(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === 'x' || trimmed === 'X') return true;

  const v = parseVersion(version);
  if (!v) return false;

  if (trimmed.startsWith('>=')) {
    const floor = parseVersion(trimmed.slice(2));
    return floor !== null && compare(v, floor) >= 0;
  }

  if (trimmed.startsWith('^')) {
    const floor = parseVersion(trimmed.slice(1));
    if (!floor) return false;
    return v.major === floor.major && compare(v, floor) >= 0;
  }

  if (trimmed.startsWith('~')) {
    const floor = parseVersion(trimmed.slice(1));
    if (!floor) return false;
    return v.major === floor.major && v.minor === floor.minor && compare(v, floor) >= 0;
  }

  // Bare version → exact match.
  const exact = parseVersion(trimmed);
  return exact !== null && compare(v, exact) === 0;
}
