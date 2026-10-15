/**
 * Checks over what an `http-json` instance writes literally in config. Config is served at
 * `/api/config`, so a credential may never be written there: these names must come from
 * `credentialEnv` instead. Shared by config validation and the request boundary.
 */

/**
 * How a name is judged. It is read two ways, and is a credential if either reading matches:
 * split at `_`, `-`, `.` and whitespace only, and also at camelCase boundaries. Both readings are
 * lowercased and split between letters and digits, with digit-only parts dropped, so
 * `Ocp-Apim-SubScription-Key`, `aCcess_kEy`, `PassWord` and `api_key2` are judged like their
 * plain spellings. Within a reading, a name is a credential when:
 * - a part is a credential word (`CREDENTIAL_WORDS`);
 * - a part ends in a credential ending (`CREDENTIAL_SUFFIXES`: `apitoken`, `dbpassword`, `userpwd`);
 * - the parts up to some part, run together, end in a qualified key (`CREDENTIAL_COMPOUNDS`:
 *   `api_key`, `X-Api-Key`, `xapikey`, `AWS_ACCESS_KEY_ID`, `Ocp-Apim-Subscription-Key`);
 * - `pass` is the whole name or its last part (`X-Pass`, `DB_PASS`), or a part ends in `pass`
 *   other than a word like `bypass` or `compass` (`userpass`, `storepass`);
 * - the whole name is `key`.
 * A pagination or sync cursor (`CURSOR_ENDINGS`: `pageToken`, `next_token`, `syncToken`) is not
 * a credential. Whole parts only, so `author`, `keys`, `sort_key`, `monkey`, `passed`, `passport`,
 * `pass_through`, `tokenizer` and the arbitrary splits `au_th` and `pass_word` are not credentials.
 */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "auth", "authorization", "bearer", "cookie", "credential", "credentials", "jwt", "passphrase",
  "session", "sessionid", "jsessionid", "phpsessid", "sig", "signature",
]);
/** Endings that make a part a credential. Not `key`: `monkey`, `hotkey` and `turnkey` are not credentials. */
const CREDENTIAL_SUFFIXES: readonly string[] = [
  "token", "tokens", "secret", "secrets", "password", "passwords", "passwd", "pwd",
];
/** Keys qualified by what they are; matched at the end of the parts run together up to a part boundary. */
const CREDENTIAL_COMPOUNDS: readonly string[] = [
  "accesskey", "accountkey", "apikey", "appkey", "applicationkey", "authkey", "clientkey",
  "consumerkey", "encryptionkey", "functionkey", "functionskey", "gotifykey", "hmackey",
  "licensekey", "masterkey", "privatekey", "secretkey", "sharedkey", "signingkey", "sshkey",
  "subscriptionkey",
];
/** Words ending in `pass` that are not a password. */
const PASS_WORDS: ReadonlySet<string> = new Set(["bypass", "compass", "encompass", "overpass", "surpass", "trespass", "underpass"]);
/** Whole-name endings (run together) of pagination and sync cursors, which are not credentials. */
const CURSOR_ENDINGS: readonly string[] = ["pagetoken", "nexttoken", "synctoken", "continuationtoken", "cursortoken"];

/** The lowercase parts of `name`: split at separators, optionally at camelCase, and between letters and digits. */
function parts(name: string, camel: boolean): string[] {
  const spaced = camel ? name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") : name;
  return spaced
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0 && !/^[0-9]+$/.test(part));
}

function matches(words: string[]): boolean {
  if (words.length === 1 && words[0] === "key") return true;
  if (words.at(-1) === "pass") return true;
  let joined = "";
  return words.some((word) => {
    joined += word;
    return (
      CREDENTIAL_WORDS.has(word) ||
      CREDENTIAL_SUFFIXES.some((suffix) => word.endsWith(suffix)) ||
      (word.endsWith("pass") && word !== "pass" && !PASS_WORDS.has(word)) ||
      CREDENTIAL_COMPOUNDS.some((compound) => joined.endsWith(compound))
    );
  });
}

/** Whether a header, query parameter or body key name suggests a credential; the rule is above. */
export function isCredentialName(name: string): boolean {
  const plain = parts(name, false);
  if (CURSOR_ENDINGS.some((ending) => plain.join("").endsWith(ending))) return false;
  return matches(plain) || matches(parts(name, true));
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
