/**
 * Checks over what an `http-json` instance writes literally in config. Config is served at
 * `/api/config`, so a credential may never be written there: these names must come from
 * `credentialEnv` instead. Shared by config validation and the request boundary.
 */

/**
 * Words that name a credential wherever they appear as a whole token of a name, and compounds
 * that do so when written as one token (`apikey`) or as adjacent tokens (`api_key`, `X-Api-Key`,
 * `AccessKey`, `Ocp-Apim-Subscription-Key`). Matching is case- and separator-insensitive.
 */
const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set([
  "auth", "authorization", "bearer", "cookie", "credential", "credentials", "jwt", "passphrase",
  "passwd", "password", "pwd", "secret", "session", "sig", "signature", "token",
  // Compounds: a key or secret qualified by what it is (a bare `key` only counts alone).
  "accesskey", "accountkey", "apikey", "appkey", "authkey", "clientkey", "clientsecret",
  "encryptionkey", "functionskey", "licensekey", "masterkey", "privatekey", "secretkey",
  "sharedkey", "signingkey", "subscriptionkey",
]);
/** Names that are a credential only as the whole name: `key=…` or `pass=…`, not `sort_key` or `pass_through`. */
const CREDENTIAL_SOLO: ReadonlySet<string> = new Set(["key", "pass"]);
/**
 * Endings that mark a single run-together token as a credential (`apitoken`, `authtoken`,
 * `dbpassword`, `clientsecret`). Not `key`: `monkey`, `hotkey` and `turnkey` are not credentials.
 */
const CREDENTIAL_SUFFIXES: readonly string[] = ["token", "secret", "password", "passwd"];

/** A name's tokens: split on `_`, `-`, `.` and whitespace, and at camelCase boundaries; lowercased. */
function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

function isCredentialToken(token: string): boolean {
  return CREDENTIAL_TOKENS.has(token) || CREDENTIAL_SUFFIXES.some((suffix) => token.endsWith(suffix));
}

/**
 * Whether a header, query parameter or body key name suggests a credential. A name matches when
 * one of its tokens, or two adjacent tokens joined, is a credential word or compound, or when a
 * token ends in a credential word. Whole tokens only, so `author`, `keys`, `sort_key`, `passed`,
 * `passive`, `tokenizer` and `monkey` are not credentials, while `api_key`, `X-Api-Key`,
 * `accessToken`, `Authorization`, `pwd`, `jwt`, `access_key`, `Ocp-Apim-Subscription-Key` and a
 * bare `key` or `pass` are.
 */
export function isCredentialName(name: string): boolean {
  const parts = tokens(name);
  if (parts.length === 1 && CREDENTIAL_SOLO.has(parts[0]!)) return true;
  return parts.some(
    (part, index) => isCredentialToken(part) || (index + 1 < parts.length && CREDENTIAL_TOKENS.has(part + parts[index + 1])),
  );
}

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
  return [...new Set(Array.from(parsed.searchParams.keys()).filter(isCredentialName))];
}

/** The literal header names that look like credentials. */
export function credentialHeaderNames(headers: unknown): string[] {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return [];
  return Object.keys(headers).filter(isCredentialName);
}

/** The keys anywhere in a JSON body that look like credentials, once each. Iterative. */
export function credentialBodyKeys(body: unknown): string[] {
  const found = new Set<string>();
  const pending: unknown[] = [body];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      // Element by element: spreading a wide array into push() overflows the call stack.
      for (const item of value) pending.push(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (isCredentialName(key)) found.add(key);
        pending.push(child);
      }
    }
  }
  return [...found];
}
