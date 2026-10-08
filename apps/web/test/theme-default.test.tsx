// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serializeDeckBoot, type DeckBoot } from "@deck/contract";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  initialThemeMode,
  LEGACY_THEME_KEY,
  PRE_PAINT_MARKER,
  prePaintScript,
  THEME_CHOICE_KEY,
} from "../src/shell/theme-chain.js";

/**
 * The operator's default theme mode reaches the page through the boot object the server
 * writes into `index.html`. The pre-paint script and `useThemeMode` run one chain
 * (`theme-chain.ts`): the viewer's explicit choice, else an older shell's explicit light/dark,
 * else that default, else "system".
 */
const TEST_FILE_URL = import.meta.url;
const INDEX = readFileSync(fileURLToPath(new URL("../index.html", TEST_FILE_URL)), "utf8");

function boot(mode: DeckBoot["theme"]["mode"] | "bogus" | undefined): void {
  const element = document.createElement("script");
  element.type = "application/json";
  element.id = "deck-boot";
  element.textContent = mode === undefined ? "" : serializeDeckBoot({ bootApi: 1, brand: { title: "Lab" }, theme: { mode: mode as DeckBoot["theme"]["mode"] } });
  document.head.append(element);
}

function systemPrefersDark(dark: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

const isDark = () => document.documentElement.classList.contains("dark");

beforeEach(() => {
  localStorage.clear();
  document.head.replaceChildren();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("index.html", () => {
  it("carries an empty boot element ahead of the pre-paint marker the build replaces", () => {
    const element = INDEX.indexOf('<script type="application/json" id="deck-boot"></script>');
    expect(element).toBeGreaterThan(-1);
    expect(element).toBeLessThan(INDEX.indexOf(PRE_PAINT_MARKER));
  });
});

describe("initialThemeMode", () => {
  const storage = (items: Record<string, string>) => (key: string) => items[key] ?? null;
  const bootText = (mode: string) => JSON.stringify({ bootApi: 1, brand: { title: "Lab" }, theme: { mode } });

  it("names the exported keys (it is inlined by its source, so they are literals)", () => {
    const seen: string[] = [];
    initialThemeMode((key) => (seen.push(key), null), null);
    expect(seen).toEqual([THEME_CHOICE_KEY, LEGACY_THEME_KEY]);
  });

  it.each([
    ["the viewer's choice over everything", { [THEME_CHOICE_KEY]: "light", [LEGACY_THEME_KEY]: "dark" }, "dark", "light"],
    ["the viewer's system choice over the default", { [THEME_CHOICE_KEY]: "system" }, "dark", "system"],
    ["an older shell's explicit dark", { [LEGACY_THEME_KEY]: "dark" }, "light", "dark"],
    ["the operator's default over an older shell's stored system", { [LEGACY_THEME_KEY]: "system" }, "dark", "dark"],
    ["the operator's default with nothing stored", {}, "light", "light"],
    ["system for a malformed default", {}, "bogus", "system"],
  ])("gives %s", (_name, items, mode, expected) => {
    expect(initialThemeMode(storage(items), bootText(mode))).toBe(expected);
  });

  it("gives system with no boot object (the dev server) and survives blocked storage", () => {
    expect(initialThemeMode(storage({}), "")).toBe("system");
    expect(initialThemeMode(storage({}), null)).toBe("system");
    const blocked = () => {
      throw new Error("blocked");
    };
    expect(initialThemeMode(blocked, bootText("dark"))).toBe("dark");
  });
});

describe("the pre-paint script", () => {
  const prePaint = () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(prePaintScript())![1]!;
    new Function(script)();
  };

  it.each([
    ["the operator's dark default", undefined, "dark", false, true],
    ["the operator's light default over a dark system", undefined, "light", true, false],
    ["the operator's dark default over an older shell's stored system", { [LEGACY_THEME_KEY]: "system" }, "dark", false, true],
    ["the viewer's light choice over the dark default", { [THEME_CHOICE_KEY]: "light" }, "dark", true, false],
    ["system without a boot object (the dev server)", undefined, undefined, true, true],
  ] as const)("applies %s", (_name, stored, mode, systemDark, dark) => {
    for (const [key, value] of Object.entries(stored ?? {})) localStorage.setItem(key, value);
    boot(mode);
    systemPrefersDark(systemDark);
    prePaint();
    expect(isDark()).toBe(dark);
  });
});

describe("useThemeMode", () => {
  async function mode(): Promise<{ current: () => string; set: (next: "light" | "dark" | "system") => void }> {
    const { useThemeMode } = await import("../src/shell/use-theme.js");
    let state: ReturnType<typeof useThemeMode> | undefined;
    function Probe() {
      state = useThemeMode();
      return null;
    }
    render(<Probe />);
    return { current: () => state![0], set: (next) => act(() => state![1](next)) };
  }

  it("starts from the operator's default, also over an older shell's stored system, and stores nothing", async () => {
    localStorage.setItem(LEGACY_THEME_KEY, "system");
    boot("dark");
    systemPrefersDark(false);
    const theme = await mode();
    expect(theme.current()).toBe("dark");
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(THEME_CHOICE_KEY)).toBeNull();
  });

  it("stores the viewer's choice, which wins over the default from then on", async () => {
    boot("dark");
    systemPrefersDark(false);
    const theme = await mode();
    theme.set("light");
    expect(isDark()).toBe(false);
    expect(localStorage.getItem(THEME_CHOICE_KEY)).toBe("light");

    cleanup();
    vi.resetModules();
    expect((await mode()).current()).toBe("light");
  });
});
