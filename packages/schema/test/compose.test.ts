import { describe, expect, it } from "vitest";

import {
  BUILTIN_CONTRIBUTIONS,
  ComposeError,
  composeConfig,
  composeDefault,
  merge,
  validate,
  type ConfigContribution,
  type JsonObject,
} from "../src/index.js";

const estate = { schemaVersion: 2, estate: { name: "compose" } };
const codes = (result: ReturnType<typeof validate>) => result.findings.map((item) => item.code);

/** A small module section: a list of widgets keyed by id, with one rule and one code. */
const gadgets: ConfigContribution = {
  id: "gadgets",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      items: { type: "array", items: { $ref: "#/$defs/Gadget" } },
      owner: { type: "string" },
    },
    $defs: {
      Gadget: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" }, size: { type: "integer" }, link: { $ref: "#/$defs/Link" } },
      },
    },
  },
  ownership: { "": "overlay", owner: "base" },
  identity: { items: ["id"] },
  findings: [{ code: "GADGET_TOO_BIG", severity: "warning", summary: "A gadget is too big.", fix: "Shrink it." }],
  providerKinds: [
    {
      kind: "gadget-feed",
      instanceSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "title", "feed"],
        properties: { id: { type: "string" }, kind: { const: "gadget-feed" }, title: { type: "string" }, feed: { type: "string" } },
      },
    },
  ],
  rules: [
    (section: { items?: Array<{ size?: number }> }) =>
      (section.items ?? []).flatMap((item, index) =>
        (item.size ?? 0) > 10 ? [{ code: "GADGET_TOO_BIG", path: `/items/${index}/size`, message: "too big" }] : []),
  ],
};

const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, gadgets]);

describe("composeConfig", () => {
  it("composes a module section under modules.<id> and rejects an unknown module by id", () => {
    expect(validate({ ...estate, modules: { gadgets: { items: [{ id: "a" }] } } }, { composed }).classification).toBe(0);
    const unknown = validate({ ...estate, modules: { gizmos: {} } }, { composed });
    expect(unknown.findings).toEqual([
      expect.objectContaining({
        code: "MODULE_UNKNOWN",
        severity: "error",
        path: "/modules/gizmos",
        message: expect.stringContaining("gizmos"),
      }),
    ]);
    // Without the contribution, the same section is unknown.
    expect(codes(validate({ ...estate, modules: { gadgets: {} } }))).toEqual(["MODULE_UNKNOWN"]);
    // The section itself stays closed.
    expect(codes(validate({ ...estate, modules: { gadgets: { extra: 1 } } }, { composed }))).toEqual(["SCHEMA_UNKNOWN_PROPERTY"]);
  });

  it("hoists a section as one definition without shadowing kernel ones", () => {
    const defs = composed.schema.$defs as Record<string, any>;
    expect(defs.module__gadgets.$defs.Gadget).toBeDefined();
    expect(defs.Gadget).toBeUndefined();
    // `#/$defs/Link` is not defined by the section, so it still means the kernel Link.
    expect(codes(validate({ ...estate, modules: { gadgets: { items: [{ id: "a", link: { title: "t" } }] } } }, { composed })))
      .toEqual(["SCHEMA_REQUIRED_MISSING"]);
  });

  it("derives bindable kinds from the declared flag, and drops a disabled module's", () => {
    const feeds = { id: "feeds", providerKinds: [{ kind: "feed", bindable: true }, { kind: "tap" }] };
    const on = composeConfig([...BUILTIN_CONTRIBUTIONS, feeds]);
    expect(on.bindableKinds.has("feed")).toBe(true);
    expect(on.bindableKinds.has("tap")).toBe(false);
    expect(on.knownKinds.has("tap")).toBe(true);
    const off = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...feeds, disabled: "switched off" }]);
    expect(off.bindableKinds.has("feed")).toBe(false);
    expect(off.knownKinds.has("feed")).toBe(false);
  });

  it("derives known kinds from contributions and checks instances of a declared kind", () => {
    expect([...composed.knownKinds]).toEqual(["gadget-feed"]);
    const instance = { id: "feed", kind: "gadget-feed", title: "Feed", feed: "https://feed.invalid" };
    expect(validate({ ...estate, integrations: [instance] }, { composed }).classification).toBe(0);
    expect(codes(validate({ ...estate, integrations: [{ ...instance, feed: undefined, baseUrl: "x" }] }, { composed })))
      .toEqual(expect.arrayContaining(["SCHEMA_UNKNOWN_PROPERTY"]));
    // A kind nothing declares keeps the generic shape and stays a warning (parity with v1).
    const odd = { id: "odd", kind: "mystery", title: "Odd", baseUrl: "https://odd.invalid" };
    expect(validate({ ...estate, integrations: [odd] }, { composed }).findings)
      .toEqual([expect.objectContaining({ code: "PROVIDER_KIND_UNKNOWN", severity: "warning" })]);
    // Without the contribution, its kind is unknown too.
    expect(codes(validate({ ...estate, integrations: [{ ...odd, kind: "gadget-feed" }] }))).toEqual(["PROVIDER_KIND_UNKNOWN"]);
  });

  it("runs contributed rules on the section, with catalogued severity and an absolute path", () => {
    const result = validate({ ...estate, modules: { gadgets: { items: [{ id: "a", size: 11 }] } } }, { composed });
    expect(result.findings).toEqual([
      { code: "GADGET_TOO_BIG", severity: "warning", path: "/modules/gadgets/items/0/size", message: "too big" },
    ]);
    expect(composed.catalog.GADGET_TOO_BIG).toEqual({ severity: "warning", summary: "A gadget is too big.", fix: "Shrink it." });
    // An absent section runs no rule.
    expect(validate(estate, { composed }).findings).toEqual([]);
  });

  it("isolates a rule that throws or reports an undeclared code: info MODULE_RULE_FAILED, other findings kept (L8)", () => {
    const sloppy = composeConfig([
      ...BUILTIN_CONTRIBUTIONS,
      { id: "sloppy", schema: { type: "object" }, rules: [() => [{ code: "NOT_DECLARED", path: "", message: "x" }]] },
      { id: "thrower", schema: { type: "object" }, rules: [() => { throw new Error("boom"); }] },
    ]);
    const result = validate(
      { ...estate, hosts: [{ name: "h", kind: "vm", purpose: "p" }, { name: "h", kind: "vm", purpose: "p" }], modules: { sloppy: {}, thrower: {} } },
      { composed: sloppy },
    );
    expect(result.classification).toBe(1);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "HOST_DUPLICATE" }),
      { code: "MODULE_RULE_FAILED", severity: "info", path: "/modules/sloppy", message: expect.stringContaining("NOT_DECLARED") },
      { code: "MODULE_RULE_FAILED", severity: "info", path: "/modules/thrower", message: expect.stringContaining("boom") },
    ]));
    const alone = validate({ ...estate, modules: { thrower: {} } }, { composed: sloppy });
    expect(alone).toMatchObject({ classification: 0, findings: [{ code: "MODULE_RULE_FAILED" }] });
  });

  it("enforces module ownership rows per layer and merges module arrays by identity", () => {
    const base = { ...estate, modules: { gadgets: { owner: "ops" } } };
    expect(validate(base, { layer: "base", composed }).findings).toEqual([]);
    expect(codes(validate({ ...base, modules: { gadgets: { owner: "ops", items: [] } } }, { layer: "base", composed })))
      .toEqual(["LAYER_OVERLAY_KEY_IN_BASE"]);
    expect(codes(validate({ schemaVersion: 2, modules: { gadgets: { owner: "x" } } }, { layer: "overlay", base, composed })))
      .toEqual(["LAYER_BASE_KEY_IN_OVERLAY"]);

    const layered = { ...estate, modules: { gadgets: { items: [{ id: "a", size: 1 }, { id: "b" }] } } };
    const overlay = { schemaVersion: 2, modules: { gadgets: { items: [{ id: "b", size: 2 }, { id: "c" }] } } };
    const merged = merge(layered as JsonObject, overlay as JsonObject, composed) as { modules: { gadgets: { items: unknown[] } } };
    expect(merged.modules.gadgets.items).toEqual([{ id: "a", size: 1 }, { id: "b", size: 2 }, { id: "c" }]);
  });

  it("composes the built-in contributions by default, with no module sections", () => {
    expect(composeDefault().moduleIds).toEqual([]);
    expect(composeDefault()).toBe(composeDefault());
  });
});

describe("composeConfig collisions", () => {
  const conflict = (contributions: ConfigContribution[]) => {
    try {
      composeConfig(contributions);
    } catch (error) {
      expect(error).toBeInstanceOf(ComposeError);
      return { code: (error as ComposeError).code, message: (error as Error).message };
    }
    throw new Error("expected a ComposeError");
  };

  it("refuses two contributions with one module id", () => {
    expect(conflict([gadgets, { ...gadgets, providerKinds: [], findings: [] }]))
      .toEqual({ code: "MODULE_MANIFEST_CONFLICT", message: 'module "gadgets": duplicate module id' });
  });

  it("refuses a finding code declared twice, or one the kernel owns", () => {
    const twin = { id: "twin", findings: gadgets.findings };
    expect(conflict([gadgets, twin])).toMatchObject({ code: "MODULE_MANIFEST_CONFLICT", message: expect.stringContaining("GADGET_TOO_BIG") });
    const kernel = { id: "k", findings: [{ code: "HOST_DUPLICATE", severity: "error" as const, summary: "s", fix: "f" }] };
    expect(conflict([kernel])).toMatchObject({ code: "MODULE_MANIFEST_CONFLICT" });
    const host = { id: "h", findings: [{ code: "MODULE_DEPENDENCY_MISSING", severity: "error" as const, summary: "s", fix: "f" }] };
    expect(conflict([host])).toMatchObject({ code: "MODULE_MANIFEST_CONFLICT" });
  });

  it("refuses a provider kind declared twice", () => {
    const feeds = { id: "feeds", providerKinds: [{ kind: "feed" }] };
    expect(conflict([...BUILTIN_CONTRIBUTIONS, feeds, { id: "feeds-two", providerKinds: [{ kind: "feed" }] }]))
      .toMatchObject({ code: "MODULE_MANIFEST_CONFLICT", message: expect.stringContaining('"feed"') });
  });

  it("reports a malformed contribution as invalid rather than a conflict", () => {
    expect(conflict([{ id: "lower", findings: [{ code: "lower_case", severity: "info", summary: "s", fix: "f" }] }]))
      .toMatchObject({ code: "MODULE_MANIFEST_INVALID" });
    expect(conflict([{ id: "broken", schema: { type: "object", notAKeyword: true } }]))
      .toMatchObject({ code: "MODULE_MANIFEST_INVALID", message: expect.stringContaining("does not compile") });
  });
});

describe("composeConfig: review round 1 regressions", () => {
  it("rebases #, #/properties and #/definitions refs onto the section, so a recursive section works (C3, L5)", () => {
    const tree = composeConfig([{
      id: "tree",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "string" },
          child: { $ref: "#" },
          sibling: { $ref: "#/properties/value" },
          node: { $ref: "#/definitions/Node" },
          "a/b": { $ref: "#/$defs/Esc~1aped" },
        },
        definitions: { Node: { type: "object", additionalProperties: false, properties: { next: { $ref: "#/definitions/Node" } } } },
        $defs: { "Esc/aped": { type: "integer" } },
      },
    }]);
    const ok = { value: "a", child: { value: "b", child: { value: "c" } }, sibling: "s", node: { next: { next: {} } }, "a/b": 3 };
    expect(validate({ ...estate, modules: { tree: ok } }, { composed: tree })).toMatchObject({ classification: 0 });
    // The nested child is checked against the section, not the deck root.
    expect(validate({ ...estate, modules: { tree: { child: { estate: {} } } } }, { composed: tree }).findings)
      .toEqual([expect.objectContaining({ code: "SCHEMA_UNKNOWN_PROPERTY", path: "/modules/tree/child/estate" })]);
    expect(codes(validate({ ...estate, modules: { tree: { "a/b": "x" } } }, { composed: tree }))).toEqual(["SCHEMA_INVALID"]);
  });

  it("refuses a section schema with its own resource scope or an outside reference (C3, L5)", () => {
    for (const schema of <JsonObject[]>[
      { type: "object", $id: "urn:x" },
      { type: "object", properties: { a: { $id: "urn:nested", type: "string" } } },
      { type: "object", properties: { a: { $anchor: "here" } } },
      { type: "object", properties: { a: { $ref: "https://example.invalid/schema.json" } } },
    ]) {
      expect(() => composeConfig([{ id: "scoped", schema }])).toThrow(expect.objectContaining({ code: "MODULE_MANIFEST_INVALID" }));
    }
  });

  it("checks a declared kind's instances against the instance core too, without if-noise (L4)", () => {
    const remote = composeConfig([...BUILTIN_CONTRIBUTIONS, {
      id: "remote",
      providerKinds: [{ kind: "remote", instanceSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }],
    }]);
    // No id: the core still requires it; the finding is the missing id, not an `if` complaint.
    const result = validate({ ...estate, integrations: [{ kind: "remote", url: "http://sidecar" }] }, { composed: remote });
    expect(result.findings).toEqual([expect.objectContaining({ code: "SCHEMA_REQUIRED_MISSING", path: "/integrations/0/id" })]);
    expect(validate({ ...estate, integrations: [{ id: "r", kind: "remote", url: "http://sidecar" }] }, { composed: remote }).classification).toBe(0);
    expect(codes(validate({ ...estate, integrations: [{ id: "r", kind: "remote", url: 7 }] }, { composed: remote }))).toEqual(["SCHEMA_INVALID"]);
  });

  it("reports duplicate identity tuples in module arrays before a merge can collapse them (C2)", () => {
    const fixed = validate({ ...estate, modules: { gadgets: { items: [{ id: "a" }, { id: "b" }, { id: "a", size: 2 }] } } }, { composed });
    expect(fixed.findings).toEqual([
      { code: "ID_DUPLICATE", severity: "error", path: "/modules/gadgets/items/2", message: 'Id "a" is used more than once within items.' },
    ]);
    const tagged = composeConfig([{
      id: "links",
      schema: { type: "object", properties: { items: { type: "array", items: { type: "object" } } } },
      identity: { items: { link: ["href"], note: ["title", "page"] } },
    }]);
    const items = [
      { type: "link", href: "https://a.invalid" },
      { type: "note", title: "t", page: 1 },
      { type: "link", href: "https://a.invalid" },
      { type: "note", title: "t", page: 2 },
      { type: "note", title: "t", page: 1 },
    ];
    expect(validate({ ...estate, modules: { links: { items } } }, { composed: tagged }).findings.map(({ path, message }) => [path, message])).toEqual([
      ["/modules/links/items/2", 'A link with identity "https://a.invalid" is used more than once within items.'],
      ["/modules/links/items/4", 'A note with identity ("t", 1) is used more than once within items.'],
    ]);
  });

  it("lets an overlay leave out base-owned required fields of a module array, but not overlay-owned ones (C1)", () => {
    const owned = composeConfig([{
      id: "racks",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { items: { type: "array", items: { $ref: "#/$defs/Rack" } } },
        $defs: {
          Rack: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name", "label"],
            properties: { id: { type: "string" }, name: { type: "string" }, label: { type: "string" } },
          },
        },
      },
      ownership: { "": "container", items: "container", "items[].id": "base", "items[].name": "base", "items[].label": "overlay" },
      identity: { items: ["id"] },
    }]);
    const base = { ...estate, modules: { racks: { items: [{ id: "a", name: "Rack A", label: "x" }] } } };
    expect(validate({ schemaVersion: 2, modules: { racks: { items: [{ id: "a", label: "Shown" }] } } }, { layer: "overlay", base, composed: owned }))
      .toMatchObject({ classification: 0 });
    // The identity and overlay-owned fields stay required in the overlay.
    expect(codes(validate({ schemaVersion: 2, modules: { racks: { items: [{ label: "Shown" }] } } }, { layer: "overlay", base, composed: owned })))
      .toEqual(["SCHEMA_REQUIRED_MISSING"]);
    expect(codes(validate({ schemaVersion: 2, modules: { racks: { items: [{ id: "a" }] } } }, { layer: "overlay", base, composed: owned })))
      .toEqual(["SCHEMA_REQUIRED_MISSING"]);
    // The strict schema is unchanged.
    expect(codes(validate({ ...estate, modules: { racks: { items: [{ id: "a", label: "x" }] } } }, { composed: owned }))).toEqual(["SCHEMA_REQUIRED_MISSING"]);
  });

  it("accepts a disabled module's section unchecked, runs none of its rules, and reports it once (L6, L7)", () => {
    const off = composeConfig([...BUILTIN_CONTRIBUTIONS, { id: "gadgets", disabled: "not enabled: DECK_GADGETS is not true" }]);
    const document = { ...estate, modules: { gadgets: { items: "anything", size: 99 } } };
    expect(validate(document, { composed: off }).findings).toEqual([
      {
        code: "MODULE_SECTION_DISABLED",
        severity: "info",
        path: "/modules/gadgets",
        message: 'modules.gadgets is set, but module "gadgets" is not enabled (not enabled: DECK_GADGETS is not true); the section is ignored.',
      },
    ]);
    expect(validate({ schemaVersion: 2, modules: document.modules }, { composed: off, layer: "overlay" }).findings).toEqual([]);
    expect(off.knownKinds.has("gadget-feed")).toBe(false);
    expect(validate({ ...estate, modules: { nope: {} } }, { composed: off }).findings[0]!.message).toContain("gadgets");
  });
});

describe("composeConfig: review round 2 regressions", () => {
  it("checks a module's own identity rows for duplicates (N1)", () => {
    // A module's own identity rows are still checked.
    expect(codes(validate({ ...estate, modules: { gadgets: { items: [{ id: "a" }, { id: "a" }] } } }, { composed }))).toEqual(["ID_DUPLICATE"]);
  });

  const inventory: ConfigContribution = {
    id: "inv",
    schema: { type: "object", additionalProperties: false, required: ["n"], properties: { n: { type: "integer" } } },
    ownership: { "": "base" },
    findings: [{ code: "INV_TOO_BIG", severity: "error", summary: "s", fix: "f" }],
    rules: [(section: { n?: number }) => ((section.n ?? 0) > 10 ? [{ code: "INV_TOO_BIG", path: "/n", message: "n is too big" }] : [])],
  };

  it("exempts a disabled module's section from layer ownership checks (N2)", () => {
    const off = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...inventory, disabled: "not enabled: INV_ON is not true" }]);
    const base = { ...estate, modules: { inv: { n: 1 } } };
    expect(validate(base, { layer: "base", composed: off }).findings).toEqual([]);
    expect(validate({ schemaVersion: 2, modules: { inv: { n: 2 } } }, { layer: "overlay", base, composed: off }).findings).toEqual([]);
    // Enabled, the same base-owned section is checked as usual.
    const on = composeConfig([...BUILTIN_CONTRIBUTIONS, inventory]);
    expect(validate(base, { layer: "base", composed: on }).findings).toEqual([]);
    expect(codes(validate({ schemaVersion: 2, modules: { inv: { n: 2 } } }, { layer: "overlay", base, composed: on }))).toEqual(["LAYER_BASE_KEY_IN_OVERLAY"]);
  });

  it("still checks a disabled module's section, reporting what would fail at info (N4)", () => {
    const off = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...inventory, disabled: "not enabled: INV_ON is not true" }]);
    const shape = validate({ ...estate, modules: { inv: { n: "x", extra: true } } }, { composed: off });
    expect(shape.classification).toBe(0);
    expect(shape.findings).toEqual([
      expect.objectContaining({ code: "MODULE_SECTION_DISABLED", severity: "info", path: "/modules/inv", message: expect.stringContaining("the section is ignored") }),
      { code: "MODULE_SECTION_DISABLED", severity: "info", path: "/modules/inv/extra", message: 'would fail when "inv" is enabled: SCHEMA_UNKNOWN_PROPERTY Property extra is not allowed in the closed merged schema object.' },
      { code: "MODULE_SECTION_DISABLED", severity: "info", path: "/modules/inv/n", message: 'would fail when "inv" is enabled: SCHEMA_INVALID type: must be integer.' },
    ]);
    const rule = validate({ ...estate, modules: { inv: { n: 11 } } }, { composed: off });
    expect(rule).toMatchObject({ classification: 0 });
    expect(rule.findings).toContainEqual({ code: "MODULE_SECTION_DISABLED", severity: "info", path: "/modules/inv/n", message: 'would fail when "inv" is enabled: INV_TOO_BIG n is too big' });
    // A clean disabled section gets only the "ignored" note.
    expect(validate({ ...estate, modules: { inv: { n: 1 } } }, { composed: off }).findings).toHaveLength(1);
    // Its provider kinds stay unknown while it is off.
    const kinds = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...inventory, providerKinds: [{ kind: "inv-feed" }], disabled: "off" }]);
    expect(kinds.knownKinds.has("inv-feed")).toBe(false);
  });
});

describe("composeConfig: module host/service references", () => {
  /** Jobs that may each target a host, or a service on it. */
  const jobs: ConfigContribution = {
    id: "jobs",
    schema: {
      type: "object",
      properties: {
        jobs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              target: { type: "object", required: ["host"], properties: { host: { type: "string" }, service: { type: "string" } } },
            },
          },
        },
      },
    },
    references: ["jobs[].target"],
  };
  const inventory = {
    hosts: [{ name: "h", kind: "vm", purpose: "p" }],
    services: [{ host: "h", name: "s", kind: "systemd", purpose: "p" }],
  };
  const section = { jobs: [{ id: "a", target: { host: "h" } }, { id: "b", target: { host: "gone" } }, { id: "c", target: { host: "h", service: "s" } }, { id: "d", target: { host: "h", service: "gone" } }, { id: "e" }] };

  it("resolves each declared reference against the estate, like the kernel's own", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, jobs]);
    expect(composed.references).toEqual([{ path: "modules.jobs.jobs[].target", host: "host", service: "service", at: "field" }]);
    const result = validate({ ...estate, ...inventory, modules: { jobs: section } }, { composed });
    expect(result.findings.map(({ code, path, message }) => ({ code, path, message }))).toEqual([
      { code: "REF_HOST_UNRESOLVED", path: "/modules/jobs/jobs/1/target/host", message: "host reference at /modules/jobs/jobs/1/target/host does not resolve" },
      { code: "REF_SERVICE_UNRESOLVED", path: "/modules/jobs/jobs/3/target/service", message: "service reference at /modules/jobs/jobs/3/target/service does not resolve" },
    ]);
  });

  it("resolves an overlay's references against its base", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, jobs]);
    const base = { ...estate, ...inventory };
    const result = validate({ schemaVersion: 2, modules: { jobs: { jobs: [{ id: "a", target: { host: "h" } }, { id: "b", target: { host: "gone" } }] } } }, { layer: "overlay", base, composed });
    expect(result.findings.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "OVERLAY_DANGLING_REF", path: "/modules/jobs/jobs/1/target/host" },
    ]);
  });

  it("reports a switched-off module's unresolved references at info, as what enabling it would fail", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...jobs, disabled: "off" }]);
    expect(composed.references).toEqual([]);
    const result = validate({ ...estate, ...inventory, modules: { jobs: section } }, { composed });
    expect(result.classification).toBe(0);
    expect(result.findings.map(({ severity, path, message }) => ({ severity, path, message }))).toEqual([
      { severity: "info", path: "/modules/jobs", message: 'modules.jobs is set, but module "jobs" is not enabled (off); the section is ignored.' },
      { severity: "info", path: "/modules/jobs/jobs/1/target/host", message: 'would fail when "jobs" is enabled: REF_HOST_UNRESOLVED host reference at /modules/jobs/jobs/1/target/host does not resolve' },
      { severity: "info", path: "/modules/jobs/jobs/3/target/service", message: 'would fail when "jobs" is enabled: REF_SERVICE_UNRESOLVED service reference at /modules/jobs/jobs/3/target/service does not resolve' },
    ]);
  });

  it("refuses references that are not a list (a string would be read per character)", () => {
    expect(() => composeConfig([{ ...jobs, references: "jobs[].target" as unknown as string[] }])).toThrow(/references must be a list/);
  });

  it("checks a switched-off module's references at their real severity when validating strictly", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...jobs, disabled: "off" }]);
    const result = validate({ ...estate, ...inventory, modules: { jobs: section } }, { composed, disabledSections: "strict" });
    expect(result.classification).toBe(1);
    expect(result.findings.map(({ code, severity, path }) => ({ code, severity, path }))).toEqual([
      { code: "MODULE_SECTION_DISABLED", severity: "info", path: "/modules/jobs" },
      { code: "REF_HOST_UNRESOLVED", severity: "error", path: "/modules/jobs/jobs/1/target/host" },
      { code: "REF_SERVICE_UNRESOLVED", severity: "error", path: "/modules/jobs/jobs/3/target/service" },
    ]);
    // An overlay's dangling references are checked too, against its base.
    const overlay = validate({ schemaVersion: 2, modules: { jobs: { jobs: [{ id: "b", target: { host: "gone" } }] } } }, { layer: "overlay", base: { ...estate, ...inventory }, composed, disabledSections: "strict" });
    expect(overlay.findings.map(({ code }) => code)).toEqual(["OVERLAY_DANGLING_REF"]);
  });

  it.each(["", "jobs..target", "jobs[]x", "jobs.[]", "a.b[][]"])("refuses a malformed reference key path %j", (path) => {
    expect(() => composeConfig([{ ...jobs, references: [path] }])).toThrow(ComposeError);
  });
});

describe("composeConfig: reference declarations in object form", () => {
  const boards = {
    id: "boards",
    schema: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              host: { type: "string" },
              name: { type: "string" },
              href: { type: "string" },
              items: { type: "array", items: { type: "object", properties: { host: { type: "string" }, name: { type: "string" } } } },
            },
          },
        },
      },
    },
    references: [
      { path: "cards[]", service: "name", at: "element" as const },
      { path: "cards[].items[]", service: "name", at: "element" as const },
    ],
  };
  const inventory = {
    hosts: [{ name: "h", kind: "vm", purpose: "p" }],
    services: [{ host: "h", name: "s", kind: "systemd", purpose: "p" }],
  };
  const section = {
    cards: [
      { type: "service", host: "h", name: "s" },
      { type: "service", host: "h", name: "gone" },
      { type: "link", href: "https://example.test" },
      { type: "box", items: [{ host: "h", name: "s" }, { host: "h", name: "gone" }] },
      { type: "host", host: "nowhere" },
    ],
  };

  it("normalises both forms, with field names and where findings point", () => {
    const composed = composeConfig([{ ...boards, references: ["a[].target", { path: "b[]", host: "machine" }, ...boards.references] }]);
    expect(composed.references).toEqual([
      { path: "modules.boards.a[].target", host: "host", service: "service", at: "field" },
      { path: "modules.boards.b[]", host: "machine", service: "service", at: "field" },
      { path: "modules.boards.cards[]", host: "host", service: "name", at: "element" },
      { path: "modules.boards.cards[].items[]", host: "host", service: "name", at: "element" },
    ]);
  });

  it("resolves the named fields and reports at the element; values without a host are skipped", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, boards]);
    const result = validate({ ...estate, ...inventory, modules: { boards: section } }, { composed });
    expect(result.findings.map(({ code, path, message }) => ({ code, path, message }))).toEqual([
      { code: "REF_SERVICE_UNRESOLVED", path: "/modules/boards/cards/1", message: "service reference at /modules/boards/cards/1 does not resolve" },
      { code: "REF_SERVICE_UNRESOLVED", path: "/modules/boards/cards/3/items/1", message: "service reference at /modules/boards/cards/3/items/1 does not resolve" },
      { code: "REF_HOST_UNRESOLVED", path: "/modules/boards/cards/4", message: "host reference at /modules/boards/cards/4 does not resolve" },
    ]);
  });

  it("reports a renamed field at that field when findings point at fields", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...boards, references: [{ path: "cards[]", service: "name" }] }]);
    const result = validate({ ...estate, ...inventory, modules: { boards: section } }, { composed });
    expect(result.findings.map(({ path }) => path)).toEqual(["/modules/boards/cards/1/name", "/modules/boards/cards/4/host"]);
  });

  it("resolves an overlay's element references against its base", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, boards]);
    const result = validate({ schemaVersion: 2, modules: { boards: section } }, { layer: "overlay", base: { ...estate, ...inventory }, composed });
    expect(result.findings.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "OVERLAY_DANGLING_REF", path: "/modules/boards/cards/1" },
      { code: "OVERLAY_DANGLING_REF", path: "/modules/boards/cards/3/items/1" },
      { code: "OVERLAY_DANGLING_REF", path: "/modules/boards/cards/4" },
    ]);
  });

  it("reports a switched-off module's element references at info", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...boards, disabled: "off" }]);
    const result = validate({ ...estate, ...inventory, modules: { boards: section } }, { composed });
    expect(result.classification).toBe(0);
    expect(result.findings.map(({ severity, path }) => ({ severity, path }))).toEqual([
      { severity: "info", path: "/modules/boards" },
      { severity: "info", path: "/modules/boards/cards/1" },
      { severity: "info", path: "/modules/boards/cards/3/items/1" },
      { severity: "info", path: "/modules/boards/cards/4" },
    ]);
  });

  it.each([
    ["not a path or object", 3],
    ["no path", { service: "name" }],
    ["a malformed path", { path: "cards..x" }],
    ["an unknown field", { path: "cards[]", pointer: "element" }],
    ["an empty field name", { path: "cards[]", service: "" }],
    ["a non-string field name", { path: "cards[]", host: 1 }],
    ["host and service naming one field", { path: "cards[]", host: "name", service: "name" }],
    ["an unknown at", { path: "cards[]", at: "value" }],
  ])("refuses a reference with %s (MODULE_MANIFEST_INVALID)", (_label, reference) => {
    const attempt = () => composeConfig([{ ...boards, references: [reference as never] }]);
    expect(attempt).toThrow(ComposeError);
    try {
      attempt();
    } catch (error) {
      expect((error as ComposeError).code).toBe("MODULE_MANIFEST_INVALID");
    }
  });
});

describe("composeConfig: id namespaces (unique)", () => {
  const tree = {
    id: "tree",
    schema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string" },
              href: { type: "string" },
              children: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, href: { type: "string" } } } },
            },
          },
        },
      },
    },
    identity: { nodes: ["id"], "nodes[].children": { node: ["id"], link: ["href"] } },
    unique: [{ paths: ["nodes[]", "nodes[].children[]"], key: ["id"], message: "Node id {key} is used more than once across the tree." }],
  };
  const document = (nodes: unknown[]) => ({ ...estate, modules: { tree: { nodes } } });
  const duplicates = (result: ReturnType<typeof validate>) =>
    result.findings.filter(({ code }) => code === "ID_DUPLICATE").map(({ path, message }) => ({ path, message }));

  it("checks one namespace across arrays, reporting later occurrences in document order", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, tree]);
    // `x` appears as a child of node 0 before node 1 declares it; node 1 is the repeat.
    const result = validate(document([
      { id: "a", children: [{ type: "node", id: "x" }] },
      { id: "x", children: [] },
      { id: "a", children: [{ type: "node", id: "x" }] },
    ]), { composed });
    expect(duplicates(result)).toEqual([
      { path: "/modules/tree/nodes/1", message: 'Node id "x" is used more than once across the tree.' },
      { path: "/modules/tree/nodes/2", message: 'Node id "a" is used more than once across the tree.' },
      { path: "/modules/tree/nodes/2/children/0", message: 'Node id "x" is used more than once across the tree.' },
    ]);
  });

  it("orders array indexes numerically, not as text", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, tree]);
    const nodes = Array.from({ length: 11 }, (_, index) => ({ id: index === 10 ? "n2" : `n${index}` }));
    expect(duplicates(validate(document(nodes), { composed })).map(({ path }) => path)).toEqual(["/modules/tree/nodes/10"]);
  });

  it("leaves identity rows to the merge when a namespace is declared, so repeated items stay accepted", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, tree]);
    const result = validate(document([{ id: "a", children: [{ type: "link", href: "h" }, { type: "link", href: "h" }] }]), { composed });
    expect(duplicates(result)).toEqual([]);
    // Without `unique`, the identity rows are checked themselves.
    const { unique: _unique, ...unchecked } = tree;
    const strict = validate(document([{ id: "a", children: [{ type: "link", href: "h" }, { type: "link", href: "h" }] }]), {
      composed: composeConfig([...BUILTIN_CONTRIBUTIONS, unchecked]),
    });
    expect(duplicates(strict).map(({ path }) => path)).toEqual(["/modules/tree/nodes/0/children/1"]);
  });

  it("uses a generic message and shows a compound key as a tuple", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...tree, unique: [{ paths: ["nodes[]"], key: ["id", "type"] }] }]);
    const result = validate(document([{ id: "a", type: "t" }, { id: "a", type: "u" }, { id: "a", type: "t" }, { type: "t" }]), { composed });
    expect(duplicates(result)).toEqual([{ path: "/modules/tree/nodes/2", message: 'Id ("a", "t") is used more than once.' }]);
  });

  it("reports a switched-off module's duplicates at info", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...tree, disabled: "off" }]);
    const result = validate(document([{ id: "a" }, { id: "a" }]), { composed });
    expect(result.classification).toBe(0);
    expect(result.findings.map(({ severity, path, message }) => ({ severity, path, message }))).toEqual([
      { severity: "info", path: "/modules/tree", message: 'modules.tree is set, but module "tree" is not enabled (off); the section is ignored.' },
      { severity: "info", path: "/modules/tree/nodes/1", message: 'would fail when "tree" is enabled: ID_DUPLICATE Node id "a" is used more than once across the tree.' },
    ]);
  });

  it.each([
    ["not a list", { paths: ["nodes[]"], key: ["id"] }],
    ["an entry that is not an object", ["nodes[]"]],
    ["no paths", [{ paths: [], key: ["id"] }]],
    ["a path not ending in []", [{ paths: ["nodes"], key: ["id"] }]],
    ["a malformed path", [{ paths: ["nodes..x[]"], key: ["id"] }]],
    ["a path listed twice", [{ paths: ["nodes[]", "nodes[]"], key: ["id"] }]],
    ["no key", [{ paths: ["nodes[]"], key: [] }]],
    ["a non-string key field", [{ paths: ["nodes[]"], key: [1] }]],
    ["an empty message", [{ paths: ["nodes[]"], key: ["id"], message: "" }]],
    ["an unknown field", [{ paths: ["nodes[]"], key: ["id"], scope: "tree" }]],
    ["an empty list, which would only switch identity checks off", []],
  ])("refuses unique with %s (MODULE_MANIFEST_INVALID)", (_label, unique) => {
    const attempt = () => composeConfig([{ ...tree, unique: unique as never }]);
    expect(attempt).toThrow(ComposeError);
    try {
      attempt();
    } catch (error) {
      expect((error as ComposeError).code).toBe("MODULE_MANIFEST_INVALID");
    }
  });
});

describe("composeConfig: review round 1 (namespaces and references)", () => {
  const sample = (extra: Record<string, unknown>) => ({
    id: "sample",
    schema: {
      type: "object",
      properties: {
        jobs: { type: "array", items: { type: "object" } },
        boards: { type: "array", items: { type: "object" } },
        rows: { type: "array", items: { type: "object" } },
      },
    },
    ...extra,
  });
  const dupes = (result: ReturnType<typeof validate>) =>
    result.findings.filter(({ code }) => code === "ID_DUPLICATE").map(({ severity, path, message }) => ({ severity, path, message }));

  it("checks every identity row a namespace does not cover (L3)", () => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, sample({
      identity: { jobs: ["id"], boards: ["slug"] },
      unique: [{ paths: ["jobs[]"], key: ["id"] }],
    })]);
    const result = validate({ ...estate, modules: { sample: { jobs: [{ id: "a" }, { id: "b" }], boards: [{ slug: "x" }, { slug: "x" }] } } }, { composed });
    expect(dupes(result)).toEqual([{ severity: "error", path: "/modules/sample/boards/1", message: 'Id "x" is used more than once within boards.' }]);
  });

  it.each(["$&", "$'", "$`", "$$", "a$'b", "$1"])("puts the id %j into the message literally (C2/L2)", (id) => {
    const composed = composeConfig([...BUILTIN_CONTRIBUTIONS, sample({ unique: [{ paths: ["jobs[]"], key: ["id"], message: "Job id {key} is repeated; {key} again." }] })]);
    const result = validate({ ...estate, modules: { sample: { jobs: [{ id }, { id }] } } }, { composed });
    const shown = JSON.stringify(id);
    expect(dupes(result)).toEqual([{ severity: "error", path: "/modules/sample/jobs/1", message: `Job id ${shown} is repeated; ${shown} again.` }]);
  });

  it.each(["constructor", "toString", "hasOwnProperty"])("skips elements without an own %j key (C3/L4)", (field) => {
    const unique = composeConfig([...BUILTIN_CONTRIBUTIONS, sample({ unique: [{ paths: ["rows[]"], key: [field] }] })]);
    expect(validate({ ...estate, modules: { sample: { rows: [{}, {}] } } }, { composed: unique })).toMatchObject({ classification: 0, findings: [] });
    const identity = composeConfig([...BUILTIN_CONTRIBUTIONS, sample({ identity: { rows: [field] } })]);
    expect(validate({ ...estate, modules: { sample: { rows: [{}, {}] } } }, { composed: identity })).toMatchObject({ classification: 0, findings: [] });
    // Explicit own values are still compared.
    const own = validate({ ...estate, modules: { sample: { rows: [{ [field]: "v" }, { [field]: "v" }] } } }, { composed: unique });
    expect(dupes(own).map(({ path }) => path)).toEqual(["/modules/sample/rows/1"]);
  });

  describe("strict validation of a disabled section checks duplicates in each authored layer (C1)", () => {
    const base = { ...estate };
    const first = { schemaVersion: 2, modules: { sample: { jobs: [{ id: "x" }] } } };
    const second = { schemaVersion: 2, modules: { sample: { jobs: [{ id: "x" }, { id: "x" }] } } };
    const declarations = {
      namespace: { identity: { jobs: ["id"] }, unique: [{ paths: ["jobs[]"], key: ["id"] }] },
      "identity row": { identity: { jobs: ["id"] } },
    };

    it.each(Object.entries(declarations))("%s: the same error and pointer with the module on and off", (_label, declaration) => {
      const on = composeConfig([...BUILTIN_CONTRIBUTIONS, sample(declaration)]);
      const off = composeConfig([...BUILTIN_CONTRIBUTIONS, { ...sample(declaration), disabled: "off" }]);
      const layers = (composed: typeof on, disabledSections: "strict" | "advisory") => {
        const merged1 = merge(base as JsonObject, first as JsonObject, composed);
        return [
          validate(first, { layer: "overlay", base, composed, disabledSections }),
          validate(second, { layer: "overlay", base: merged1, composed, disabledSections }),
          validate(merge(merged1, second as JsonObject, composed), { composed, disabledSections }),
        ].flatMap(dupes);
      };
      const expected = { severity: "error", path: "/modules/sample/jobs/1", message: expect.stringContaining('"x"') };
      expect(layers(on, "strict")).toContainEqual(expected);
      expect(layers(off, "strict")).toContainEqual(expected);
      // Advisory validation (what boot uses) never fails on a switched-off module.
      expect(layers(off, "advisory").filter(({ severity }) => severity === "error")).toEqual([]);
    });
  });
});
