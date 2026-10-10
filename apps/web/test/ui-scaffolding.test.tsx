// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  Callout,
  ConfigGate,
  ConfigGateView,
  EmptyState,
  ErrorState,
  FragmentBoundary,
  LoadingState,
  PageErrorBoundary,
  PageHeader,
  Section,
  TONES,
  calloutRole,
  pageHeadingId,
  slugify,
  usePageHeadingId,
  type ConfigGateState,
} from "@/ui";
import { scaffolding } from "../src/features/_ui/sections/scaffolding.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Throws(): never {
  throw new Error("secret-internal-detail");
}

describe("slugify / pageHeadingId", () => {
  it("derives safe, stable ids from fixed titles", () => {
    expect(slugify("Declared intent & <reality>")).toBe("declared-intent-reality");
    expect(slugify("!!!")).toBe("section");
    expect(pageHeadingId("Actions")).toBe("actions-heading");
  });
});

describe("PageHeader", () => {
  it("renders one h1 with a stable id that usePageHeadingId reproduces", () => {
    function Page() {
      const headingId = usePageHeadingId("Actions");
      return (
        <section aria-labelledby={headingId}>
          <PageHeader title="Actions" description="Run governed actions." />
        </section>
      );
    }
    render(<Page />);
    const heading = screen.getByRole("heading", { level: 1, name: "Actions" });
    expect(heading).toHaveAttribute("id", "actions-heading");
    expect(screen.getByRole("region", { name: "Actions" })).toContainElement(heading);
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByText("Run governed actions.")).toBeInTheDocument();
  });

  it("renders meta and actions slots, an explicit id and a demoted level", () => {
    render(
      <PageHeader
        id="custom-id"
        level={3}
        title="nas-01"
        meta={<span>Observed</span>}
        actions={<Button>Refresh</Button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "nas-01" })).toHaveAttribute("id", "custom-id");
    expect(screen.getByText("Observed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("renders breadcrumb entries as a navigation trail with the last as the current page", () => {
    render(<PageHeader title="nas-01" breadcrumbs={[{ label: "Hosts", href: "/hosts" }, { label: "nas-01" }]} />);
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Hosts" })).toHaveAttribute("href", "/hosts");
    expect(within(nav).getByText("nas-01")).toHaveAttribute("aria-current", "page");
  });
});

describe("Section", () => {
  it("is a region named by its h2", () => {
    render(
      <Section id="addresses" title="Addresses" description="Interfaces." actions={<Button>View</Button>}>
        body
      </Section>,
    );
    const region = screen.getByRole("region", { name: "Addresses" });
    expect(region).toHaveAttribute("id", "addresses");
    expect(within(region).getByRole("heading", { level: 2, name: "Addresses" })).toHaveAttribute(
      "id",
      "addresses-heading",
    );
    expect(within(region).getByRole("button", { name: "View" })).toBeInTheDocument();
  });

  it("names itself without an id, honours headingId and level", () => {
    render(
      <>
        <Section title="One">a</Section>
        <Section title="Two" headingId="intent-reality-two" level={3} variant="card">
          b
        </Section>
      </>,
    );
    expect(screen.getByRole("region", { name: "One" })).toBeInTheDocument();
    const two = screen.getByRole("region", { name: "Two" });
    expect(within(two).getByRole("heading", { level: 3 })).toHaveAttribute("id", "intent-reality-two");
    expect(two).toHaveAttribute("data-variant", "card");
  });
});

describe("EmptyState", () => {
  it("is a polite status region with title, description and action", () => {
    render(
      <EmptyState title="No documents" description="Nothing acquired yet." action={<Button>Add a source</Button>} />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("No documents");
    expect(status).toHaveTextContent("Nothing acquired yet.");
    expect(within(status).getByRole("button", { name: "Add a source" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has a compact variant that keeps the status role", () => {
    render(<EmptyState compact title="No services on this host." />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("No services on this host.");
    expect(status).toHaveAttribute("data-compact");
  });
});

describe("ErrorState", () => {
  it("is an alert with title, message and a working Retry", async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Source failed" message="Remote did not respond." onRetry={onRetry} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Source failed");
    expect(alert).toHaveTextContent("Remote did not respond.");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("omits Retry without a handler and collapses details behind a disclosure", async () => {
    render(<ErrorState title="Failed" details="trace-id 42" retryLabel="Try again" />);
    expect(screen.queryByRole("button")).toBeNull();
    const summary = screen.getByText("Details");
    const details = summary.closest("details");
    expect(details).not.toHaveAttribute("open");
    await userEvent.click(summary);
    expect(details).toHaveAttribute("open");
  });
});

describe("LoadingState", () => {
  it.each(["lines", "table", "cards", "detail"] as const)("preset %s is a busy status named by its label", (preset) => {
    render(<LoadingState preset={preset} label="Loading hosts…" />);
    const status = screen.getByRole("status", { name: "Loading hosts…" });
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("data-preset", preset);
  });

  it("keeps an accessible name when the label is visually hidden", () => {
    render(<LoadingState hideLabel />);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
  });
});

describe("Callout", () => {
  it("derives its role from the tone", () => {
    expect(TONES.map((tone) => [tone, calloutRole(tone)])).toEqual([
      ["ok", "status"],
      ["warn", "status"],
      ["danger", "alert"],
      ["info", "note"],
      ["pending", "status"],
      ["neutral", "note"],
    ]);
    render(
      <>
        <Callout tone="danger" title="Run failed">
          Exit 1
        </Callout>
        <Callout tone="warn">Truncated</Callout>
        <Callout tone="info">Read-only</Callout>
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Run failedExit 1");
    expect(screen.getByRole("status")).toHaveTextContent("Truncated");
    expect(screen.getByRole("note")).toHaveTextContent("Read-only");
  });

  it("always pairs text with a decorative icon, and accepts a role override", () => {
    render(
      <Callout tone="ok" role="note">
        All clear
      </Callout>,
    );
    const note = screen.getByRole("note");
    expect(note).toHaveAttribute("data-tone", "ok");
    expect(note.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("dismissal is caller-owned: the button calls onDismiss and the caller unmounts it", async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return open ? (
        <Callout tone="info" onDismiss={() => setOpen(false)} dismissLabel="Dismiss tip">
          Tip
        </Callout>
      ) : null;
    }
    render(<Host />);
    const button = screen.getByRole("button", { name: "Dismiss tip" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("renders no dismiss button without onDismiss", () => {
    render(<Callout tone="warn" action={<a href="/x">Details</a>}>Body</Callout>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "Details" })).toBeInTheDocument();
  });
});

describe("PageErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders a page heading + alert with Retry, never the exception text", () => {
    render(
      <PageErrorBoundary>
        <Throws />
      </PageErrorBoundary>,
    );
    const region = screen.getByRole("region", { name: "This page could not be displayed" });
    expect(within(region).getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(within(region).getByRole("alert")).toHaveTextContent("Something went wrong rendering this view");
    expect(within(region).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret-internal-detail");
  });

  it("Retry remounts the content; resetKey clears a failure", async () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("boom");
      return <p>Recovered</p>;
    }
    const onError = vi.fn();
    const { rerender } = render(
      <PageErrorBoundary resetKey="/a" retryLabel="Retry view" onError={onError}>
        <Flaky />
      </PageErrorBoundary>,
    );
    expect(onError).toHaveBeenCalled();
    shouldThrow = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry view" }));
    expect(screen.getByText("Recovered")).toBeInTheDocument();

    shouldThrow = true;
    rerender(
      <PageErrorBoundary resetKey="/a" retryLabel="Retry view">
        <Flaky key="again" />
      </PageErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    shouldThrow = false;
    rerender(
      <PageErrorBoundary resetKey="/b" retryLabel="Retry view">
        <Flaky key="again" />
      </PageErrorBoundary>,
    );
    expect(screen.getByText("Recovered")).toBeInTheDocument();
  });

  it("adds no wrapper element around healthy content", () => {
    const { container } = render(
      <PageErrorBoundary>
        <p>Healthy</p>
      </PageErrorBoundary>,
    );
    expect(container.firstElementChild?.tagName).toBe("P");
  });
});

describe("FragmentBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("isolates a failing fragment behind a fixed alert that keeps the link, leaving siblings intact", () => {
    render(
      <div>
        <FragmentBoundary label="Alerts summary" href="/monitoring#alerts">
          <Throws />
        </FragmentBoundary>
        <p>Sibling</p>
      </div>,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("link", { name: "Alerts summary unavailable" })).toHaveAttribute(
      "href",
      "/monitoring#alerts",
    );
    expect(screen.getByText("Sibling")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret-internal-detail");
  });

  it("supports a custom fallback and renders children unwrapped when healthy", () => {
    const { container } = render(
      <>
        <FragmentBoundary label="Metrics" fallback={<span>Metrics: —</span>}>
          <Throws />
        </FragmentBoundary>
        <FragmentBoundary label="Healthy">
          <em>ok</em>
        </FragmentBoundary>
      </>,
    );
    expect(screen.getByText("Metrics: —")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelector("em")?.parentElement).toBe(container);
  });
});

describe("ConfigGateView", () => {
  function Gate({ state, onRetry }: { state: ConfigGateState<{ n: number }>; onRetry?: () => void }) {
    return (
      <ConfigGateView title="Docs" state={state} onRetry={onRetry} loadingLabel="Loading docs…">
        {(config) => <p>{config.n} sources</p>}
      </ConfigGateView>
    );
  }

  it("keeps the page header in every state and moves loading → error → ready", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<Gate state={{ status: "loading" }} />);
    const region = () => screen.getByRole("region", { name: "Docs" });
    expect(region()).toHaveAttribute("aria-busy", "true");
    expect(within(region()).getByRole("status", { name: "Loading docs…" })).toBeInTheDocument();

    rerender(<Gate state={{ status: "error", message: "GET /api/config → 503" }} onRetry={onRetry} />);
    expect(region()).not.toHaveAttribute("aria-busy");
    const alert = within(region()).getByRole("alert");
    expect(alert).toHaveTextContent("Failed to load configuration");
    expect(alert).toHaveTextContent("GET /api/config → 503");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(<Gate state={{ status: "ready", config: { n: 3 } }} />);
    expect(within(region()).getByText("3 sources")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1, name: "Docs" })).toHaveLength(1);
  });
});

describe("workbench section", () => {
  it("renders every specimen, with boundary demos contained and no extra h1", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Demo = scaffolding.Demo;
    render(<Demo />);
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Drift view could not be displayed" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alerts summary unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Docs (loading)" })).toHaveAttribute("aria-busy", "true");
  });
});

describe("ConfigGate", () => {
  it("drives the ladder from useConfig and refetches on Retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 2, estate: { name: "Estate" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConfigGate title="Actions">
        {(config) => <p>Loaded {config.estate.name}</p>}
      </ConfigGate>,
    );
    expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("GET /api/config → 503");
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Loaded Estate")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { level: 1, name: "Actions" })).toHaveAttribute("id", "actions-heading");
  });
});
