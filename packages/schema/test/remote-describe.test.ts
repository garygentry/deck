import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import deckSchema from "../schema/deck.schema.json" with { type: "json" };
import { CORE_WIDGET_TYPE_SCHEMAS } from "../src/core-widgets.js";
import { REMOTE_DESCRIBE_LIMITS, remoteDescribeSchema } from "../src/remote-describe.js";
import { createAjv } from "../src/validate/ajv.js";

type Schema = Record<string, any>;

const file = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/remote-describe.schema.json", import.meta.url)), "utf8")) as Schema;
const built = remoteDescribeSchema();
const defs = (deckSchema as Schema).$defs as Record<string, Schema>;
const check = createAjv().compile(file);

const minimal = { deck: 1, id: "ups", version: "1.0.0" };

describe("the remote describe schema", () => {
  it("is the committed file, byte for byte (run pnpm describe:build after changing it)", () => {
    expect(readFileSync(fileURLToPath(new URL("../schema/remote-describe.schema.json", import.meta.url)), "utf8")).toBe(
      `${JSON.stringify(built, null, 2)}\n`,
    );
  });

  it("compiles under deck's strict Ajv", () => {
    expect(() => createAjv().compile(built)).not.toThrow();
  });

  it("takes its widget from the config's UiWidget, without source and with a bounded required id", () => {
    const widget = file.$defs.RemoteWidget;
    const { source: _source, id: configId, ...configRest } = defs.UiWidget!.properties;
    const { id, ...rest } = widget.properties;
    expect(rest).toEqual(configRest);
    expect(id).toEqual({ ...configId, maxLength: REMOTE_DESCRIBE_LIMITS.name });
    expect(widget.required).toEqual(["id", "type"]);
    expect(widget.additionalProperties).toBe(false);
    expect(file.$defs.JsonValue).toEqual(defs.JsonValue);
  });

  it("takes its link from core/link-tiles and its nav entry from the config's href nav item", () => {
    const linkTiles = CORE_WIDGET_TYPE_SCHEMAS.find((entry) => entry.type === "core/link-tiles")!;
    const link = (linkTiles.optionsSchema.properties as Schema).links.items;
    expect(file.$defs.RemoteLink.properties.href).toEqual(link.properties.href);
    expect(file.$defs.RemoteLink.properties.title).toEqual(link.properties.title);
    const navHref = defs.UiNavItem!.oneOf[0].properties.href;
    expect(file.$defs.RemoteNavItem.properties.href).toEqual({ ...navHref, maxLength: REMOTE_DESCRIBE_LIMITS.href });
  });

  it("accepts a full document", () => {
    const document = {
      ...minimal,
      title: "UPS",
      columns: 2,
      widgets: [{ id: "load", type: "core/meter", title: "Load", select: "load", options: { max: 100, unit: "%" }, span: 1 }],
      links: [{ title: "NUT", href: "https://nut.example/", icon: "external-link" }],
      nav: [{ id: "nut", label: "NUT UI", href: "https://nut.example/" }],
    };
    expect(check(document), JSON.stringify(check.errors)).toBe(true);
    expect(check(minimal)).toBe(true);
  });

  it.each([
    ["a widget source", { widgets: [{ id: "w", type: "core/json", source: "other" }] }],
    ["a widget without an id", { widgets: [{ type: "core/json" }] }],
    ["a positional widget id", { widgets: [{ id: "s1w1", type: "core/json" }] }],
    ["an overlong widget id", { widgets: [{ id: "w".repeat(65), type: "core/json" }] }],
    ["an overlong title", { title: "t".repeat(81) }],
    ["an overlong version", { version: "1".repeat(65) }],
    ["a malformed id", { id: "UPS!" }],
    ["another protocol version", { deck: 2 }],
    ["a nav path href", { nav: [{ id: "n", label: "N", href: "/portal" }] }],
    ["a javascript: link", { links: [{ title: "x", href: "javascript:alert(1)" }] }],
    ["an overlong nav label", { nav: [{ id: "n", label: "l".repeat(81), href: "https://x.example/" }] }],
    ["an overlong icon", { links: [{ title: "x", href: "https://x.example/", icon: "a".repeat(65) }] }],
    ["too many widgets", { widgets: Array.from({ length: 25 }, (_, index) => ({ id: `w${index}`, type: "core/json" })) }],
    ["an unknown key", { script: "x" }],
  ])("refuses %s", (_label, patch) => {
    expect(check({ ...minimal, ...patch })).toBe(false);
  });
});
