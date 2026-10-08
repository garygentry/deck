// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readDeckBoot, serializeDeckBoot, type DeckBoot } from "@deck/contract";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The operator's default theme mode reaches the page through the boot object the server
 * writes into `index.html`: the pre-paint script and `useThemeMode` both apply the viewer's
 * stored choice first, then that default, then "system".
 */
const TEST_FILE_URL = import.meta.url;
const INDEX = readFileSync(fileURLToPath(new URL("../index.html", TEST_FILE_URL)), "utf8");
const PRE_PAINT = /<script>([\s\S]*?)<\/script>/.exec(INDEX)![1]!;

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
  document.head.innerHTML = "";
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("index.html", () => {
  it("carries an empty boot element ahead of the pre-paint script", () => {
    const element = INDEX.indexOf('<script type="application/json" id="deck-boot"></script>');
    expect(element).toBeGreaterThan(-1);
    expect(element).toBeLessThan(INDEX.indexOf(PRE_PAINT));
  });
});

describe("the pre-paint script", () => {
  const prePaint = () => new Function(PRE_PAINT)();

  it.each([
    ["the operator's dark default", undefined, "dark", false, true],
    ["the operator's light default over a dark system", undefined, "light", true, false],
    ["the viewer's stored light over the dark default", "light", "dark", false, false],
    ["the viewer's stored system over the dark default", "system", "dark", false, false],
    ["system without a boot object (the dev server)", undefined, undefined, true, true],
    ["system for a malformed default", undefined, "bogus", false, false],
  ] as const)("applies %s", (_name, stored, mode, systemDark, dark) => {
    if (stored !== undefined) localStorage.setItem("deck-theme", stored);
    boot(mode);
    systemPrefersDark(systemDark);
    prePaint();
    expect(isDark()).toBe(dark);
  });
});

describe("readDeckBoot", () => {
  it("reads the boot object leniently", () => {
    boot("dark");
    expect(readDeckBoot(document)).toEqual({ brand: { title: "Lab" }, theme: { mode: "dark" } });
    document.head.innerHTML = "";
    expect(readDeckBoot(document)).toEqual({ theme: {} });
    boot(undefined);
    expect(readDeckBoot(document)).toEqual({ theme: {} });
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

  it("starts from the operator's default and does not store it as the viewer's choice", async () => {
    boot("dark");
    systemPrefersDark(false);
    const theme = await mode();
    expect(theme.current()).toBe("dark");
    expect(isDark()).toBe(true);
    expect(localStorage.getItem("deck-theme")).toBeNull();
  });

  it("stores the viewer's choice, which wins over the default from then on", async () => {
    boot("dark");
    systemPrefersDark(false);
    const theme = await mode();
    theme.set("light");
    expect(isDark()).toBe(false);
    expect(localStorage.getItem("deck-theme")).toBe("light");

    cleanup();
    vi.resetModules();
    expect((await mode()).current()).toBe("light");
  });
});
