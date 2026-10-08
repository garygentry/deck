import { useEffect, useSyncExternalStore } from "react";
import { BOOT_ELEMENT_ID } from "@deck/contract";
import { applyTheme } from "./theme.js";
import { initialThemeMode, THEME_CHOICE_KEY, type ThemeMode } from "./theme-chain.js";

/** User preference; "system" follows the OS via prefers-color-scheme. */
export type { ThemeMode } from "./theme-chain.js";

const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/** The start mode: the same chain the pre-paint script runs (see `theme-chain.ts`). */
function readStored(): ThemeMode {
  const bootText = typeof document === "undefined" ? null : document.getElementById(BOOT_ELEMENT_ID)?.textContent;
  return initialThemeMode((key) => localStorage.getItem(key), bootText);
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
    localStorage.setItem(THEME_CHOICE_KEY, next);
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
