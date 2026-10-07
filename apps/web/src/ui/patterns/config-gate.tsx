import type { DeckConfig } from "@deck/server";
import { useState, type ReactNode } from "react";
import { useConfig } from "@/shell/use-config";
import { usePageHeadingId } from "@/ui/hooks/use-page-heading-id";
import { cn } from "@/ui/lib/utils";
import { ErrorState } from "@/ui/patterns/error-state";
import { LoadingState, type LoadingPreset } from "@/ui/patterns/loading-state";
import { PageHeader, type PageHeaderProps } from "@/ui/patterns/page-header";

/** The `useConfig` ladder, generic over the config shape (so demos/tests need no DeckConfig). */
export type ConfigGateState<C> =
  | { status: "loading" }
  | { status: "ready"; config: C }
  | { status: "error"; message: string };

export interface ConfigGateFrameProps extends Omit<PageHeaderProps, "title" | "className"> {
  /** The page title: the header is rendered the same in every state. */
  title: string;
  /** Loading text. */
  loadingLabel?: string;
  /** Skeleton preset approximating the ready page. */
  loadingPreset?: LoadingPreset;
  /** Error-state heading; the fetch error message is shown beneath it. */
  errorTitle?: string;
  className?: string;
}

export interface ConfigGateViewProps<C> extends ConfigGateFrameProps {
  state: ConfigGateState<C>;
  /** Renders the ready page body under the preserved header. */
  children: (config: C) => ReactNode;
  /** Shows a Retry button in the error state. */
  onRetry?: () => void;
}

/**
 * Presentational config ladder: a `section[aria-labelledby]` whose `PageHeader`
 * stays put while the body moves loading → `LoadingState`, error →
 * `ErrorState`, ready → `children(config)`. `aria-busy` is set while loading.
 */
export function ConfigGateView<C>({
  state,
  children,
  onRetry,
  title,
  id,
  loadingLabel = "Loading…",
  loadingPreset = "lines",
  errorTitle = "Failed to load configuration",
  className,
  ...header
}: ConfigGateViewProps<C>) {
  const derivedId = usePageHeadingId(title);
  const headingId = id ?? derivedId;
  return (
    <section
      data-slot="config-gate"
      data-state={state.status}
      aria-labelledby={headingId}
      aria-busy={state.status === "loading" || undefined}
      className={cn("flex flex-col gap-6", className)}
    >
      <PageHeader id={headingId} title={title} {...header} />
      {state.status === "loading" && <LoadingState label={loadingLabel} preset={loadingPreset} />}
      {state.status === "error" && <ErrorState title={errorTitle} message={state.message} onRetry={onRetry} />}
      {state.status === "ready" && children(state.config)}
    </section>
  );
}

export interface ConfigGateProps extends ConfigGateFrameProps {
  children: (config: DeckConfig) => ReactNode;
}

/**
 * `ConfigGateView` bound to the shell's `useConfig()`. Retry refetches by
 * remounting the loader (useConfig fetches once per mount).
 */
export function ConfigGate(props: ConfigGateProps) {
  const [attempt, setAttempt] = useState(0);
  return <ConfigGateLoader key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function ConfigGateLoader({ onRetry, ...props }: ConfigGateProps & { onRetry: () => void }) {
  const state = useConfig();
  return <ConfigGateView<DeckConfig> state={state} onRetry={onRetry} {...props} />;
}
