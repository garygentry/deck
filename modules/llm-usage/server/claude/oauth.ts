import { readFile } from "node:fs/promises";

/**
 * Claude OAuth usage backfill (`GET /api/oauth/usage`). The only source with every
 * panel row, but undocumented and 429-prone, so callers go through `cadence.ts` and
 * never poll it below the floor.
 *
 * The credentials file is a read-only mount, re-read on every call so a token refreshed
 * by the Claude CLI on the host is picked up without a restart. Deck never refreshes or
 * writes the token, and the token never appears in a result, detail or log line.
 */

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 15_000;

export interface OauthDeps {
  readFile: (path: string) => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
}

export const defaultOauthDeps: OauthDeps = {
  readFile: (path) => readFile(path, "utf8"),
  fetch: (...args) => fetch(...args),
  now: Date.now,
};

export type OauthResult =
  | { ok: true; body: unknown; plan: string | null }
  | {
    ok: false;
    /** `not-configured`: no usable token in the file; `error`: transport or HTTP failure. */
    kind: "not-configured" | "error";
    detail: string;
    /** Server-directed backoff in ms; 0 unless the response carried a positive `Retry-After`. */
    retryAfterMs: number;
  };

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface OauthCredentials {
  accessToken: string;
  plan: string | null;
  expired: boolean;
}

function parseCredentials(raw: string, now: number): OauthCredentials | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = isRecord(doc) && isRecord(doc.claudeAiOauth) ? doc.claudeAiOauth : null;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
  return {
    accessToken: oauth.accessToken,
    plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    expired: typeof oauth.expiresAt === "number" && oauth.expiresAt < now,
  };
}

/**
 * `Retry-After` values from this endpoint are inconsistent (`0` on some plans), so only
 * a positive delta-seconds value is trusted.
 */
export function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return header !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

const failure = (kind: "not-configured" | "error", detail: string, retry = 0): OauthResult =>
  ({ ok: false, kind, detail, retryAfterMs: retry });

export async function fetchOauthUsage(credentialsFile: string, deps: OauthDeps = defaultOauthDeps): Promise<OauthResult> {
  let raw: string;
  try {
    raw = await deps.readFile(credentialsFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failure("not-configured", `credentials file unreadable${code ? ` (${code})` : ""}`);
  }
  const creds = parseCredentials(raw, deps.now());
  if (!creds) return failure("not-configured", "no claudeAiOauth.accessToken in credentials file (sign-in needed)");

  let res: Response;
  try {
    res = await deps.fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return failure("error", `request failed: ${error instanceof Error ? error.name : "unknown"}`);
  }

  if (!res.ok) {
    const retry = retryAfterMs(res.headers.get("retry-after"));
    const hint = res.status === 401 && creds.expired ? " (token expired; run claude on the host to refresh)" : "";
    return failure("error", `HTTP ${res.status}${hint}`, retry);
  }
  try {
    return { ok: true, body: await res.json(), plan: creds.plan };
  } catch {
    return failure("error", "response was not JSON");
  }
}
