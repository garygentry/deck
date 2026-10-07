// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
// Vite rewrites the literal `new URL("…", import.meta.url)` form into a served-asset
// URL under the jsdom (web) transform; resolving against a plain const avoids that.
const TEST_FILE_URL = import.meta.url;
import { cleanup, render, screen, within } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryData } from "../src/features/hosts-and-services/use-inventory-data.js";
import {
  availableState,
  config,
  FIXED_AT,
  hostDecl,
  hostState,
  makeData,
  NOT_CONFIGURED,
  observedHost,
  observedService,
  pendingState,
  requestErrorState,
  serviceDecl,
  snapshotResult,
} from "./inventory-harness.js";

// The mocked context lets tests drive the pages without polling. The partial mock
// preserves the entire compatibility-module export surface via `...actual` and
// overrides only the provider/context seam: `InventoryDataProvider` is a
// passthrough and the context read is stubbed, so the real store never runs.
let inventoryData: InventoryData;
vi.mock("../src/features/hosts-and-services/use-inventory-data.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/features/hosts-and-services/use-inventory-data.js")>();
  return {
    ...actual,
    InventoryDataProvider: ({ children }: { children: unknown }) => children,
    useInventoryDataContext: () => inventoryData,
  };
});

// The mocked router lets detail tests drive the decoded route params directly.
let routeParams: Record<string, string> = {};
vi.mock("@/shell/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shell/router")>();
  return {
    ...actual,
    useRoute: () => ({ path: "", query: {}, params: routeParams }),
  };
});

// Importing the feature entrypoint is the discovery action under test.
import "../src/features/hosts-and-services/index.js";
import { EntitySections } from "../src/features/hosts-and-services/components/EntitySections.js";
import {
  formatFactValue,
  IntentReality,
} from "../src/features/hosts-and-services/components/detail-shared.js";
import { HostDetailPage } from "../src/features/hosts-and-services/hosts/detail.js";
import { ServiceDetailPage } from "../src/features/hosts-and-services/services/detail.js";
import * as registry from "../src/registry/registry.js";
import { getPages, registerEntityFragment } from "../src/registry/registry.js";
import type { EntityRef } from "../src/registry/registry.js";
import { getQueryClient } from "../src/data/query-client.js";
import { queryKeys } from "../src/data/queries.js";
import { resolveComponent } from "./support/lazy.js";
import { manifestPlacing } from "./support/manifest.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A named `section[aria-labelledby]` (role region) by its heading text. */
function region(name: string | RegExp): HTMLElement {
  return screen.getByRole("region", { name });
}

/** The text of every `h2` in document order. */
function sectionHeadings(): string[] {
  return screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent ?? "");
}

/** The body row of a table whose row header is `name`. */
function rowOf(table: HTMLElement, name: string): HTMLElement {
  const header = within(table)
    .getAllByRole("rowheader")
    .find((cell) => cell.textContent?.startsWith(name));
  if (header === undefined) throw new Error(`No row for ${name}`);
  return header.closest("tr")!;
}

/** The text of each cell of a table row. */
function cells(row: HTMLElement): string[] {
  return [...row.querySelectorAll("th, td")].map((cell) => cell.textContent ?? "");
}

/** The declared/observed side card of an intent-beside-reality section. */
function side(section: HTMLElement, which: "Declared intent" | "Observed reality"): HTMLElement {
  const heading = within(section).getByRole("heading", { level: 3, name: which });
  return heading.closest("[data-slot=card]") as HTMLElement;
}

/** The description-list value for `label` within a container. */
function valueOf(container: HTMLElement, label: string): string {
  const term = within(container)
    .getAllByRole("term")
    .find((dt) => dt.textContent === label);
  if (term === undefined) throw new Error(`No field ${label}`);
  return term.nextElementSibling?.textContent ?? "";
}

// ---------------------------------------------------------------------------
// Intent/reality section.
// ---------------------------------------------------------------------------

describe("IntentReality section", () => {
  it("returns null only when both sides are absent", () => {
    const { container } = render(<IntentReality label="Access" intent={null} reality={null} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();

    render(<IntentReality label="Access" intent={<span>method ssh</span>} reality={null} />);
    expect(region("Access")).toBeInTheDocument();
  });

  it("names the section by a stable heading id with intent before reality", () => {
    render(
      <IntentReality
        label="Addresses"
        intent={<span>declared-content</span>}
        reality={<span>observed-content</span>}
      />,
    );
    const section = region("Addresses");
    expect(within(section).getByRole("heading", { level: 2 })).toHaveAttribute(
      "id",
      "intent-reality-addresses",
    );
    const sides = within(section)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(sides).toEqual(["Declared intent", "Observed reality"]);
    expect(within(side(section, "Declared intent")).getByText("declared-content")).toBeInTheDocument();
    expect(within(side(section, "Observed reality")).getByText("observed-content")).toBeInTheDocument();
  });

  it("labels a null intent Not declared and a null reality Not observed", () => {
    render(<IntentReality label="Backup" intent={null} reality={<span>observed</span>} />);
    expect(within(side(region("Backup"), "Declared intent")).getByText("Not declared")).toBeInTheDocument();
    cleanup();

    render(<IntentReality label="Backup" intent={<span>declared</span>} reality={null} />);
    const observed = within(side(region("Backup"), "Observed reality")).getByText("Not observed");
    expect(observed).toHaveAttribute("data-marker", "not-observed");
  });

  it("renders hostile content as text, never as markup", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <IntentReality label="Identity" intent={<span>{hostile}</span>} reality={null} />,
    );
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("derives entity-free ids even from a hostile label", () => {
    const { container } = render(
      <IntentReality label={"<script>evil</script>"} intent={<span>x</span>} reality={null} />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveAttribute(
      "id",
      "intent-reality-script-evil-script",
    );
    expect(container.querySelector("script")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatFactValue.
// ---------------------------------------------------------------------------

describe("formatFactValue", () => {
  it("deterministically renders supported JSON values", () => {
    expect(formatFactValue("plain")).toBe('"plain"');
    expect(formatFactValue(42)).toBe("42");
    expect(formatFactValue(true)).toBe("true");
    expect(formatFactValue(null)).toBe("null");
    expect(formatFactValue({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}');
    expect(formatFactValue([1, "two"])).toBe('[\n  1,\n  "two"\n]');
  });

  it("returns safe fallback text for unsupported and cyclic values", () => {
    // JSON.stringify(undefined) is undefined → the unsupported-value fallback.
    expect(formatFactValue(undefined)).toBe("Unsupported value");
    expect(formatFactValue(() => 0)).toBe("Unsupported value");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatFactValue(cyclic)).toBe("Unable to display value");
  });

  it("stringifies markup-like text without executing it", () => {
    const value = formatFactValue({ note: '<img src=x onerror="alert(1)">' });
    const { container } = render(<pre>{value}</pre>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });
});

// ---------------------------------------------------------------------------
// EntitySections — ordered section hosts, states, and isolation.
// ---------------------------------------------------------------------------

/** Record every entity reference a synthetic fragment receives. */
const fragmentRefs: Record<string, EntityRef[]> = {};
function recordRef(id: string, entity: EntityRef): void {
  (fragmentRefs[id] ??= []).push(entity);
}

const HostFindA = ({ entity }: { entity: EntityRef }): JSX.Element => {
  recordRef("host-find-a", entity);
  return <span>HOST-FIND-A</span>;
};
const HostFindB = ({ entity }: { entity: EntityRef }): JSX.Element => {
  recordRef("host-find-b", entity);
  return <span>HOST-FIND-B</span>;
};
const HostConf = ({ entity }: { entity: EntityRef }): JSX.Element => {
  recordRef("host-conf", entity);
  return <span>HOST-CONF</span>;
};
const SvcOk = (_props: { entity: EntityRef }): JSX.Element => <span>SVC-OK</span>;
const SvcFail = (_props: { entity: EntityRef }): JSX.Element => {
  throw new Error("svc-fail internal exception must never reach the UI");
};
const SvcCond = ({ entity }: { entity: EntityRef }): JSX.Element => {
  if (entity.host === "boom") throw new Error("cond internal exception must never reach the UI");
  return <span>SVC-COND-OK</span>;
};

beforeAll(() => {
  registerEntityFragment({ id: "section:test/host-find-b", entity: "host", section: "findings", title: "Findings", order: 20, component: HostFindB });
  registerEntityFragment({ id: "section:test/host-find-a", entity: "host", section: "findings", title: "Findings", order: 10, component: HostFindA });
  registerEntityFragment({ id: "section:test/host-conf", entity: "host", section: "configs", title: "Configs", order: 30, component: HostConf });
  registerEntityFragment({ id: "section:test/svc-ok", entity: "service", section: "findings", title: "Findings", order: 10, component: SvcOk });
  registerEntityFragment({ id: "section:test/svc-fail", entity: "service", section: "findings", title: "Findings", order: 20, component: SvcFail });
  registerEntityFragment({ id: "section:test/svc-cond", entity: "service", section: "configs", title: "Configs", order: 30, component: SvcCond });
});

// The UI manifest places every registered section (every module is on).
beforeEach(() => {
  getQueryClient().setQueryData(queryKeys.uiManifest, manifestPlacing(registry.getAllExtensions()));
});

/** Fragment render failures are expected in these tests; keep React's report quiet. */
function quietErrors(): () => void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mockRestore();
}

/** The two slot regions, in document order. */
function slotRegions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-entity-slot]")];
}

describe("EntitySections ordering and states", () => {
  it("renders each attached section by its own title, with a section marker, in order", () => {
    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    expect(slotRegions().map((slot) => slot.dataset.entitySlot)).toEqual(["findings", "configs"]);
    expect(sectionHeadings()).toEqual(["Findings", "Configs"]);
    expect(region("Findings")).toHaveAttribute("data-entity-slot", "findings");
    expect(region("Configs")).toHaveAttribute("data-entity-slot", "configs");
    expect(within(region("Findings")).getByRole("heading")).toHaveAttribute("id", "entity-slot-findings");
  });

  it("orders fragments within a section through the existing (order,id) accessor", () => {
    render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
    const findings = region("Findings").textContent ?? "";
    // Registered b(20) before a(10), but the accessor sorts a before b.
    expect(findings.indexOf("HOST-FIND-A")).toBeLessThan(findings.indexOf("HOST-FIND-B"));
    expect(within(region("Configs")).getByText("HOST-CONF")).toBeInTheDocument();
  });

  it("passes one exact frozen EntityRef, unchanged, to every fragment", () => {
    fragmentRefs["host-find-a"] = [];
    fragmentRefs["host-find-b"] = [];
    fragmentRefs["host-conf"] = [];
    const entity: EntityRef = Object.freeze({ entity: "host", host: "alpha" });
    render(<EntitySections entity={entity} />);
    expect(fragmentRefs["host-find-a"]![0]).toBe(entity);
    expect(fragmentRefs["host-find-b"]![0]).toBe(entity);
    expect(fragmentRefs["host-conf"]![0]).toBe(entity);
    expect(Object.isFrozen(fragmentRefs["host-conf"]![0])).toBe(true);
  });

  it("renders no sections, and no drift, when nothing is attached", () => {
    const spy = vi.spyOn(registry, "groupEntitySections").mockReturnValue([]);
    try {
      const { container } = render(<EntitySections entity={Object.freeze({ entity: "host", host: "empty" })} />);
      expect(container).toBeEmptyDOMElement();
      expect(document.body.textContent?.toLowerCase()).not.toContain("drift");
    } finally {
      spy.mockRestore();
    }
  });

  it("shows one alert for a registry-read failure without exposing exception text", () => {
    const spy = vi.spyOn(registry, "groupEntitySections").mockImplementation(() => {
      throw new Error("registry read boom secret detail");
    });
    try {
      render(<EntitySections entity={Object.freeze({ entity: "host", host: "alpha" })} />);
      expect(screen.getByRole("alert")).toHaveTextContent("Unable to load attached sections.");
      expect(slotRegions()).toEqual([]);
      expect(document.body.textContent).not.toContain("boom secret detail");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("EntitySections fragment failure isolation", () => {
  it("keeps siblings, the later section, and core content when one fragment throws", () => {
    const restore = quietErrors();
    try {
      render(
        <div>
          <div>CORE-CONTENT</div>
          <EntitySections entity={Object.freeze({ entity: "service", host: "safe", name: "api" })} />
        </div>,
      );
      // The failing fragment shows a generic boundary alert…
      expect(within(region("Findings")).getByRole("alert")).toHaveTextContent(
        "Attached content could not be displayed.",
      );
      // …while its sibling, the later configs section, and core content survive.
      expect(within(region("Findings")).getByText("SVC-OK")).toBeInTheDocument();
      expect(within(region("Configs")).getByText("SVC-COND-OK")).toBeInTheDocument();
      expect(screen.getByText("CORE-CONTENT")).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("internal exception");
    } finally {
      restore();
    }
  });

  it("remounts a failed boundary when navigation changes the entity", () => {
    const restore = quietErrors();
    try {
      const { rerender } = render(
        <EntitySections entity={Object.freeze({ entity: "service", host: "boom", name: "api" })} />,
      );
      expect(within(region("Configs")).getByRole("alert")).toHaveTextContent(
        "Attached content could not be displayed.",
      );
      expect(screen.queryByText("SVC-COND-OK")).toBeNull();

      // A different entity changes the collision-safe boundary key, so the
      // boundary remounts and re-attempts the render successfully.
      rerender(<EntitySections entity={Object.freeze({ entity: "service", host: "safe", name: "api" })} />);
      expect(within(region("Configs")).getByText("SVC-COND-OK")).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Feature non-registration and non-rendering guards.
// ---------------------------------------------------------------------------

describe("feature fragment-slot boundaries", () => {
  const featureDir = fileURLToPath(new URL("../src/features/hosts-and-services", TEST_FILE_URL));

  function featureSources(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) files.push(...featureSources(full));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(full);
    }
    return files;
  }

  it("makes zero registerEntityFragment calls anywhere in the feature", () => {
    const sources = featureSources(featureDir);
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      expect(readFileSync(file, "utf8")).not.toContain("registerEntityFragment(");
    }
  });

  it("never uses dangerouslySetInnerHTML in the fragment-slot and detail primitives", () => {
    for (const name of ["components/EntitySections.tsx", "components/detail-shared.tsx"]) {
      const source = readFileSync(`${featureDir}/${name}`, "utf8");
      expect(source).not.toContain("dangerouslySetInnerHTML");
    }
  });
});

// ---------------------------------------------------------------------------
// Host detail route.
// ---------------------------------------------------------------------------

const SECRET_ALPHA_ID = "secret-alpha-id";
const SECRET_BETA_ID = "secret-beta-id";
const FORBIDDEN_SECRET_VALUE = "s3cr3t-value-must-never-render";

/** A declared host exercising every declared field, including duplicate keys. */
function fullDeclaredHost() {
  return hostDecl("alpha", {
    kind: "vm",
    purpose: "Primary app server",
    hypervisor: "hyper1",
    vmid: 101,
    addresses: [
      { network: "lan", address: "10.0.0.1", primary: true },
      { network: "lan", address: "10.0.0.2" },
      { network: "mgmt", address: "10.9.0.1" },
    ],
    access: {
      method: "ssh",
      port: 22,
      user: "ops",
      sudo: true,
      reachable: true,
      notes: "jump host only",
    },
    backup: {
      expected: true,
      schedule: "daily 02:00",
      target: "nas-primary",
      notes: "retain thirty days",
    },
    managedConfigs: [
      { path: "/etc/app.conf", source: "repo/app.conf", notes: "templated" },
      { path: "/etc/only-declared.conf", source: "repo/only.conf" },
    ],
    secrets: [SECRET_ALPHA_ID, SECRET_BETA_ID],
    links: [{ title: "Dashboard", href: "https://dash.invalid/alpha" }],
  });
}

/** An observed host exercising every reality field, incl. partial collectors. */
function fullObservedHost() {
  return observedHost("alpha", {
    coverage: "partial",
    collectedAt: FIXED_AT,
    collectors: {
      succeeded: ["os", "network"],
      failed: [{ name: "docker", reason: "socket unavailable" }],
    },
    reachable: true,
    addresses: [
      { network: "lan", address: "10.0.0.1", primary: true },
      { network: "tailnet", address: "100.64.0.1" },
    ],
    os: { name: "Debian", version: "12", kernel: "6.1.0-amd64" },
    uptimeSeconds: 0,
    containers: [{ name: "web", image: "nginx:1.27", state: "running" }],
    guests: [{ vmid: 201, name: "guest-a", state: "running" }],
    managedConfigs: [
      { path: "/etc/app.conf", inSync: true },
      { path: "/etc/observed-only.conf", inSync: false },
    ],
    facts: {
      zulu: '<img src=x onerror="alert(1)">',
      alpha: { nested: 1 },
    },
  });
}

/** A committed generation for the fully-populated available host. */
function fullHostData(): InventoryData {
  return makeData({
    config: config(
      [fullDeclaredHost()],
      [
        serviceDecl("alpha", "api", { status: "active" }),
        serviceDecl("alpha", "web", { status: "planned", hidden: true }),
      ],
    ),
    snapshot: availableState(
      snapshotResult({
        hosts: [fullObservedHost()],
        services: [
          observedService("alpha", "api", { state: "running" }),
          // Observed-only service on this host: Undeclared / Not declared row.
          observedService("alpha", "ghost", { state: "degraded" }),
        ],
        hostStates: { alpha: hostState("partial", { pastStaleThreshold: true }) },
      }),
    ),
  });
}

/** Render the host detail page for `name` over `data`. */
function renderHost(data: InventoryData, name: string | undefined): ReturnType<typeof render> {
  inventoryData = data;
  routeParams = name === undefined ? {} : { name };
  return render(<HostDetailPage />);
}

/** The page heading (`h1`). */
function pageHeading(): HTMLElement {
  return screen.getByRole("heading", { level: 1 });
}

/** The page header's status badges (`meta` slot), as `data-marker` slugs. */
function headerMarkers(): string[] {
  const header = pageHeading().closest("[data-slot=page-header]")!;
  return [...header.querySelectorAll<HTMLElement>("[data-marker]")].map((el) => el.dataset.marker ?? "");
}

describe("host detail registration", () => {
  it("registers /hosts/:name once as a navigation-hidden page", async () => {
    const detail = getPages().filter((page) => page.id === "page:inventory/host-detail");
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({
      path: "/hosts/:name",
      label: "Host",
      nav: false,
    });
    expect(await resolveComponent(detail[0].component)).toBe(HostDetailPage);
  });
});

describe("host detail routing and not-found", () => {
  it("shows loading and never flashes not-found before the model settles", () => {
    renderHost(makeData({ config: null, snapshot: pendingState(), loading: true }), "ghost");
    expect(screen.getByRole("status", { name: "Loading inventory…" })).toBeInTheDocument();
    expect(screen.queryByText("Host not found")).toBeNull();
  });

  it("renders the accessible not-found page with a /hosts recovery link", () => {
    renderHost(makeData({ config: config([hostDecl("alpha")]), snapshot: NOT_CONFIGURED }), "does-not-exist");
    const page = region("Host not found");
    expect(pageHeading()).toHaveTextContent("Host not found");
    expect(within(page).getByRole("status")).toHaveTextContent(
      "No declared or observed host matches this route.",
    );
    expect(within(page).getByRole("link", { name: "Back to hosts" })).toHaveAttribute("href", "/hosts");
    expect(page.closest("[data-slot=host-detail-page]")).not.toBeNull();
  });

  it("treats a missing route parameter as not-found without throwing", () => {
    renderHost(makeData({ config: config([hostDecl("alpha")]), snapshot: NOT_CONFIGURED }), undefined);
    expect(pageHeading()).toHaveTextContent("Host not found");
  });

  it("renders a config-error alert with SnapshotStatus and no lookup", () => {
    renderHost(
      makeData({
        config: null,
        configError: "Config response is invalid; check the deck server.",
        snapshot: requestErrorState("Snapshot request failed; check the deck server connection."),
      }),
      "alpha",
    );
    const page = region(/Inventory configuration unavailable/);
    expect(within(page).getAllByRole("alert").map((el) => el.textContent)).toContainEqual(
      expect.stringContaining(
        "Inventory configuration unavailable: Config response is invalid; check the deck server.",
      ),
    );
    expect(within(page).getByText("Snapshot request failed")).toBeInTheDocument();
    expect(screen.queryByText("Host not found")).toBeNull();
  });

  it("resolves an observed-only host and marks it Undeclared", () => {
    renderHost(
      makeData({
        config: config([]),
        snapshot: availableState(
          snapshotResult({ hosts: [observedHost("zeta")], hostStates: { zeta: hostState("fresh") } }),
        ),
      }),
      "zeta",
    );
    expect(pageHeading()).toHaveTextContent("Host: zeta");
    expect(headerMarkers()).toEqual(["undeclared"]);
    // Its identity intent side has no declaration.
    expect(within(side(region("Identity"), "Declared intent")).getByText("Not declared")).toBeInTheDocument();
  });
});

describe("host detail sections and fields", () => {
  it("renders every required section in spec order with intent before reality", () => {
    renderHost(fullHostData(), "alpha");
    expect(pageHeading()).toHaveTextContent("Host: alpha");
    expect(pageHeading()).toHaveAttribute("id", "host-detail-heading");
    expect(region("Host: alpha").closest("[data-slot=host-detail-page]")).not.toBeNull();
    expect(sectionHeadings()).toEqual([
      "Snapshot available",
      "Identity",
      "Freshness",
      "Addresses",
      "Access",
      "Backup",
      "Managed configs",
      "Secrets",
      "Links",
      "Observed facts",
      "Services on this host",
      "Findings",
      "Configs",
    ]);
    // Legacy heading ids are kept (in-page anchors and aria wiring).
    for (const id of [
      "intent-reality-identity",
      "host-freshness-heading",
      "host-addresses-heading",
      "intent-reality-access",
      "intent-reality-backup",
      "host-managed-configs-heading",
      "intent-reality-secrets",
      "intent-reality-links",
      "intent-reality-observed-facts",
      "host-services-heading",
    ]) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it("renders identity and the guest pair on the declared side", () => {
    renderHost(fullHostData(), "alpha");
    const declared = side(region("Identity"), "Declared intent");
    expect(valueOf(declared, "Kind")).toBe("vm");
    expect(valueOf(declared, "Purpose")).toBe("Primary app server");
    expect(valueOf(declared, "Hypervisor")).toBe("hyper1");
    expect(valueOf(declared, "Guest vmid")).toBe("101");
    expect(within(declared).queryByText("Hidden")).toBeNull();
    expect(valueOf(side(region("Identity"), "Observed reality"), "Name")).toBe("alpha");
  });

  it("renders partial collector successes and failures with reasons", () => {
    renderHost(fullHostData(), "alpha");
    const freshness = region("Freshness");
    expect(freshness.querySelector("[data-host-state=partial]")).not.toBeNull();
    expect(within(freshness).getByText("Partial")).toBeInTheDocument();
    expect(within(freshness).getByText(/Past stale threshold/)).toBeInTheDocument();
    expect(within(freshness).getByRole("heading", { level: 3, name: "Collectors succeeded" })).toBeInTheDocument();
    expect(within(freshness).getByText("network")).toBeInTheDocument();
    expect(within(freshness).getByRole("heading", { level: 3, name: "Collectors failed" })).toBeInTheDocument();
    expect(within(freshness).getByText("docker: socket unavailable")).toBeInTheDocument();
  });

  it("renders succeeded/failed None reported and a missing-collectors alert", () => {
    renderHost(
      makeData({
        config: config([hostDecl("alpha")]),
        snapshot: availableState(
          snapshotResult({
            hosts: [observedHost("alpha", { coverage: "partial", collectors: { succeeded: [], failed: [] } })],
            hostStates: { alpha: hostState("partial") },
          }),
        ),
      }),
      "alpha",
    );
    expect(within(region("Freshness")).getAllByText("None reported")).toHaveLength(2);
    cleanup();

    renderHost(
      makeData({
        config: config([hostDecl("alpha")]),
        snapshot: availableState(
          snapshotResult({
            hosts: [observedHost("alpha", { coverage: "partial" })],
            hostStates: { alpha: hostState("partial") },
          }),
        ),
      }),
      "alpha",
    );
    expect(within(region("Freshness")).getByRole("alert")).toHaveTextContent("Collector outcomes unavailable.");
    // The page and host state remain visible.
    expect(pageHeading()).toHaveTextContent("Host: alpha");
  });

  it("renders access, backup, secrets, and links declared fields", () => {
    renderHost(fullHostData(), "alpha");
    const access = side(region("Access"), "Declared intent");
    expect(valueOf(access, "Method")).toBe("ssh");
    expect(valueOf(access, "Port")).toBe("22");
    expect(valueOf(access, "Sudo")).toBe("Yes");
    expect(valueOf(access, "Expected reachable")).toBe("Yes");
    expect(valueOf(access, "Notes")).toBe("jump host only");
    expect(valueOf(side(region("Access"), "Observed reality"), "Reachable")).toBe("Yes");

    const backup = side(region("Backup"), "Declared intent");
    expect(valueOf(backup, "Schedule")).toBe("daily 02:00");
    expect(valueOf(backup, "Notes")).toBe("retain thirty days");
    // The snapshot has no observed backup: an available reality says Not observed.
    expect(within(side(region("Backup"), "Observed reality")).getByText("Not observed")).toBeInTheDocument();

    const link = within(region("Links")).getByRole("link", { name: "Dashboard" });
    expect(link).toHaveAttribute("href", "https://dash.invalid/alpha");
    expect(link).not.toHaveAttribute("target");
  });
});

describe("host detail addresses and managed configs pairing", () => {
  it("pairs matched, one-sided, and duplicate-key addresses without dropping data", () => {
    renderHost(fullHostData(), "alpha");
    const table = within(region("Addresses")).getByRole("table", {
      name: "Declared intent beside observed reality",
    });
    const rows = within(table)
      .getAllByRole("rowheader")
      .map((cell) => cells(cell.closest("tr")!));
    expect(rows).toEqual([
      ["lan", "10.0.0.1 (primary)", "10.0.0.1 (primary)"],
      ["lan", "10.0.0.2", "Not observed"],
      ["mgmt", "10.9.0.1", "Not observed"],
      ["tailnet", "Not declared", "100.64.0.1"],
    ]);
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Network",
      "Declared intent",
      "Observed reality",
    ]);
  });

  it("pairs matched, one-sided, and out-of-sync managed configs", () => {
    renderHost(fullHostData(), "alpha");
    const table = within(region("Managed configs")).getByRole("table");
    expect(cells(rowOf(table, "/etc/app.conf"))).toEqual(["/etc/app.conf", "repo/app.conf — templated", "In sync"]);
    expect(cells(rowOf(table, "/etc/only-declared.conf"))).toEqual([
      "/etc/only-declared.conf",
      "repo/only.conf",
      "Not observed",
    ]);
    expect(cells(rowOf(table, "/etc/observed-only.conf"))).toEqual([
      "/etc/observed-only.conf",
      "Not declared",
      "Out of sync",
    ]);
    // Icon plus text, never colour alone.
    for (const marker of ["in-sync", "out-of-sync"]) {
      const badge = table.querySelector(`[data-marker=${marker}]`)!;
      expect(badge.querySelector("svg[aria-hidden=true]")).not.toBeNull();
    }
  });

  it("omits empty address and managed-config sections", () => {
    renderHost(
      makeData({
        config: config([hostDecl("alpha")]),
        snapshot: availableState(
          snapshotResult({ hosts: [observedHost("alpha")], hostStates: { alpha: hostState("fresh") } }),
        ),
      }),
      "alpha",
    );
    const headings = sectionHeadings();
    for (const absent of ["Addresses", "Managed configs", "Access", "Backup", "Secrets", "Links"]) {
      expect(headings).not.toContain(absent);
    }
  });

  it("shows No snapshot on declared addresses and configs when reality is absent", () => {
    renderHost(makeData({ config: config([fullDeclaredHost()]), snapshot: NOT_CONFIGURED }), "alpha");
    const addresses = within(region("Addresses")).getByRole("table");
    expect(cells(rowOf(addresses, "mgmt"))).toEqual(["mgmt", "10.9.0.1", "No snapshot"]);
    const configs = within(region("Managed configs")).getByRole("table");
    expect(cells(rowOf(configs, "/etc/app.conf"))).toEqual(["/etc/app.conf", "repo/app.conf — templated", "No snapshot"]);
    // Reality says No snapshot everywhere, never Not observed.
    expect(document.querySelector("[data-marker=not-observed]")).toBeNull();
    // No host state is fabricated with no snapshot.
    expect(document.querySelector("[data-host-state]")).toBeNull();
    expect(within(region("Freshness")).getByText("No snapshot")).toBeInTheDocument();
  });
});

describe("host detail security and observed facts", () => {
  it("renders every declared secret id and no forbidden secret value", () => {
    renderHost(
      makeData({
        config: config([fullDeclaredHost()]),
        snapshot: availableState(
          snapshotResult({ hosts: [observedHost("alpha")], hostStates: { alpha: hostState("fresh") } }),
        ),
      }),
      "alpha",
    );
    const secrets = side(region("Secrets"), "Declared intent");
    for (const id of [SECRET_ALPHA_ID, SECRET_BETA_ID]) {
      expect(within(secrets).getByText(id).tagName).toBe("CODE");
    }
    expect(document.body.textContent).not.toContain(FORBIDDEN_SECRET_VALUE);
  });

  it("makes no secret resolver, provider, or request call in the detail source", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/features/hosts-and-services/hosts/detail.tsx", TEST_FILE_URL)),
      "utf8",
    );
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it("escapes observed facts, sorts keys, and renders zero uptime", () => {
    const { container } = renderHost(fullHostData(), "alpha");
    const facts = side(region("Observed facts"), "Observed reality");
    expect(within(side(region("Observed facts"), "Declared intent")).getByText("Not declared")).toBeInTheDocument();
    expect(valueOf(facts, "OS name")).toBe("Debian");
    expect(valueOf(facts, "Kernel")).toBe("6.1.0-amd64");
    expect(within(facts).getByRole("heading", { name: "Containers" })).toBeInTheDocument();
    expect(within(facts).getByText("web — nginx:1.27 (running)")).toBeInTheDocument();
    expect(within(facts).getByRole("heading", { name: "Guests" })).toBeInTheDocument();
    expect(within(facts).getByText("201 — guest-a (running)")).toBeInTheDocument();
    // Zero uptime is visible, not treated as absent.
    expect(within(facts).getByText("Uptime: 0 seconds")).toBeInTheDocument();
    // Fact keys are sorted ordinally and markup-like values stay text.
    const terms = within(facts).getAllByRole("term").map((dt) => dt.textContent);
    expect(terms.indexOf("alpha")).toBeLessThan(terms.indexOf("zulu"));
    expect(valueOf(facts, "zulu")).toBe('"<img src=x onerror=\\"alert(1)\\">"');
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("host detail services-on-host and slots", () => {
  it("lists sorted host services with the Services list semantics", () => {
    renderHost(fullHostData(), "alpha");
    const table = within(region("Services on this host")).getByRole("table", {
      name: "Declared intent beside observed reality",
    });
    const names = within(table).getAllByRole("rowheader").map((cell) => within(cell).getByRole("link"));
    // Declared and observed-only services, sorted by name.
    expect(names.map((link) => link.getAttribute("href"))).toEqual([
      "/services/alpha/api",
      "/services/alpha/ghost",
      "/services/alpha/web",
    ]);
    expect(cells(rowOf(table, "api"))).toEqual(["api", "alpha", "external", "Active", "api purpose", "Running", expect.stringContaining("Partial")]);
    const ghost = rowOf(table, "ghost");
    expect(ghost.querySelector("[data-marker=undeclared]")).not.toBeNull();
    expect(within(ghost).getByText("Degraded")).toBeInTheDocument();
    const web = rowOf(table, "web");
    expect(web.querySelector("[data-marker=hidden]")).not.toBeNull();
    expect(within(web).getByText("Planned")).toBeInTheDocument();
    expect(within(web).getByText("Not observed")).toBeInTheDocument();
    // The host column links back to the host route.
    expect(within(web).getByRole("link", { name: "alpha" })).toHaveAttribute("href", "/hosts/alpha");
  });

  it("shows an empty services message when the host has none", () => {
    renderHost(makeData({ config: config([hostDecl("solo")]), snapshot: NOT_CONFIGURED }), "solo");
    expect(within(region("Services on this host")).getByRole("status")).toHaveTextContent(
      "No services are declared or observed on this host.",
    );
  });

  it("renders Findings then Configs slots only after all core sections", () => {
    renderHost(fullHostData(), "alpha");
    expect(sectionHeadings().slice(-3)).toEqual(["Services on this host", "Findings", "Configs"]);
    expect(within(region("Findings")).getByText("HOST-FIND-A")).toBeInTheDocument();
    expect(within(region("Configs")).getByText("HOST-CONF")).toBeInTheDocument();
  });

  it("renders a generic invalid-link marker when a route segment cannot encode", () => {
    // A lone surrogate makes encodeURIComponent throw URIError.
    const badName = "bad\uD800host";
    renderHost(
      makeData({ config: config([hostDecl(badName)], [serviceDecl(badName, "api")]), snapshot: NOT_CONFIGURED }),
      badName,
    );
    const services = region("Services on this host");
    expect(within(services).getAllByText("Invalid entity link")).toHaveLength(2);
    expect(within(services).queryByRole("link")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service detail route.
// ---------------------------------------------------------------------------

const SVC_SECRET_ALPHA = "svc-secret-alpha-id";
const SVC_SECRET_BETA = "svc-secret-beta-id";
const SVC_FORBIDDEN_VALUE = "svc-s3cr3t-value-must-never-render";

/**
 * Render the service detail page. Found service pages render `EntitySections`,
 * which includes the intentionally throwing `svc-fail` fragment, so React's
 * error report is silenced for the render.
 */
function renderService(data: InventoryData, params: Record<string, string>): ReturnType<typeof render> {
  inventoryData = data;
  routeParams = params;
  const restore = quietErrors();
  try {
    return render(<ServiceDetailPage />);
  } finally {
    restore();
  }
}

/** A declared service exercising every declared field. */
function fullDeclaredService(): ReturnType<typeof serviceDecl> {
  return serviceDecl("alpha", "api", {
    kind: "docker-compose",
    purpose: "Primary API service",
    status: "active",
    stack: "api-stack",
    secrets: [SVC_SECRET_ALPHA, SVC_SECRET_BETA],
    backup: {
      expected: true,
      schedule: "daily 03:00",
      target: "nas-services",
      notes: "retain sixty days",
    },
    links: [{ title: "Service dashboard", href: "https://svc.invalid/api" }],
  });
}

/** A committed generation for the fully-populated available service. */
function fullServiceData(): InventoryData {
  return makeData({
    config: config([hostDecl("alpha")], [fullDeclaredService()]),
    snapshot: availableState(
      snapshotResult({
        hosts: [observedHost("alpha")],
        services: [
          observedService("alpha", "api", {
            state: "running",
            facts: { zulu: '<img src=x onerror="alert(1)">', alpha: { nested: 1 } },
          }),
        ],
        hostStates: { alpha: hostState("fresh") },
      }),
    ),
  });
}

describe("service detail registration", () => {
  it("registers exactly four inventory pages with two nav-hidden detail routes", () => {
    const ids = new Set(["page:inventory/hosts", "page:inventory/services", "page:inventory/host-detail", "page:inventory/service-detail"]);
    const inventory = getPages().filter((page) => ids.has(page.id));
    expect(inventory).toHaveLength(4);

    const nav = inventory.filter((page) => page.nav !== false).map((page) => page.id);
    expect(nav.sort()).toEqual(["page:inventory/hosts", "page:inventory/services"]);

    const hidden = inventory.filter((page) => page.nav === false);
    expect(hidden.map((page) => page.id).sort()).toEqual(["page:inventory/host-detail", "page:inventory/service-detail"]);
  });

  it("registers /services/:host/:name once as a navigation-hidden page", async () => {
    const detail = getPages().filter((page) => page.id === "page:inventory/service-detail");
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({
      path: "/services/:host/:name",
      label: "Service",
      nav: false,
    });
    expect(await resolveComponent(detail[0].component)).toBe(ServiceDetailPage);
  });
});

describe("service detail routing and not-found", () => {
  it("shows loading and never flashes not-found before the model settles", () => {
    renderService(makeData({ config: null, snapshot: pendingState(), loading: true }), { host: "alpha", name: "api" });
    expect(screen.getByRole("status", { name: "Loading inventory…" })).toBeInTheDocument();
    expect(screen.queryByText("Service not found")).toBeNull();
  });

  it("renders the accessible not-found page with a /services recovery link", () => {
    renderService(
      makeData({ config: config([hostDecl("alpha")], [serviceDecl("alpha", "api")]), snapshot: NOT_CONFIGURED }),
      { host: "alpha", name: "does-not-exist" },
    );
    const page = region("Service not found");
    expect(within(page).getByRole("status")).toHaveTextContent(
      "No declared or observed service matches this route.",
    );
    expect(within(page).getByRole("link", { name: "Back to services" })).toHaveAttribute("href", "/services");
    expect(page.closest("[data-slot=service-detail-page]")).not.toBeNull();
  });

  it("treats a missing route parameter as not-found without throwing", () => {
    renderService(
      makeData({ config: config([hostDecl("alpha")], [serviceDecl("alpha", "api")]), snapshot: NOT_CONFIGURED }),
      { host: "alpha" },
    );
    expect(pageHeading()).toHaveTextContent("Service not found");
  });

  it("renders a config-error alert with SnapshotStatus and no lookup", () => {
    renderService(
      makeData({
        config: null,
        configError: "Config response is invalid; check the deck server.",
        snapshot: requestErrorState("Snapshot request failed; check the deck server connection."),
      }),
      { host: "alpha", name: "api" },
    );
    const page = region(/Inventory configuration unavailable/);
    expect(within(page).getAllByRole("alert").map((el) => el.textContent)).toContainEqual(
      expect.stringContaining(
        "Inventory configuration unavailable: Config response is invalid; check the deck server.",
      ),
    );
    expect(within(page).getByText("Snapshot request failed")).toBeInTheDocument();
    expect(screen.queryByText("Service not found")).toBeNull();
  });

  it("looks up host and name independently, distinguishing repeated names", () => {
    renderService(
      makeData({
        config: config(
          [hostDecl("alpha"), hostDecl("bravo")],
          [
            serviceDecl("alpha", "api", { purpose: "Alpha API" }),
            serviceDecl("bravo", "api", { purpose: "Bravo API" }),
          ],
        ),
        snapshot: NOT_CONFIGURED,
      }),
      { host: "bravo", name: "api" },
    );
    expect(pageHeading()).toHaveTextContent("Service: api");
    expect(screen.getByText("Bravo API")).toBeInTheDocument();
    expect(screen.queryByText("Alpha API")).toBeNull();
    // Every host link points at the resolved host, not the other one.
    const hrefs = screen.getAllByRole("link", { name: /^(alpha|bravo)$/ }).map((a) => a.getAttribute("href"));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs)).toEqual(new Set(["/hosts/bravo"]));
  });

  it("resolves an observed-only service and marks it Undeclared", () => {
    renderService(
      makeData({
        config: config([]),
        snapshot: availableState(
          snapshotResult({
            services: [observedService("zeta", "edge", { state: "running" })],
            hostStates: { zeta: hostState("fresh") },
          }),
        ),
      }),
      { host: "zeta", name: "edge" },
    );
    expect(pageHeading()).toHaveTextContent("Service: edge");
    expect(headerMarkers()).toEqual(["undeclared"]);
    expect(within(side(region("Identity"), "Declared intent")).getByText("Not declared")).toBeInTheDocument();
  });
});

describe("service detail sections and fields", () => {
  it("renders every required section in spec order with intent before reality", () => {
    renderService(fullServiceData(), { host: "alpha", name: "api" });
    expect(pageHeading()).toHaveTextContent("Service: api");
    expect(pageHeading()).toHaveAttribute("id", "service-detail-heading");
    expect(region("Service: api").closest("[data-slot=service-detail-page]")).not.toBeNull();
    expect(sectionHeadings()).toEqual([
      "Snapshot available",
      "Identity",
      "Freshness",
      "Observed state",
      "Backup",
      "Secrets",
      "Links",
      "Findings",
      "Configs",
    ]);
    expect(document.getElementById("service-freshness-heading")).not.toBeNull();
    expect(document.getElementById("intent-reality-observed-state")).not.toBeNull();
  });

  it("renders identity fields including the encoded host link and stack", () => {
    renderService(fullServiceData(), { host: "alpha", name: "api" });
    const header = pageHeading().closest("[data-slot=page-header]") as HTMLElement;
    expect(within(header).getByText(/On host:/)).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "alpha" })).toHaveAttribute("href", "/hosts/alpha");
    const declared = side(region("Identity"), "Declared intent");
    expect(valueOf(declared, "Kind")).toBe("docker-compose");
    expect(valueOf(declared, "Lifecycle")).toBe("Active");
    expect(valueOf(declared, "Purpose")).toBe("Primary API service");
    expect(valueOf(declared, "Stack")).toBe("api-stack");
    expect(within(declared).getByRole("link", { name: "alpha" })).toHaveAttribute("href", "/hosts/alpha");
    const observed = side(region("Identity"), "Observed reality");
    expect(within(observed).getByRole("link", { name: "alpha" })).toHaveAttribute("href", "/hosts/alpha");
  });

  it("renders Unspecified lifecycle for a declared service without status", () => {
    renderService(
      makeData({ config: config([hostDecl("alpha")], [serviceDecl("alpha", "api")]), snapshot: NOT_CONFIGURED }),
      { host: "alpha", name: "api" },
    );
    expect(valueOf(side(region("Identity"), "Declared intent"), "Lifecycle")).toBe("Unspecified");
  });

  it("renders inherited host freshness and observed state and facts", () => {
    renderService(fullServiceData(), { host: "alpha", name: "api" });
    // Inherited host collection state (not the provider snapshot badge).
    const freshness = region("Freshness");
    expect(freshness.querySelector("[data-host-state=fresh]")).not.toBeNull();
    expect(within(freshness).getByText("Fresh")).toBeInTheDocument();
    // Observed service state and ordinally sorted open facts.
    const observed = side(region("Observed state"), "Observed reality");
    expect(within(observed).getByText("Running")).toBeInTheDocument();
    const terms = within(observed).getAllByRole("term").map((dt) => dt.textContent);
    expect(terms).toEqual(["alpha", "zulu"]);
  });

  it("renders declared backup and link fields", () => {
    renderService(fullServiceData(), { host: "alpha", name: "api" });
    const backup = side(region("Backup"), "Declared intent");
    expect(valueOf(backup, "Schedule")).toBe("daily 03:00");
    expect(valueOf(backup, "Notes")).toBe("retain sixty days");
    expect(within(region("Links")).getByRole("link", { name: "Service dashboard" })).toHaveAttribute(
      "href",
      "https://svc.invalid/api",
    );
  });

  it("omits wholly absent optional sections", () => {
    renderService(
      makeData({
        config: config([hostDecl("alpha")], [serviceDecl("alpha", "api")]),
        snapshot: availableState(
          snapshotResult({
            services: [observedService("alpha", "api", { state: "running" })],
            hostStates: { alpha: hostState("fresh") },
          }),
        ),
      }),
      { host: "alpha", name: "api" },
    );
    const headings = sectionHeadings();
    for (const absent of ["Backup", "Secrets", "Links"]) expect(headings).not.toContain(absent);
    // Identity, Freshness, and Observed state always render.
    for (const present of ["Identity", "Freshness", "Observed state"]) expect(headings).toContain(present);
  });
});

describe("service detail reality distinctions", () => {
  it("shows Not observed for a declared service absent from an available snapshot", () => {
    renderService(
      makeData({
        config: config([hostDecl("alpha")], [serviceDecl("alpha", "api")]),
        snapshot: availableState(snapshotResult({ hostStates: { alpha: hostState("fresh") } })),
      }),
      { host: "alpha", name: "api" },
    );
    expect(
      within(side(region("Observed state"), "Observed reality")).getByText("Not observed"),
    ).toHaveAttribute("data-marker", "not-observed");
    // Never coerced to Stopped/Unknown and never No snapshot.
    expect(screen.queryByText("No snapshot")).toBeNull();
    expect(screen.queryByText("Stopped")).toBeNull();
  });

  it("shows No snapshot for every reality surface when reality is unavailable", () => {
    renderService(makeData({ config: config([hostDecl("alpha")], [fullDeclaredService()]), snapshot: NOT_CONFIGURED }), {
      host: "alpha",
      name: "api",
    });
    // Declared intent still renders.
    expect(valueOf(side(region("Identity"), "Declared intent"), "Stack")).toBe("api-stack");
    expect(valueOf(side(region("Backup"), "Declared intent"), "Schedule")).toBe("daily 03:00");
    // Reality says No snapshot everywhere, never Not observed.
    for (const name of ["Identity", "Observed state", "Backup", "Secrets", "Links"]) {
      expect(within(side(region(name), "Observed reality")).getByText("No snapshot")).toBeInTheDocument();
    }
    expect(within(region("Freshness")).getByText("No snapshot")).toBeInTheDocument();
    expect(document.querySelector("[data-marker=not-observed]")).toBeNull();
    // No host state is fabricated with no snapshot.
    expect(document.querySelector("[data-host-state]")).toBeNull();
  });

  it("keeps accepted reality visible while reporting a retained provider error", () => {
    renderService(
      makeData({
        config: config([hostDecl("alpha")], [serviceDecl("alpha", "api")]),
        snapshot: availableState(
          snapshotResult({
            services: [observedService("alpha", "api", { state: "running" })],
            hostStates: { alpha: hostState("fresh") },
            readError: { code: "POLL_TIMEOUT", message: "Snapshot read timed out." },
          }),
          { message: "Latest provider poll failed." },
        ),
      }),
      { host: "alpha", name: "api" },
    );
    // Retained reality is still shown.
    expect(within(side(region("Observed state"), "Observed reality")).getByText("Running")).toBeInTheDocument();
    expect(document.querySelector("[data-host-state=fresh]")).not.toBeNull();
    // The failure alert is surfaced separately without overwriting reality.
    const status = region("Snapshot available");
    expect(within(status).getByRole("alert")).toHaveTextContent(
      "Latest snapshot read failed; showing the last successful snapshot.",
    );
    expect(within(status).getByText("Snapshot read timed out.")).toBeInTheDocument();
    expect(screen.queryByText("Not observed")).toBeNull();
  });
});

describe("service detail security, encoding, and slots", () => {
  it("renders every declared secret id and no forbidden secret value", () => {
    renderService(
      makeData({
        config: config([hostDecl("alpha")], [serviceDecl("alpha", "api", { secrets: [SVC_SECRET_ALPHA, SVC_SECRET_BETA] })]),
        snapshot: availableState(
          snapshotResult({
            services: [observedService("alpha", "api", { state: "running" })],
            hostStates: { alpha: hostState("fresh") },
          }),
        ),
      }),
      { host: "alpha", name: "api" },
    );
    const secrets = side(region("Secrets"), "Declared intent");
    for (const id of [SVC_SECRET_ALPHA, SVC_SECRET_BETA]) {
      expect(within(secrets).getByText(id).tagName).toBe("CODE");
    }
    expect(document.body.textContent).not.toContain(SVC_FORBIDDEN_VALUE);
  });

  it("makes no secret resolver, fetch, or unsafe HTML call in the detail source", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/features/hosts-and-services/services/detail.tsx", TEST_FILE_URL)),
      "utf8",
    );
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("registerEntityFragment");
  });

  it("escapes observed facts and never interprets them as markup", () => {
    const { container } = renderService(fullServiceData(), { host: "alpha", name: "api" });
    expect(container.querySelectorAll("img")).toHaveLength(0);
    const observed = side(region("Observed state"), "Observed reality");
    expect(valueOf(observed, "zulu")).toContain("<img src=x");
  });

  it("encodes spaces, %, #, Unicode, and slash in the host link independently", () => {
    const host = "a b/c#%é";
    renderService(makeData({ config: config([hostDecl(host)], [serviceDecl(host, "api")]), snapshot: NOT_CONFIGURED }), {
      host,
      name: "api",
    });
    // Every reserved/space/unicode char is percent-encoded in one segment; the
    // slash becomes %2F so it cannot forge an extra path segment.
    const expected = `/hosts/${encodeURIComponent(host)}`;
    expect(expected).toContain("%2F");
    expect(expected).toContain("%20");
    expect(expected).toContain("%23");
    expect(expected).toContain("%25");
    for (const link of screen.getAllByRole("link", { name: host })) {
      expect(link).toHaveAttribute("href", expected);
    }
  });

  it("renders a generic invalid-link marker when the host segment cannot encode", () => {
    // A lone surrogate makes encodeURIComponent throw URIError.
    const host = "bad\uD800host";
    renderService(makeData({ config: config([hostDecl(host)], [serviceDecl(host, "api")]), snapshot: NOT_CONFIGURED }), {
      host,
      name: "api",
    });
    expect(screen.getAllByText("Invalid entity link").length).toBeGreaterThan(0);
    // The page core still renders.
    expect(pageHeading()).toHaveTextContent("Service: api");
  });

  it("renders Findings then Configs slots with the exact service reference after core sections", () => {
    renderService(fullServiceData(), { host: "alpha", name: "api" });
    expect(sectionHeadings().slice(-3)).toEqual(["Links", "Findings", "Configs"]);
    // svc-ok in findings, svc-cond in configs; the throwing svc-fail fragment is
    // isolated behind its boundary alert.
    const findings = region("Findings");
    expect(within(findings).getByText("SVC-OK")).toBeInTheDocument();
    expect(within(findings).getByRole("alert")).toHaveTextContent("Attached content could not be displayed.");
    expect(within(region("Configs")).getByText("SVC-COND-OK")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Declared host lifecycle status: mirrors the service lifecycle, independent of hidden.
// ---------------------------------------------------------------------------

describe("host lifecycle status", () => {
  function lifecycleConfig() {
    return config([
      hostDecl("alpha", { status: "retired" }),
      hostDecl("bravo", { status: "planned", hidden: true }),
      hostDecl("charlie"),
    ]);
  }

  it("renders the retired badge in host detail without marking the host hidden", () => {
    renderHost(makeData({ config: lifecycleConfig(), snapshot: NOT_CONFIGURED }), "alpha");
    expect(headerMarkers()).toEqual(["retired"]);
    expect(valueOf(side(region("Identity"), "Declared intent"), "Lifecycle")).toBe("Retired");
  });

  it("keeps hidden and status independent in host detail", () => {
    renderHost(makeData({ config: lifecycleConfig(), snapshot: NOT_CONFIGURED }), "bravo");
    expect(headerMarkers()).toEqual(["planned", "hidden"]);
    expect(valueOf(side(region("Identity"), "Declared intent"), "Hidden")).toBe("Hidden from default views");
    cleanup();

    renderHost(makeData({ config: lifecycleConfig(), snapshot: NOT_CONFIGURED }), "charlie");
    expect(headerMarkers()).toEqual([]);
    const declared = side(region("Identity"), "Declared intent");
    expect(within(declared).queryByText("Lifecycle")).toBeNull();
    expect(within(declared).queryByText("Hidden")).toBeNull();
  });
});
