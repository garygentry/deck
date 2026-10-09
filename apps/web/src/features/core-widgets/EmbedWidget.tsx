import { EMBED_SANDBOX } from "@deck/contract/modules/widgets";
// The one url rule (dependency-free), which config validation runs too.
import { embedUrlProblem } from "@deck/schema/embed";
import { EmptyState, ErrorState, ExternalLink, LoadingState, cn } from "@/ui";

import { useUiManifest } from "../../data/index.js";
import type { WidgetProps } from "../../registry/registry.js";

export interface EmbedOptions {
  url: string;
  height?: "sm" | "md" | "lg" | "xl";
  sandbox?: string[];
}

// Static class map (Tailwind sees every class literally), so no inline style is needed.
const HEIGHT: Record<NonNullable<EmbedOptions["height"]>, string> = {
  sm: "h-60",
  md: "h-96",
  lg: "h-144",
  xl: "h-192",
};

/** What a framed page may do unless the widget says otherwise: run its own scripts, as its own origin. */
export const DEFAULT_EMBED_SANDBOX: readonly string[] = ["allow-scripts", "allow-same-origin"];

/**
 * The sandbox tokens a widget may grant: its options schema's list. Top navigation, modals,
 * pointer lock and the rest are never granted, whatever reaches the component.
 */
const SANDBOX_TOKENS: ReadonlySet<string> = new Set(EMBED_SANDBOX);

/** The frame's `sandbox` attribute: the widget's tokens (default {@link DEFAULT_EMBED_SANDBOX}), known ones only. */
export function sandboxOf(tokens: readonly string[] | undefined): string {
  return (tokens ?? DEFAULT_EMBED_SANDBOX).filter((token) => SANDBOX_TOKENS.has(token)).join(" ");
}

/**
 * The URL the frame may show: one config validation accepts (`embedUrlProblem`, the same check)
 * on another origin than deck's. A page of deck's own origin is refused: framed with scripts and
 * its origin, it could lift its own sandbox and act as deck. Only the configured URL is checked;
 * where that page later redirects or navigates is the framed site's.
 */
export function embedTarget(raw: unknown, ownOrigin: string): { url: URL } | { problem: string } {
  const problem = embedUrlProblem(raw);
  if (problem !== null) return { problem };
  const url = new URL(raw as string);
  if (url.origin === ownOrigin) return { problem: "Deck does not frame its own pages; place their widgets on a dashboard instead." };
  return { url };
}

/**
 * `core/embed`: another site's page in a sandboxed frame, with a link that opens it in a new tab
 * (for a site that refuses to be framed). It frames nothing unless the UI manifest says the ui
 * config allows embeds (`ui.allowUnsafeEmbeds: true`); until the manifest arrives it waits, and
 * when the manifest cannot be read it stays off. The frame sends no referrer and loads lazily.
 */
export function EmbedWidget({ options, widget }: WidgetProps<EmbedOptions>) {
  const manifest = useUiManifest();
  const target = embedTarget(options.url, window.location.origin);
  if ("problem" in target) return <ErrorState compact title="Cannot embed this page" message={target.problem} />;
  const open = (
    <ExternalLink href={target.url.href} className="text-sm">
      Open {target.url.host}
    </ExternalLink>
  );
  if (manifest.status === "loading") return <LoadingState label="Loading widget…" preset="lines" rows={2} />;
  if (manifest.status !== "ready" || manifest.manifest.allowUnsafeEmbeds !== true) {
    return <EmptyState compact icon="eye-off" title="Embeds are off" description="Set ui.allowUnsafeEmbeds: true to show this page here." action={open} />;
  }
  const sandbox = sandboxOf(options.sandbox);
  return (
    <div data-slot="embed" className="flex flex-col gap-2">
      {/* A browser applies sandbox changes only on the next navigation, so a new URL or policy is a new frame. */}
      <iframe
        key={`${target.url.href} ${sandbox}`}
        src={target.url.href}
        title={widget.title ?? `Page from ${target.url.host}`}
        sandbox={sandbox}
        referrerPolicy="no-referrer"
        loading="lazy"
        className={cn("block w-full rounded-md border border-border bg-background", HEIGHT[options.height ?? "md"] ?? HEIGHT.md)}
      />
      <div className="flex justify-end">{open}</div>
    </div>
  );
}
