import type { EnvReader, ProviderFetchContext, ProviderHealth, ProviderSpec } from "@deck/module-sdk";

import { POLL_DEFAULTS } from "../../contract/index.js";

/** How the credential `credentialEnv` names is sent. Without one, it is the raw `Authorization` value. */
export type HttpJsonAuth =
  | { scheme: "bearer" }
  | { scheme: "basic" }
  | { scheme: "header"; header: string };

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
  | "not-json";

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
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The `http-json` provider: one request per poll, whose parsed JSON body is the envelope's
 * `data`. Redirects are followed by hand, so the credential is dropped as soon as one leaves
 * the configured origin, and a body over `maxBytes` is cut off unread.
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
      const { status, data } = await this.request(controller.signal, timeoutMs);
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

  private async request(signal: AbortSignal, timeoutMs: number): Promise<{ status: number; data: unknown }> {
    const origin = new URL(this.cfg.url).origin;
    const credential = credentialHeader(this.cfg);
    let url = this.cfg.url;
    let method = this.cfg.method ?? "GET";
    let body = method === "POST" && this.cfg.body !== undefined ? JSON.stringify(this.cfg.body) : undefined;
    let sendCredential = credential !== null;

    for (let hop = 0; ; hop += 1) {
      const headers = new Headers({ Accept: "application/json" });
      for (const [name, value] of Object.entries(this.cfg.headers ?? {})) headers.set(name, value);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      // Set last, so a literal header of the same name never replaces the credential.
      if (sendCredential && credential !== null) headers.set(credential.name, credential.value);

      const response = await globalThis.fetch(url, { method, headers, body, redirect: "manual", signal });
      if (!REDIRECT_STATUSES.has(response.status)) return { status: response.status, data: await readJson(response, this.cfg.maxBytes) };

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
      // Once the request leaves the configured origin (a scheme change included) the
      // credential is dropped for the rest of the chain, as fetch does for Authorization.
      if (next.origin !== origin) sendCredential = false;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      url = next.href;
      if (signal.aborted) throw timeoutError(timeoutMs);
    }
  }
}

/** The credential header for this poll, or null when none is configured. */
function credentialHeader({ credentialEnv, env, auth }: HttpJsonConfig): { name: string; value: string } | null {
  if (credentialEnv === undefined) return null;
  const value = env?.get(credentialEnv);
  // Names only: the variable is named in config, its value never leaves this function.
  if (value === undefined || value === "") {
    throw new HttpJsonError("credential", `credential variable ${credentialEnv} is not set`);
  }
  if (/[\r\n]/.test(value)) throw new HttpJsonError("credential", `credential variable ${credentialEnv} holds a line break`);
  switch (auth?.scheme) {
    case "bearer":
      return { name: "Authorization", value: `Bearer ${value}` };
    case "basic":
      return { name: "Authorization", value: `Basic ${Buffer.from(value, "utf8").toString("base64")}` };
    case "header":
      return { name: auth.header, value };
    default:
      return { name: "Authorization", value };
  }
}

/** Read a 2xx body as JSON, capped at `maxBytes`; any other status is a failure. */
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
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpJsonError("not-json", "upstream response is not JSON");
  }
}

function tooLarge(maxBytes: number): HttpJsonError {
  return new HttpJsonError("too-large", `upstream response exceeds ${maxBytes} bytes`);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function timeoutError(timeoutMs: number): HttpJsonError {
  return new HttpJsonError("timeout", `timed out after ${timeoutMs}ms`);
}

/**
 * Map any failure to an {@link HttpJsonError}. A runtime's own error text can carry the
 * request URL or headers, so it is never passed on: only a bare error code is kept.
 */
function classify(error: unknown, signal: AbortSignal, timeoutMs: number): HttpJsonError {
  if (error instanceof HttpJsonError) return error;
  if (signal.aborted) return timeoutError(timeoutMs);
  const code = errorCode(error);
  return new HttpJsonError("unreachable", code === null ? "upstream unreachable" : `upstream unreachable (${code})`);
}

/** A network error code (`ECONNREFUSED`, Bun's `ConnectionRefused`), from the error or its cause. */
function errorCode(error: unknown): string | null {
  for (let current = error, depth = 0; current !== null && typeof current === "object" && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
