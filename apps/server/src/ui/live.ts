import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync, watch as watchFs } from "node:fs";
import { basename, join } from "node:path";

import type { UiFinding, UiManifest } from "@deck/module-sdk";
import { FINDING_CATALOG, MODULE_HOST_FINDING_CATALOG, type Finding } from "@deck/schema";
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
  reload(): ReloadOutcome;
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
 * - only `ui` differs: the config and its manifest are swapped in, findings cleared.
 *
 * Comparing with the booted config, never the last reload, makes what is served a function of
 * the files alone: reverting an edit clears its finding. The directory is read once more as
 * soon as the watch is armed, so an edit made while deck was starting is not missed.
 *
 * What a reload publishes (findings and the `config.reload` log line) is written by deck alone:
 * finding codes, JSON pointers and the catalogue's summaries, never a loader, module or
 * exception message, which may carry anything the config or the environment holds.
 * `deck validate` gives the detail.
 */
export function createUiReloader(options: UiReloaderOptions): UiReloader {
  const { configDir, logger } = options;
  const debounceMs = options.debounceMs ?? RELOAD_DEBOUNCE_MS;
  const bootCold = coldPart(options.config);
  let good = { config: options.config, ui: options.ui, canonical: canonicalize(options.config) };
  let live: LiveUi = snapshot(options.config, options.ui);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** Serve this config and manifest. Only a swap replaces an unchanged manifest's snapshot. */
  const publish = (config: DeckConfig, ui: UiManifest, swap = false) => {
    const next = snapshot(config, ui);
    if (swap || next.etag !== live.etag) live = next;
  };

  const log = (event: Omit<ConfigReloadEvent, "event" | "configDir">, message: string) => {
    const line: ConfigReloadEvent = { event: "config.reload", configDir, ...event };
    if (event.result === "applied" || event.result === "unchanged") logger.info(line, message);
    else logger.warn(line, message);
  };

  const invalid = (reason: string): ReloadOutcome => {
    publish(good.config, withFinding(good.ui, {
      code: "UI_CONFIG_INVALID",
      severity: "warning",
      message: `The config changed but does not load, so deck still serves the last good config: ${reason}. Run deck validate for the details.`,
    }));
    log({ result: "invalid", reason }, "config reload failed; keeping the last good config");
    return "invalid";
  };

  const reload = (): ReloadOutcome => {
    let result: LoaderResult;
    try {
      result = options.load();
    } catch {
      return invalid("the config could not be read");
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
      // Building the manifest also replaces the providers' projections with its config pages'
      // selects (see buildUiManifest); the swap below follows in the same synchronous step, so no
      // request sees one without the other. The paths above never build: the last good selects stay.
      ui = options.build(candidate);
    } catch {
      return invalid("the UI manifest could not be resolved from it");
    }
    good = { config: candidate, ui, canonical };
    // A ui change that leaves the manifest as it was (a theme default, say) still swaps: the
    // config, and the page's boot object rendered from it, change.
    publish(candidate, ui, true);
    log({ result: "applied" }, "config reloaded; ui updated");
    return "applied";
  };

  const schedule = () => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      reload();
    }, debounceMs);
  };

  const watcher = (options.watch ?? watchDirectory(logger))(configDir, schedule);
  // The config deck booted with was read before the watch was armed (modules start in between):
  // read the directory once more, so an edit made meanwhile is not missed.
  schedule();

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

export interface WatchDirectoryOptions {
  /** How often the directory's identity and files are checked. Default: {@link WATCH_CHECK_MS}. */
  checkMs?: number;
  /** Listen for file-system events as well (default true); without them, only the check sees changes. */
  events?: boolean;
}

/**
 * Watch a directory for any change, whatever the file name: editors and deploy tools replace
 * files through temp names, and a Kubernetes ConfigMap swaps a symlinked `..data` directory.
 *
 * File-system events report most changes at once, but not all: under Bun, re-pointing a
 * ConfigMap's `..data` symlink raises none. So every `checkMs` the watch also fingerprints the
 * YAML files deck reads (each one's real path, modification time and size, through symlinks)
 * and reports a change when the fingerprint moves: a change is seen within `checkMs` at worst.
 *
 * The directory is identified by device, inode and birth time (a directory deleted and made
 * again can reuse its inode). On every event and every check, the watch checks it still
 * watches that directory. When the directory is gone or was replaced, or the watch failed, it
 * logs that, reports a change (a reload then says the config is missing) and arms again once
 * the directory is back, reporting another change. It never throws after it starts.
 */
export function watchDirectory(logger: Pick<Logger, "info" | "warn">, options: WatchDirectoryOptions = {}): WatchDir {
  const checkMs = options.checkMs ?? WATCH_CHECK_MS;
  const events = options.events ?? true;
  return (dir, onChange) => {
    let armed: { close(): void; id: string } | undefined;
    let print = fingerprintOf(dir);
    let closed = false;
    const event = (state: ConfigWatchEvent["state"], error?: string): ConfigWatchEvent => ({
      event: "config.watch",
      state,
      configDir: dir,
      ...(error === undefined ? {} : { error }),
    });

    /** Report a change, and remember the files as they are now. */
    const changed = () => {
      print = fingerprintOf(dir);
      onChange();
    };

    const lose = (error: string) => {
      if (armed === undefined) return;
      armed.close();
      armed = undefined;
      logger.warn(event("lost", error), "config directory watch lost; deck re-arms it when the directory is back");
      changed();
    };

    /** Watch the directory as it is now; `state` names the log line, none when quiet. */
    const arm = (state: "armed" | "rearmed" | "quiet") => {
      const id = identityOf(dir);
      if (id === undefined) return false;
      let close = () => undefined as void;
      if (events) {
        try {
          const fsWatcher = watchFs(dir, { persistent: false }, (type, name) => {
            if (closed) return;
            if (!verify()) return;
            // Node names the directory itself when it is deleted (Bun reports nothing), and a
            // directory made again at once can look the same to `stat`. A file of that name in
            // it raises the same event: either way, watch the directory as it is now.
            if (type === "rename" && name === basename(dir)) {
              armed?.close();
              armed = undefined;
              arm("quiet");
            }
            changed();
          });
          fsWatcher.on("error", () => lose("watch failed"));
          close = () => fsWatcher.close();
        } catch {
          if (state === "armed") logger.warn(event("lost", "watch failed"), "config directory watch failed; deck retries");
          return false;
        }
      }
      armed = { close, id };
      if (state !== "quiet") logger.info(event(state), state === "armed" ? "watching config directory" : "config directory watch re-armed");
      return true;
    };

    /** Whether the armed watch still watches the directory; loses it when not. */
    const verify = (): boolean => {
      if (armed === undefined) return false;
      const id = identityOf(dir);
      if (id === armed.id) return true;
      lose(id === undefined ? "directory is gone" : "directory was replaced");
      return false;
    };

    arm("armed");
    const check = setInterval(() => {
      if (closed) return;
      if (armed !== undefined && verify()) {
        // The files may have changed with no event (a symlink re-pointed under Bun).
        if (fingerprintOf(dir) !== print) changed();
        return;
      }
      // The directory may have changed while unwatched: read it again once armed.
      if (arm("rearmed")) changed();
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

/**
 * The YAML files deck would read in a directory, as it would read them: each one's name, real
 * path, modification time and size, following symlinks. Changes when any of them does.
 */
function fingerprintOf(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /\.ya?ml$/i.test(name)).sort();
  } catch {
    return "missing";
  }
  return names
    .map((name) => {
      const path = join(dir, name);
      try {
        const stats = statSync(path);
        return `${name}>${realpathSync(path)}:${stats.mtimeMs}:${stats.size}`;
      } catch {
        return `${name}>missing`;
      }
    })
    .join("\n");
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

/** What deck says about each loader tool error: no path, no file content. */
const TOOL_ERROR_TEXT: Readonly<Record<string, string>> = {
  CONFIG_DIR_MISSING: "the config directory is missing or is not a directory",
  CONFIG_DIR_EMPTY: "the config directory contains no YAML files",
  CONFIG_YAML_PARSE: "a config file is not valid YAML",
  CONFIG_MERGE_ERROR: "the config layers cannot be merged",
  CONFIG_MIGRATION_REQUIRED: "a config file is schemaVersion 1 and needs deck config migrate",
};

const CATALOG: Readonly<Record<string, { summary: string }>> = { ...FINDING_CATALOG, ...MODULE_HOST_FINDING_CATALOG };

/** How many error findings a reload names. */
const SHOWN_FINDINGS = 3;

/**
 * Why a failed load failed, in deck's own words: a tool error's code and its text, or the first
 * error findings' codes and JSON pointers, with the catalogue's summary for a kernel code. A
 * module's own finding is named by its code and its section (`/modules/<id>`), never by its
 * message or its own path.
 */
function loadProblem(result: Exclude<LoaderResult, { exitClass: 0 }>): string {
  if (result.exitClass === 2) {
    const code = publicCode(result.toolError.code);
    const text = TOOL_ERROR_TEXT[code] ?? CATALOG[code]?.summary.replace(/\.$/, "");
    return text === undefined ? code : `${code}: ${text}`;
  }
  const errors = result.findings.filter((finding) => finding.severity === "error");
  if (errors.length === 0) return "the config has findings that stop deck from starting";
  const shown = errors.slice(0, SHOWN_FINDINGS).map(publicFinding);
  const more = errors.length > shown.length ? ` (and ${errors.length - shown.length} more)` : "";
  return `${shown.join("; ")}${more}`;
}

function publicFinding(finding: Finding): string {
  const code = publicCode(finding.code);
  const summary = CATALOG[code]?.summary;
  // A kernel code's pointer is the kernel's; a module's finding names only the module's section,
  // since a module chooses its own path and anything may ride in it.
  const pointer = summary === undefined ? modulePointer(finding.path) : kernelPointer(finding.path);
  return `${code} at ${pointer}${summary === undefined ? "" : ` (${summary.replace(/\.$/, "")})`}`;
}

function kernelPointer(path: string): string {
  return /^(\/[^\s]*)?$/.test(path) && path.length <= 200 ? path || "/" : "/";
}

function modulePointer(path: string): string {
  const id = /^\/modules\/([a-z][a-z0-9-]{0,63})(?:\/|$)/.exec(path)?.[1];
  return id === undefined ? "/" : `/modules/${id}`;
}

/** A code as an identifier: anything else (a module's code is any string) is not repeated. */
function publicCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNKNOWN_CODE";
}

/** The directory's identity: device, inode and birth time, or none while it does not exist. */
function identityOf(dir: string): string | undefined {
  try {
    const stats = statSync(dir);
    return stats.isDirectory() ? `${stats.dev}:${stats.ino}:${stats.birthtimeMs}` : undefined;
  } catch {
    return undefined;
  }
}
