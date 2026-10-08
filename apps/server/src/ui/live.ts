import { createHash } from "node:crypto";
import { statSync, watch as watchFs } from "node:fs";
import { sep } from "node:path";

import type { UiFinding, UiManifest } from "@deck/module-sdk";
import type { Logger } from "pino";

import { canonicalize } from "../config/canonical.js";
import type { LoaderResult } from "../config/load.js";
import type { DeckConfig } from "../contract/config.js";
import type { ConfigReloadEvent, ConfigWatchEvent } from "../log/logger.js";

/**
 * The config keys a reload may swap without a restart: presentation only, overlay-owned, read
 * by nothing but the UI manifest resolution and the page's boot object. Every key under them
 * reloads, whatever it is.
 */
export const HOT_KEYS: readonly string[] = ["ui"];

/** How long the directory must be quiet before it is read again. */
export const RELOAD_DEBOUNCE_MS = 250;

/** How often the watch checks that the directory it watches is still the config directory. */
export const WATCH_CHECK_MS = 5_000;

/** What a request serves: one config, its UI manifest and that manifest's ETag, swapped as a unit. */
export interface LiveUi {
  readonly config: DeckConfig;
  readonly ui: UiManifest;
  readonly etag: string;
}

export type ReloadOutcome = ConfigReloadEvent["result"];

/** Watch a directory: `onChange` for any change in it. The returned handle stops watching. */
export type WatchDir = (dir: string, onChange: () => void) => { close(): void };

export interface UiReloaderOptions {
  configDir: string;
  /** The config deck booted with, and the UI manifest resolved from it. */
  config: DeckConfig;
  ui: UiManifest;
  /** Load and validate the config directory, as boot did. */
  load: () => LoaderResult;
  /** Resolve the UI manifest for a config (modules and providers stay as booted). */
  build: (config: DeckConfig) => UiManifest;
  logger: Pick<Logger, "info" | "warn">;
  /** Default: {@link watchDirectory}. */
  watch?: WatchDir;
  /** Default: {@link RELOAD_DEBOUNCE_MS}. */
  debounceMs?: number;
}

export interface UiReloader {
  /** What to serve now. */
  current(): LiveUi;
  /** Read the config directory again now (the watch calls it, debounced). */
  reload(): Promise<ReloadOutcome>;
  /** Stop watching; a pending reload is dropped. */
  stop(): void;
}

/** A manifest's ETag, from its content: any change to the manifest changes it. */
export function etagOf(ui: UiManifest): string {
  return `W/"${createHash("sha1").update(JSON.stringify(ui)).digest("base64url")}"`;
}

/** Whether an `If-None-Match` header names this ETag. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const weak = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || weak(tag) === weak(etag));
}

/**
 * Hot reload of the `ui` config. The directory is watched; once it is quiet for `debounceMs`
 * the whole document is loaded and validated again, and compared with the config deck booted
 * with:
 * - it does not load: the last good config stays, with a `UI_CONFIG_INVALID` finding;
 * - a key outside {@link HOT_KEYS} differs: the last good config stays, with a
 *   `UI_RESTART_REQUIRED` finding (an edit to both does not swap `ui` either);
 * - only `ui` differs: its manifest is resolved and swapped in, findings cleared.
 *
 * Comparing with the booted config, never the last reload, makes what is served a function of
 * the files alone: reverting an edit clears its finding. Reloads run one at a time; a change
 * during one runs another after it.
 */
export function createUiReloader(options: UiReloaderOptions): UiReloader {
  const { configDir, logger } = options;
  const debounceMs = options.debounceMs ?? RELOAD_DEBOUNCE_MS;
  const bootCold = coldPart(options.config);
  let good = { config: options.config, ui: options.ui, canonical: canonicalize(options.config) };
  let live: LiveUi = snapshot(options.config, options.ui);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<ReloadOutcome> | undefined;
  let again = false;
  let stopped = false;

  const publish = (config: DeckConfig, ui: UiManifest) => {
    const next = snapshot(config, ui);
    if (next.etag !== live.etag) live = next;
  };

  const log = (event: Omit<ConfigReloadEvent, "event" | "configDir">, message: string) => {
    const line: ConfigReloadEvent = { event: "config.reload", configDir, ...event };
    if (event.result === "applied" || event.result === "unchanged") logger.info(line, message);
    else logger.warn(line, message);
  };

  const invalid = (problem: string): ReloadOutcome => {
    // Files are named relative to the config directory: /api/ui need not show host paths.
    const reason = problem.replaceAll(`${configDir}${sep}`, "");
    publish(good.config, withFinding(good.ui, {
      code: "UI_CONFIG_INVALID",
      severity: "warning",
      message: `The config changed but does not load, so deck still serves the last good config: ${reason}`,
    }));
    log({ result: "invalid", reason }, "config reload failed; keeping the last good config");
    return "invalid";
  };

  const reloadOnce = (): ReloadOutcome => {
    let result: LoaderResult;
    try {
      result = options.load();
    } catch (cause) {
      return invalid(errorMessage(cause));
    }
    if (result.exitClass !== 0) return invalid(loadProblem(result));

    const candidate = result.config;
    const changedKeys = changedColdKeys(bootCold, coldPart(candidate));
    if (changedKeys.length > 0) {
      publish(good.config, withFinding(good.ui, {
        code: "UI_RESTART_REQUIRED",
        severity: "warning",
        message: `The config changed outside ui (${changedKeys.join(", ")}): restart deck to apply it. Until then deck serves the last good config, and ui changes wait for the restart too.`,
      }));
      log({ result: "restart-required", changedKeys }, "restart required");
      return "restart-required";
    }

    const canonical = canonicalize(candidate);
    if (canonical === good.canonical) {
      // Clears a finding an earlier (reverted) edit left.
      publish(good.config, good.ui);
      log({ result: "unchanged" }, "config reloaded; no ui change");
      return "unchanged";
    }
    let ui: UiManifest;
    try {
      ui = options.build(candidate);
    } catch (cause) {
      return invalid(errorMessage(cause));
    }
    good = { config: candidate, ui, canonical };
    publish(candidate, ui);
    log({ result: "applied" }, "config reloaded; ui updated");
    return "applied";
  };

  const reload = (): Promise<ReloadOutcome> => {
    if (running !== undefined) {
      again = true;
      return running;
    }
    running = (async () => {
      let outcome: ReloadOutcome;
      do {
        again = false;
        outcome = reloadOnce();
      } while (again && !stopped);
      return outcome;
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  const schedule = () => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reload();
    }, debounceMs);
  };

  const watcher = (options.watch ?? watchDirectory(logger))(configDir, schedule);

  return {
    current: () => live,
    reload,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
    },
  };
}

/**
 * Watch a directory for any change, whatever the file name: editors and deploy tools replace
 * files through temp names, and a Kubernetes ConfigMap swaps a symlinked `..data` directory.
 * Every `checkMs` the watch checks the directory is still there and still the one it watches;
 * when it was removed, replaced or the watch failed, it logs that and arms again once it can
 * (then reports a change). It never throws after it starts.
 */
export function watchDirectory(logger: Pick<Logger, "info" | "warn">, checkMs = WATCH_CHECK_MS): WatchDir {
  return (dir, onChange) => {
    let armed: { close(): void; ino: number } | undefined;
    let closed = false;
    const event = (state: ConfigWatchEvent["state"], error?: string): ConfigWatchEvent => ({
      event: "config.watch",
      state,
      configDir: dir,
      ...(error === undefined ? {} : { error }),
    });

    const lose = (error?: string) => {
      if (armed === undefined) return;
      armed.close();
      armed = undefined;
      logger.warn(event("lost", error), "config directory watch lost; deck re-arms it when the directory is back");
    };

    const arm = (state: "armed" | "rearmed") => {
      const ino = inodeOf(dir);
      if (ino === undefined) return false;
      try {
        const fsWatcher = watchFs(dir, { persistent: false }, () => onChange());
        fsWatcher.on("error", (cause) => lose(errorMessage(cause)));
        armed = { close: () => fsWatcher.close(), ino };
      } catch (cause) {
        if (state === "armed") logger.warn(event("lost", errorMessage(cause)), "config directory watch failed; deck retries");
        return false;
      }
      logger.info(event(state), state === "armed" ? "watching config directory" : "config directory watch re-armed");
      return true;
    };

    arm("armed");
    const check = setInterval(() => {
      if (closed) return;
      const ino = inodeOf(dir);
      if (armed !== undefined && ino === armed.ino) return;
      if (armed !== undefined) lose(ino === undefined ? "directory is gone" : "directory was replaced");
      // The directory changed while unwatched: read it again once armed.
      if (arm("rearmed")) onChange();
    }, checkMs);
    (check as { unref?: () => void }).unref?.();

    return {
      close() {
        closed = true;
        clearInterval(check);
        armed?.close();
        armed = undefined;
      },
    };
  };
}

function snapshot(config: DeckConfig, ui: UiManifest): LiveUi {
  return { config, ui, etag: etagOf(ui) };
}

function withFinding(ui: UiManifest, finding: UiFinding): UiManifest {
  return { ...ui, findings: [...ui.findings, finding] };
}

/** The config without its hot keys, by top-level key, canonical. */
function coldPart(config: DeckConfig): Map<string, string> {
  const cold = new Map<string, string>();
  for (const [key, value] of Object.entries(config)) {
    if (!HOT_KEYS.includes(key)) cold.set(key, canonicalize(value as DeckConfig));
  }
  return cold;
}

function changedColdKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

/** Why a failed load failed, in one line: its tool error, or its first error findings. */
function loadProblem(result: Exclude<LoaderResult, { exitClass: 0 }>): string {
  // A YAML error's message ends in a code frame: its first line says what and where.
  if (result.exitClass === 2) return result.toolError.message.split("\n")[0]!.trim();
  const errors = result.findings.filter((finding) => finding.severity === "error");
  const shown = errors.slice(0, 3).map((finding) => `${finding.code} at ${finding.path || "/"}: ${finding.message}`);
  const more = errors.length > shown.length ? ` (and ${errors.length - shown.length} more)` : "";
  return shown.length === 0 ? "the config has findings that stop deck from starting" : `${shown.join("; ")}${more}`;
}

function inodeOf(dir: string): number | undefined {
  try {
    const stats = statSync(dir);
    return stats.isDirectory() ? stats.ino : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
