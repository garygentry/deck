import { useEffect, useSyncExternalStore } from "react";
import { readDeckBoot } from "@deck/contract";
import { applyTheme } from "./theme.js";

/** User preference; "system" follows the OS via prefers-color-scheme. */
export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "deck-theme";
const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/**
 * The viewer's stored preference, else the operator's default the server wrote into the page
 * (`ui.theme.mode`), else "system". `index.html` runs the same logic before first paint.
 */
function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Private mode / blocked storage — fall back to the default.
  }
  return (typeof document === "undefined" ? undefined : readDeckBoot(document).theme.mode) ?? "system";
}

function prefersDark(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Resolve a preference to the concrete palette applyTheme() understands. */
function resolve(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return prefersDark() ? "dark" : "light";
  return mode;
}

// One preference shared by every consumer (the shell toggle, the /_ui
// workbench toggle), so two toggles on a page never disagree.
let current: ThemeMode | undefined;
const listeners = new Set<() => void>();

function getMode(): ThemeMode {
  return (current ??= readStored());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The viewer's choice: it is stored, so it wins over the operator's default from now on. */
function setThemeMode(next: ThemeMode): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Non-fatal; the theme still applies for this session.
  }
  for (const listener of listeners) listener();
}

/**
 * Own the applied theme: apply the resolved palette to <html>, and — while on
 * "system" — track OS changes live. Only a choice made through the setter is
 * stored; until then the operator's default keeps applying.
 */
export function useThemeMode(): [ThemeMode, (next: ThemeMode) => void] {
  const mode = useSyncExternalStore(subscribe, getMode, getMode);

  useEffect(() => {
    applyTheme(document.documentElement, resolve(mode));
    if (mode !== "system" || typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void =>
      applyTheme(document.documentElement, media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  return [mode, setThemeMode];
}

/** The next preference in the system → light → dark cycle. */
export function nextMode(mode: ThemeMode): ThemeMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
}
