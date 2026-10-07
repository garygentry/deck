/**
 * The kernel's module API version. Modules declare a compatible range in `deckApi`.
 * It stays at 0.x until the contract freezes; on 0.x every minor bump may break.
 */
export const DECK_API_VERSION = "0.1.0";

type Triple = [number, number, number];

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RANGE = /^(\^)?(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)?$/;

function parseVersion(version: string): Triple {
  const match = VERSION.exec(version);
  if (!match) throw new RangeError(`not a version: "${version}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** True when `range` is a supported `deckApi` range: `M.m.p` (exact), `^M`, `^M.m` or `^M.m.p`. */
export function isDeckApiRange(range: string): boolean {
  const match = RANGE.exec(range);
  return match !== null && (match[1] === "^" || match[4] !== undefined);
}

/**
 * Whether `version` (default: the kernel's) satisfies a module's `deckApi` range.
 * Caret ranges follow npm semantics: `^1.2` allows `>=1.2.0 <2.0.0`; on 0.x the minor is the
 * breaking component, so `^0.1` allows `>=0.1.0 <0.2.0`; on 0.0.x every patch is, so `^0.0.3`
 * allows only `0.0.3` while `^0.0` allows any `0.0.x`. An unsupported range never matches.
 */
export function satisfiesDeckApi(range: string, version: string = DECK_API_VERSION): boolean {
  const match = RANGE.exec(range);
  if (!match || !isDeckApiRange(range)) return false;
  const actual = parseVersion(version);
  const floor: Triple = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  if (match[1] !== "^") return compare(actual, floor) === 0;
  if (compare(actual, floor) < 0) return false;
  if (floor[0] > 0) return actual[0] === floor[0];
  if (actual[0] !== 0) return false;
  // ^0: any 0.x. ^0.m: the minor is pinned. ^0.0.p: the patch is pinned too.
  if (match[3] === undefined) return true;
  if (actual[1] !== floor[1]) return false;
  return floor[1] > 0 || match[4] === undefined || actual[2] === floor[2];
}
