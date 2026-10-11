// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_ICON, Icon, ICONS, isIconName } from "@/ui";

import { REPO_ROOT, sourceRel, webSourceFiles } from "./support/source-roots.js";

afterEach(cleanup);

// Resolve from the web package root. (Not `new URL(\`…${path}\`, import.meta.url)`:
// Vite rewrites that pattern into an asset glob.)
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = (path: string): string => resolve(webRoot, path);

function* files(dir: string, pattern: RegExp): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path, pattern);
    else if (pattern.test(entry)) yield path;
  }
}

/**
 * Every icon token the web's sources (the app's own and each module's web half) hand to the icon
 * system: `icon: "…"` fields, literal `data-icon="…"` attributes, and the values of `*_ICON`
 * maps, each with the file it first appears in. The vendored `src/ui` library is excluded (it
 * imports Lucide components directly).
 */
function sourceIconTokens(repo: string = REPO_ROOT): Map<string, string> {
  const tokens = new Map<string, string>();
  const add = (token: string, file: string): void => {
    if (!tokens.has(token)) tokens.set(token, file);
  };
  for (const path of webSourceFiles(repo)) {
    const file = sourceRel(path, repo);
    if (!/\.tsx?$/.test(file) || file.startsWith("src/ui/")) continue;
    const text = readFileSync(path, "utf8");
    for (const [, token] of text.matchAll(/\bicon:\s*"([^"]+)"/g)) add(token!, file);
    for (const [, token] of text.matchAll(/data-icon="([^"]+)"/g)) add(token!, file);
    for (const [, body] of text.matchAll(/\bconst \w+_ICON\b[^={]*=\s*(?:Object\.freeze\()?\{([^}]*)\}/g)) {
      for (const [, token] of body!.matchAll(/:\s*"([^"]+)"/g)) add(token!, file);
    }
  }
  return tokens;
}

/** `icon:` values in the example estate config (YAML). */
function estateIconTokens(): string[] {
  const tokens: string[] = [];
  for (const file of files(root("../../examples/estate"), /\.ya?ml$/)) {
    for (const [, token] of readFileSync(file, "utf8").matchAll(/^\s*icon:\s*["']?([^"'\s#]+)/gm)) {
      tokens.push(token!);
    }
  }
  return tokens;
}

describe("icon registry", () => {
  it("maps every IconName to a Lucide component", () => {
    for (const [name, component] of Object.entries(ICONS)) {
      expect(component, name).toBeTruthy();
      expect(isIconName(name)).toBe(true);
    }
  });

  it("covers every icon token the feature source uses", () => {
    const tokens = sourceIconTokens();
    // Guard against the scan silently finding nothing.
    expect(tokens.size).toBeGreaterThan(30);
    const unknown = [...tokens].filter(([token]) => !isIconName(token));
    expect(unknown).toEqual([]);
    // The scan reads the built-in modules' web halves too (llm-usage's status icons).
    expect(webSourceFiles().map((path) => sourceRel(path))).toContain("modules/llm-usage/web/status.ts");
  });

  it("would refuse an unknown icon token in a module's web half", () => {
    const repo = mkdtempSync(join(tmpdir(), "ui-icons-"));
    try {
      const probe = join(repo, "modules/llm-usage/web/Probe.tsx");
      mkdirSync(dirname(probe), { recursive: true });
      writeFileSync(probe, 'export const PAGE = { icon: "no-such-icon" };\n');
      const unknown = [...sourceIconTokens(repo)].filter(([token]) => !isIconName(token));
      expect(unknown).toEqual([["no-such-icon", "modules/llm-usage/web/Probe.tsx"]]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("covers every icon token in the example estate", () => {
    const unknown = estateIconTokens().filter((token) => !isIconName(token));
    expect(unknown).toEqual([]);
  });

  it("does not treat inherited object keys as icon names", () => {
    expect(isIconName("toString")).toBe(false);
    expect(isIconName("constructor")).toBe(false);
  });
});

describe("<Icon>", () => {
  it("renders the mapped icon as a decorative, unfocusable svg", () => {
    const { container } = render(<Icon name="check-circle" className="text-status-ok-fg" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("width", "16");
    expect(svg).toHaveClass("lucide-circle-check", "text-status-ok-fg");
  });

  it("renders the aliases of one icon identically", () => {
    const a = render(<Icon name="check-circle" />).container.innerHTML;
    cleanup();
    const b = render(<Icon name="circle-check" />).container.innerHTML;
    expect(a).toBe(b);
  });

  it("falls back to a neutral icon and warns once for an unknown token", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <>
        <Icon name="lantern" />
        <Icon name="lantern" />
      </>,
    );
    const fallback = render(<FALLBACK_ICON />).container.querySelector("svg")!;
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    expect(svgs[0]!.getAttribute("class")).toBe(fallback.getAttribute("class"));
    expect(svgs[0]).toHaveAttribute("aria-hidden", "true");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('"lantern"');
    warn.mockRestore();
  });
});
