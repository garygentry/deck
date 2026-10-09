import type { EnvReader, ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";

import { POLL_DEFAULTS } from "../../contract/index.js";
import { credentialBodyKeys, credentialHeaderNames, credentialQueryParams } from "./literal.js";

/** How the credential `credentialEnv` names is sent. Without one, it is the raw `Authorization` value. */
export type HttpJsonAuth =
  | { scheme: "bearer" }
  | { scheme: "basic" }
  | { scheme: "header"; header: string }
  | { scheme: "query"; param: string };

export interface HttpJsonConfig {
  url: string;
  method?: "GET" | "POST";
  /** Literal, non-secret request headers. A credential never goes here. */
  headers?: Readonly<Record<string, string>>;
  /** A JSON request body, sent with `POST` only. */
  body?: unknown;
  /** The env var holding the credential: its name, never its value. */
  credentialEnv?: string;
  auth?: HttpJsonAuth;
  /** Reads `credentialEnv` at fetch time, so a rotated credential is picked up. */
  env?: EnvReader;
  timeoutMs?: number;
  /** The largest response body accepted, in bytes. */
  maxBytes?: number;
}

/** Why a poll failed. Every message names the failure, never a credential, URL or body. */
export type HttpJsonErrorCode =
  | "credential"
  | "unreachable"
  | "timeout"
  | "redirect"
  | "http-status"
  | "too-large"
  | "too-deep"
  | "not-json"
  | "credential-echo";

export class HttpJsonError extends Error {
  constructor(
    readonly code: HttpJsonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = code === "timeout" ? "TimeoutError" : "HttpJsonError";
  }
}

export const HTTP_JSON_DEFAULT_MAX_BYTES = 1024 * 1024;
export const HTTP_JSON_MAX_REDIRECTS = 5;
/** The deepest nesting of arrays and objects accepted in a response. */
export const HTTP_JSON_MAX_DEPTH = 64;
/** The shortest credential accepted: a shorter one could not be told apart in an echo scan. */
export const HTTP_JSON_MIN_CREDENTIAL_LENGTH = 8;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** What a header value may hold: tab, printable ASCII and the rest of Latin-1. */
const HEADER_VALUE = /^[\t\x20-\x7E\x80-\xFF]*$/;
/** Runtime error codes for a connect, header or body timeout of the runtime's own. */
const RUNTIME_TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "TimeoutError",
]);

/** The credential for one poll: where it goes, and every form it may come back in. */
interface Credential {
  header?: { name: string; value: string };
  query?: { param: string; value: string };
  /** The raw value and its transmitted encodings, for the echo check. */
  forms: string[];
}

/**
 * The `http-json` provider: one request per poll, whose parsed JSON body is the envelope's
 * `data`. Redirects are followed by hand: an authenticated request follows only same-origin
 * ones, so the credential never leaves the configured origin. A body over `maxBytes`, nested
 * past {@link HTTP_JSON_MAX_DEPTH}, or echoing the credential is refused, never published.
 */
export class HttpJsonProvider implements ProviderSpec<unknown> {
  readonly kind = "http-json";

  /** Cached latest health; updated only by fetch(), never by a health() probe. */
  private latestHealth: ProviderHealth = { ok: false, detail: "Awaiting first poll" };

  constructor(
    readonly id: string,
    private readonly cfg: HttpJsonConfig,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ...this.latestHealth };
  }

  async fetch(context?: ProviderFetchContext): Promise<unknown> {
    const timeoutMs = this.cfg.timeoutMs ?? POLL_DEFAULTS.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    context?.signal.addEventListener("abort", onAbort, { once: true });
    if (context?.signal.aborted) controller.abort();
    try {
      const { status, data } = await this.request(controller.signal);
      this.latestHealth = { ok: true, detail: `HTTP ${status}` };
      return data;
    } catch (error) {
      const classified = classify(error, controller.signal, timeoutMs);
      this.latestHealth = { ok: false, detail: classified.message };
      throw classified;
    } finally {
      clearTimeout(timer);
      context?.signal.removeEventListener("abort", onAbort);
    }
  }

  private async request(signal: AbortSignal): Promise<{ status: number; data: unknown }> {
    refuseLiteralCredentials(this.cfg);
    const origin = new URL(this.cfg.url).origin;
    const credential = credentialFor(this.cfg);
    let url = this.cfg.url;
    let method = this.cfg.method ?? "GET";
    let body = method === "POST" && this.cfg.body !== undefined ? JSON.stringify(this.cfg.body) : undefined;

    for (let hop = 0; ; hop += 1) {
      const headers = new Headers({ Accept: "application/json" });
      for (const [name, value] of Object.entries(this.cfg.headers ?? {})) headers.set(name, value);
      if (body !== undefined && !headers.has("content-type")) headers.set("Content-Type", "application/json");
      // Set last, so a literal header of the same name never replaces the credential.
      if (credential?.header) headers.set(credential.header.name, credential.header.value);
      const target = new URL(url);
      // Every hop is on the configured origin when a credential is sent (see below).
      if (credential?.query) target.searchParams.set(credential.query.param, credential.query.value);

      const response = await globalThis.fetch(target, { method, headers, body, redirect: "manual", signal });
      if (!REDIRECT_STATUSES.has(response.status)) {
        const data = await readJson(response, this.cfg.maxBytes);
        if (credential !== null && echoes(data, credential.forms)) {
          throw new HttpJsonError("credential-echo", "upstream response contains the credential; not published");
        }
        return { status: response.status, data };
      }

      await discard(response);
      const location = response.headers.get("location");
      if (location === null) throw new HttpJsonError("redirect", `upstream answered HTTP ${response.status} without a Location`);
      if (hop >= HTTP_JSON_MAX_REDIRECTS) throw new HttpJsonError("redirect", `more than ${HTTP_JSON_MAX_REDIRECTS} redirects`);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new HttpJsonError("redirect", "redirect to an invalid URL refused");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new HttpJsonError("redirect", "redirect to a non-http(s) URL refused");
      }
      if (next.username !== "" || next.password !== "") {
        throw new HttpJsonError("redirect", "redirect to a URL with credentials refused");
      }
      // The Location itself could carry the credential (reflected from the query, say), so an
      // authenticated request never leaves the configured origin, a scheme change included.
      if (credential !== null && next.origin !== origin) {
        throw new HttpJsonError("redirect", "cross-origin redirect refused for an authenticated request");
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      url = next.href;
    }
  }
}

/**
 * Config validation refuses these too; the request boundary checks again, so a literal
 * credential is never sent whatever path the config took.
 */
function refuseLiteralCredentials({ url, body, headers }: HttpJsonConfig): void {
  const [header] = credentialHeaderNames(headers);
  if (header !== undefined) throw new HttpJsonError("credential", `header ${header} names a credential; credentials come from credentialEnv`);
  const [param] = credentialQueryParams(url);
  if (param !== undefined) {
    throw new HttpJsonError("credential", `url query parameter ${param} looks like a credential; use credentialEnv with auth.scheme query`);
  }
  const [key] = credentialBodyKeys(body);
  if (key !== undefined) throw new HttpJsonError("credential", `body key ${key} looks like a credential; credentials come from credentialEnv`);
}

/** The credential for this poll, or null when none is configured. */
function credentialFor({ credentialEnv, env, auth }: HttpJsonConfig): Credential | null {
  if (credentialEnv === undefined) return null;
  const value = env?.get(credentialEnv);
  // Names only: the variable is named in config, its value never leaves this function.
  if (value === undefined || value === "") {
    throw new HttpJsonError(
      "credential",
      `credential variable ${credentialEnv} is not set or not readable by this module (see MODULE_CREDENTIAL_ENV_REFUSED)`,
    );
  }
  // A short or padded value cannot be reliably found in an echo (and a header trims padding).
  if (value.length < HTTP_JSON_MIN_CREDENTIAL_LENGTH || value.trim() !== value) {
    throw new HttpJsonError(
      "credential",
      `credential variable ${credentialEnv} must hold at least ${HTTP_JSON_MIN_CREDENTIAL_LENGTH} characters, without surrounding whitespace`,
    );
  }
  const raw = [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)];
  switch (auth?.scheme) {
    case "basic": {
      // Base64 carries any value; only the encoded pair is sent.
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const password = value.includes(":") ? value.slice(value.indexOf(":") + 1) : "";
      return { header: { name: "Authorization", value: `Basic ${encoded}` }, forms: [...raw, encoded, password] };
    }
    case "query":
      return { query: { param: auth.param, value }, forms: raw };
    default: {
      if (!HEADER_VALUE.test(value)) {
        throw new HttpJsonError("credential", `credential variable ${credentialEnv} holds a character a header cannot carry`);
      }
      const header = auth?.scheme === "bearer"
        ? { name: "Authorization", value: `Bearer ${value}` }
        : { name: auth?.scheme === "header" ? auth.header : "Authorization", value };
      // Exactly what goes on the wire, after the runtime's own header normalisation.
      const sent = new Headers([[header.name, header.value]]).get(header.name) ?? header.value;
      return { header, forms: [...raw, header.value, sent] };
    }
  }
}

/** Whether any string or key in `data` contains one of the credential's forms. Iterative. */
function echoes(data: unknown, forms: readonly string[]): boolean {
  // Every form of an accepted credential is long enough to match as a substring; a short
  // fragment (a basic pair's password) is covered by the whole pair's forms.
  const scanned = [...new Set(forms)].filter((form) => form.length >= HTTP_JSON_MIN_CREDENTIAL_LENGTH);
  const hit = (text: string) => scanned.some((form) => text.includes(form));
  const pending: unknown[] = [data];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (hit(value)) return true;
    } else if (Array.isArray(value)) {
      // Element by element: spreading a wide array into push() overflows the call stack.
      for (const item of value) pending.push(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (hit(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

/** Read a 2xx body as JSON, capped at `maxBytes` and {@link HTTP_JSON_MAX_DEPTH}; any other status is a failure. */
async function readJson(response: Response, maxBytes = HTTP_JSON_DEFAULT_MAX_BYTES): Promise<unknown> {
  if (response.status < 200 || response.status > 299) {
    await discard(response);
    throw new HttpJsonError("http-status", `upstream answered HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    throw tooLarge(maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  // Checked before parsing: deep nesting would overflow recursive walks over the data later.
  if (nestsDeeperThan(text, HTTP_JSON_MAX_DEPTH)) {
    throw new HttpJsonError("too-deep", `upstream response nests deeper than ${HTTP_JSON_MAX_DEPTH} levels`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpJsonError("not-json", "upstream response is not JSON");
  }
}

/** Whether JSON text opens more than `max` arrays or objects at once, brackets in strings aside. One linear scan. */
export function nestsDeeperThan(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === 0x5c) index += 1; // backslash: skip the escaped character
      else if (char === 0x22) inString = false;
    } else if (char === 0x22) {
      inString = true;
    } else if (char === 0x5b || char === 0x7b) {
      depth += 1;
      if (depth > max) return true;
    } else if (char === 0x5d || char === 0x7d) {
      depth -= 1;
    }
  }
  return false;
}

function tooLarge(maxBytes: number): HttpJsonError {
  return new HttpJsonError("too-large", `upstream response exceeds ${maxBytes} bytes`);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/**
 * Map any failure to an {@link HttpJsonError}. A runtime's own error text can carry the
 * request URL or headers, so it is never passed on: only a bare error code is kept.
 */
function classify(error: unknown, signal: AbortSignal, timeoutMs: number): HttpJsonError {
  if (error instanceof HttpJsonError) return error;
  if (signal.aborted) return new HttpJsonError("timeout", `timed out after ${timeoutMs}ms`);
  const code = errorCode(error);
  if (code !== null && RUNTIME_TIMEOUT_CODES.has(code)) return new HttpJsonError("timeout", `timed out (${code})`);
  return new HttpJsonError("unreachable", code === null ? "upstream unreachable" : `upstream unreachable (${code})`);
}

/** A network error code (`ECONNREFUSED`, Bun's `ConnectionRefused`), from the error or its causes. */
function errorCode(error: unknown): string | null {
  for (let current = error, depth = 0; current !== null && typeof current === "object" && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(code)) return code;
    const name = (current as { name?: unknown }).name;
    if (name === "TimeoutError") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
