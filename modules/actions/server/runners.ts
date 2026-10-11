/**
 * The runner-name → absolute-executable-path allowlist.
 *
 * The mapping is provisioned by the estate OUTSIDE deck's code, in a JSON manifest at
 * `DECK_RUNNERS_FILE`. Deck loads it once at boot into a
 * `ReadonlyMap<string, string>` and looks names up as map keys — never building a
 * filesystem path from a name — so path traversal is structurally impossible.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Load and validate the runner manifest into an immutable name→absolute-path allowlist.
 * Called once at boot from resolveActionsRuntime when the capability is enabled.
 *
 * Validation (all failures throw code "RUNNERS_MANIFEST_INVALID" — fail-fast at boot,
 * the same posture as a bad estate config):
 *   1. File is readable.
 *   2. Content is valid JSON.
 *   3. Root is a plain object of string → string.
 *   4. Every value is an ABSOLUTE path (isAbsolute) — a relative path is rejected, so a
 *      name can never resolve to a path deck itself computed.
 *   5. Every value points at an existing regular file (existsSync + statSync.isFile()).
 *
 * The read is synchronous on purpose: it runs once, before the server listens, and a
 * missing/broken manifest must abort boot rather than surface at first invocation.
 *
 * @param manifestPath  Absolute path from DECK_RUNNERS_FILE.
 * @returns             A ReadonlyMap of runner name → absolute executable path.
 * @throws {Error & { code: "RUNNERS_MANIFEST_INVALID" }} on any validation failure.
 */
export function loadRunners(manifestPath: string): ReadonlyMap<string, string> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (cause) {
    throw manifestError(`Runner manifest is unreadable at the configured path.`, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw manifestError(`Runner manifest is not valid JSON.`, cause);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw manifestError(`Runner manifest must be a JSON object of name → path.`);
  }

  const runners = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw manifestError(`Runner "${name}" must map to an absolute path string.`);
    }
    if (!isAbsolute(value)) {
      throw manifestError(`Runner "${name}" path must be absolute.`);
    }
    if (!existsSync(value) || !statSync(value).isFile()) {
      throw manifestError(`Runner "${name}" does not point at an existing file.`);
    }
    runners.set(name, value);
  }

  return runners; // returned typed as ReadonlyMap; callers never mutate.
}

/**
 * Resolve a runner NAME to its absolute executable path, or undefined if not present.
 *
 * A pure Map key-lookup — the name is NEVER used to construct a path, so traversal is
 * structurally impossible. Called by the route: an `undefined` result is the
 * unresolved-runner refusal path — the invocation is rejected BEFORE any execution
 * and recorded as a `rejected` audit entry.
 *
 * @param runners  The allowlist from loadRunners (via ActionsRuntime.runners).
 * @param name     Action.runner from the declared, in-config action.
 * @returns        Absolute executable path, or undefined when the name is unknown.
 */
export function lookupRunner(
  runners: ReadonlyMap<string, string>,
  name: string,
): string | undefined {
  return runners.get(name);
}

function manifestError(message: string, cause?: unknown): Error & { code: string } {
  const error = new Error(
    message,
    cause === undefined ? undefined : { cause },
  ) as Error & { code: string };
  error.code = "RUNNERS_MANIFEST_INVALID";
  return error;
}
