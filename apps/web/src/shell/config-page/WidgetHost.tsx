import type { FreshnessStamp, ProviderEnvelope } from "@deck/contract";
import { Suspense } from "react";
import type { UiWidgetInstance } from "@deck/module-sdk";
import { EmptyState, ErrorState, FragmentBoundary, FreshnessBadge, LoadingState, Section, cn } from "@/ui";

import { useProvider, useUiManifest } from "../../data/index.js";
import { getWidgetType, type WidgetTypeRegistration } from "../../registry/registry.js";
import type { WidgetPlacement } from "../../registry/registry-types.js";
import { useRegistryVersion } from "../../registry/use-registry.js";

// Static class maps (Tailwind sees every class literally): spans apply from `md` up, where the
// section's grid has its columns; below it every widget takes the one column.
const COL_SPAN: Record<UiWidgetInstance["span"], string> = {
  1: "md:col-span-1",
  2: "md:col-span-2",
  3: "md:col-span-3",
  4: "md:col-span-4",
};
const ROW_SPAN: Record<number, string> = {
  1: "md:row-span-1",
  2: "md:row-span-2",
  3: "md:row-span-3",
  4: "md:row-span-4",
  5: "md:row-span-5",
  6: "md:row-span-6",
};

/** What a widget shows, from its type, source and the provider's envelope. */
export type WidgetView =
  | { state: "loading" }
  | { state: "error"; title: string; message: string; details?: string }
  | { state: "empty"; freshness: FreshnessStamp | null }
  | { state: "ready"; value: unknown; freshness: FreshnessStamp | null };

/**
 * The view for a widget: unavailable when the server says no enabled module provides its type
 * (`typeProblem`), the manifest does not list the type (`listed`) or the web has not registered
 * it; an error when its source did not resolve; loading until the provider's first read; an error when the provider has no data
 * because it failed, or the widget's `select` failed on it; empty when the value is null or
 * an empty list or object; else the value (the `select` result the server evaluated, or the
 * provider's data whole), with the provider's freshness. A widget that reads no source (a
 * static one) renders its type with a `null` value.
 */
export function widgetView(
  widget: UiWidgetInstance,
  type: WidgetTypeRegistration | undefined,
  provider: { envelope: ProviderEnvelope | null; loading: boolean } | null,
  listed = true,
): WidgetView {
  if (widget.typeProblem !== undefined || !listed || type === undefined) {
    return {
      state: "error",
      title: "Widget unavailable",
      message: widget.typeProblem ?? `No enabled module provides the widget type "${widget.type}".`,
    };
  }
  if (widget.sourceProblem !== undefined) return { state: "error", title: "No data source", message: widget.sourceProblem };
  if (provider === null) return { state: "ready", value: null, freshness: null };
  const { envelope, loading } = provider;
  if (envelope === null) {
    return loading ? { state: "loading" } : { state: "error", title: "Data source unavailable", message: `Provider "${widget.source?.id}" could not be read.` };
  }
  const { freshness } = envelope;
  if (envelope.data === null) {
    if (envelope.error !== null) {
      return { state: "error", title: "Data source unavailable", message: `Provider "${envelope.id}" has no data.`, details: envelope.error.message };
    }
    return freshness.state === "pending" ? { state: "loading" } : { state: "empty", freshness };
  }
  let value: unknown = envelope.data;
  if (widget.projection !== undefined) {
    const projection = envelope.projections?.[widget.projection];
    if (projection === undefined) {
      return { state: "error", title: "No result", message: "The server sent no result for this widget's select." };
    }
    if ("error" in projection) {
      return { state: "error", title: "Select failed", message: "This widget's select could not be evaluated on the provider's data.", details: projection.error };
    }
    value = projection.value;
  }
  return isEmptyValue(value) ? { state: "empty", freshness } : { state: "ready", value, freshness };
}

/** Null, an empty list or an object with no keys: nothing to show. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

/**
 * One widget of a config page: a card titled by the widget (else its type), whose content is
 * its type's component, or a loading, empty or error state. A freshness badge shows when the
 * provider's data is not fresh. The component renders inside a `FragmentBoundary`, so a
 * widget that throws leaves the page and its other widgets working.
 *
 * With `placement="page"` (a module page's own dashboard, such as the portal's groups) there is
 * no card, title or grid span: the body renders as the page's content, in the same boundary.
 */
export function WidgetHost({ widget, placement = "card" }: { widget: UiWidgetInstance; placement?: WidgetPlacement }) {
  // A widget type registered after the page rendered (a lazily loaded module) shows up.
  useRegistryVersion();
  const type = getWidgetType(widget.type);
  const title = widget.title ?? widget.type;
  // A type of a module that is off renders as unavailable, and reads no data, even when the web bundles it.
  const manifest = useUiManifest();
  const widgetTypes = manifest.status === "ready" ? manifest.manifest.widgetTypes : undefined;
  const listed = !Array.isArray(widgetTypes) || widgetTypes.some((entry) => entry?.type === widget.type);
  const available = listed && type !== undefined && widget.typeProblem === undefined;
  if (placement === "page") {
    return (
      <div data-slot="widget" data-widget-type={widget.type} data-widget-id={widget.id}>
        {widget.source === null || !available ? (
          <WidgetBoundary widget={widget} label={title} view={widgetView(widget, type, null, listed)} type={type} resetKey={widget} placement={placement} />
        ) : (
          <SourcedWidget widget={widget} sourceId={widget.source.id} title={title} type={type} placement={placement} />
        )}
      </div>
    );
  }
  return (
    <div
      data-slot="widget"
      data-widget-type={widget.type}
      data-widget-id={widget.id}
      className={cn("min-w-0", COL_SPAN[widget.span], ROW_SPAN[widget.rows] ?? ROW_SPAN[1])}
    >
      {widget.source === null || !available ? (
        <WidgetCard widget={widget} title={title} view={widgetView(widget, type, null, listed)} type={type} resetKey={widget} />
      ) : (
        <SourcedWidget widget={widget} sourceId={widget.source.id} title={title} type={type} />
      )}
    </div>
  );
}

function SourcedWidget({
  widget,
  sourceId,
  title,
  type,
  placement = "card",
}: {
  widget: UiWidgetInstance;
  sourceId: string;
  title: string;
  type: WidgetTypeRegistration | undefined;
  placement?: WidgetPlacement;
}) {
  const provider = useProvider<unknown>(sourceId);
  const view = widgetView(widget, type, provider);
  // A new envelope (new data) retries a widget that threw.
  return placement === "page"
    ? <WidgetBoundary widget={widget} label={title} view={view} type={type} resetKey={provider.envelope} placement={placement} />
    : <WidgetCard widget={widget} title={title} view={view} type={type} resetKey={provider.envelope} />;
}

function WidgetCard({
  widget,
  title,
  view,
  type,
  resetKey,
}: {
  widget: UiWidgetInstance;
  title: string;
  view: WidgetView;
  type: WidgetTypeRegistration | undefined;
  resetKey: unknown;
}) {
  const freshness = view.state === "ready" || view.state === "empty" ? view.freshness : null;
  const badge = freshness !== null && freshness.state !== "fresh" && freshness.state !== "static" ? <FreshnessBadge freshness={freshness} /> : undefined;
  return (
    <Section variant="card" level={3} title={title} actions={badge} className="h-full">
      <WidgetBoundary widget={widget} label={title} view={view} type={type} resetKey={resetKey} placement="card" />
    </Section>
  );
}

/** A widget's body in its error boundary, under a `Suspense` for a type whose component loads on first use. */
function WidgetBoundary({
  widget,
  label,
  view,
  type,
  resetKey,
  placement,
}: {
  widget: UiWidgetInstance;
  label: string;
  view: WidgetView;
  type: WidgetTypeRegistration | undefined;
  resetKey: unknown;
  placement: WidgetPlacement;
}) {
  return (
    <FragmentBoundary label={label} resetKey={resetKey}>
      {/* A widget type whose component loads on first use (core/table) waits here, not the page. */}
      <Suspense fallback={<LoadingState label="Loading widget…" preset="lines" rows={2} />}>
        <WidgetBody widget={widget} view={view} type={type} placement={placement} />
      </Suspense>
    </FragmentBoundary>
  );
}

function WidgetBody({
  widget,
  view,
  type,
  placement,
}: {
  widget: UiWidgetInstance;
  view: WidgetView;
  type: WidgetTypeRegistration | undefined;
  placement: WidgetPlacement;
}) {
  switch (view.state) {
    case "loading":
      return <LoadingState label="Loading data…" preset="lines" rows={2} />;
    case "error":
      return <ErrorState compact title={view.title} message={view.message} {...(view.details === undefined ? {} : { details: view.details })} />;
    case "empty":
      return <EmptyState compact title="No data to show" />;
    case "ready": {
      const Component = type!.component;
      return <Component value={view.value} options={widget.options} freshness={view.freshness} widget={widget} placement={placement} />;
    }
  }
}
