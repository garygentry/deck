/**
 * The `ui` config section names pages and nav entries by extension id, so its id patterns
 * must accept exactly the ids the module SDK does (`EXTENSION_ID_PATTERN`), with the kind
 * fixed (and, for the ui config's own nav entries, the module fixed to the reserved `ui`). The two live in different packages; this pins them together.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EXTENSION_ID_PATTERN, UI_CONFIG_MODULE, UI_CONFIG_NAV_ID_PATTERN } from "@deck/module-sdk";
import { validate } from "@deck/schema";
import { describe, expect, it } from "vitest";

type Schema = Record<string, unknown>;

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../packages/schema/schema/deck.schema.json", import.meta.url)), "utf8"),
) as { $defs: Record<string, Schema> };

/** The SDK grammar with its kind (and optionally module) group fixed, as a JSON Schema pattern. */
function sdkPattern(kind: string, module?: string): string {
  const match = /^\^\((.+?)\):\((.+?)\)\\\/\((.+?)\)\$$/.exec(EXTENSION_ID_PATTERN.source);
  if (match === null) throw new Error(`unexpected EXTENSION_ID_PATTERN shape: ${EXTENSION_ID_PATTERN.source}`);
  return `^${kind}:${module ?? match[2]}/${match[3]}$`;
}

const props = (name: string) => schema.$defs[name]!.properties as Record<string, { pattern?: string }>;
const navItems = schema.$defs.UiNavItem!.oneOf as { properties: Record<string, { pattern?: string }> }[];

describe("ui id patterns follow the module SDK's extension id grammar", () => {
  it("pins ui.home to page ids and ui.nav.items ids to nav ids in the ui namespace", () => {
    expect(props("Ui").home?.pattern).toBe(sdkPattern("page"));
    const navId = sdkPattern("nav", UI_CONFIG_MODULE);
    expect(UI_CONFIG_NAV_ID_PATTERN.source).toBe(navId.replace("/", "\\/"));
    for (const variant of navItems) expect(variant.properties.id?.pattern).toBe(navId);
  });

  it.each([
    ["a dotted page name", "page:docs/runbook.v2", true],
    ["a digit-led page name", "page:inventory/2fa", true],
    ["a digit-led module", "page:2fa/overview", false],
    ["an upper-case module", "page:Docs/overview", false],
    ["another kind", "pill:drift/summary", false],
  ])("treats %s alike in config and the SDK", (_name, id, valid) => {
    expect(EXTENSION_ID_PATTERN.test(id) && id.startsWith("page:")).toBe(valid);
    const result = validate({ schemaVersion: 2, estate: { name: "e" }, ui: { home: id } });
    expect(result.classification === 0).toBe(valid);
  });
});
