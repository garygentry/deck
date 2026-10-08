/**
 * Checks over what an `http-json` instance writes literally in config. Config is served at
 * `/api/config`, so a credential may never be written there: these names must come from
 * `credentialEnv` instead. Shared by config validation and the request boundary.
 */

/** A header, query parameter or body key whose name suggests it carries a credential. */
export const CREDENTIAL_NAME = /auth|cookie|token|secret|key|pass|session|credential/i;

/**
 * Provider ids built-in modules register under fixed names, which clients address literally.
 * An `http-json` instance under one of them would clash with that provider at boot.
 */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(["alertmanager", "docker", "gatus", "prometheus", "snapshot"]);

/** Why `url` is not a pollable http(s) URL for the runtime's parser, or null. */
export function urlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "must use http or https";
  if (parsed.username !== "" || parsed.password !== "") return "may not carry user:password@";
  return null;
}

/** The url's query parameter names that look like credentials, in order, once each. */
export function credentialQueryParams(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  return [...new Set([...parsed.searchParams.keys()].filter((name) => CREDENTIAL_NAME.test(name)))];
}

/** The keys anywhere in a JSON body that look like credentials, once each. Iterative. */
export function credentialBodyKeys(body: unknown): string[] {
  const found = new Set<string>();
  const pending: unknown[] = [body];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (CREDENTIAL_NAME.test(key)) found.add(key);
        pending.push(child);
      }
    }
  }
  return [...found];
}
