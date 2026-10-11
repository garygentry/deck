import { Component, Fragment, type ReactNode } from "react";
import { cssEscape, focusElement, focusIsLost } from "@/ui/lib/dom";
import { pageHeadingId } from "@/ui/lib/dom-id";
import { ErrorState } from "@/ui/patterns/error-state";
import { PageHeader } from "@/ui/patterns/page-header";

export interface PageErrorBoundaryProps {
  /** The page content to isolate. */
  children: ReactNode;
  /** When this value changes (e.g. the route path), a prior failure is cleared. */
  resetKey?: unknown;
  /** Fallback page heading. */
  title?: string;
  /** Fallback message. Fixed text: the caught exception is never shown. */
  message?: string;
  /** Retry button text. */
  retryLabel?: string;
  /** Fallback heading level (see `PageHeader.level`). */
  level?: 1 | 2 | 3;
  /** Diagnostic hook, called from `componentDidCatch`. */
  onError?: (error: unknown) => void;
  /**
   * The page root's `data-slot` (e.g. `"alerts-page"`). When set, the fallback renders inside
   * a `data-slot={pageSlot} data-state="error"` root, so a failed page keeps the view's page contract
   * (its `…-page` root and one `h1`). Only for a boundary that wraps the page root from outside,
   * so the fallback stands in for the page root itself; a boundary inside its page root must not
   * set it, or the page would get a second root.
   */
  pageSlot?: string;
}

const DEFAULT_TITLE = "This page could not be displayed";

/** Where the fallback sat when Retry was pressed: the recovered content renders between `before` and `after`. */
interface PendingFocus {
  host: HTMLElement;
  before: Node | null;
  after: Node | null;
  observer: MutationObserver | null;
}

/**
 * The element to focus in the recovered content: its first h1, else its page root (a top-level
 * `…-page` slot). Only the nodes the boundary rendered are searched, never the host's other children.
 */
function recoveredTarget({ host, before, after }: PendingFocus): HTMLElement | null {
  const nodes: HTMLElement[] = [];
  let node = before !== null && before.parentNode === host ? before.nextSibling : host.firstChild;
  for (; node !== null && node !== after; node = node.nextSibling) {
    if (node instanceof HTMLElement) nodes.push(node);
  }
  for (const el of nodes) {
    const h1 = el.matches("h1") ? el : el.querySelector<HTMLElement>("h1");
    if (h1 !== null) return h1;
  }
  return nodes.find((el) => el.dataset.slot?.endsWith("-page") === true) ?? null;
}

interface PageErrorBoundaryState {
  failed: boolean;
  nonce: number;
  lastResetKey: unknown;
}

/**
 * Page-level render isolation. A throw in the page content renders a page
 * header + `ErrorState` with Retry instead of blanking the app; the shell
 * survives. Retry remounts the content (a nonce key); a changed `resetKey`
 * clears the failure. Exception text is logged, never rendered.
 *
 * The content is keyed by a Fragment, not wrapped in an element, so it adds no
 * DOM of its own.
 */
export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { failed: false, nonce: 0, lastResetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<PageErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: PageErrorBoundaryProps,
    state: PageErrorBoundaryState,
  ): Partial<PageErrorBoundaryState> | null {
    if (props.resetKey !== state.lastResetKey) {
      return { failed: false, lastResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: unknown): void {
    console.error("[deck] a page failed to render", error);
    this.props.onError?.(error);
  }

  /** The outermost element the fallback renders (the `pageSlot` root, or the section). */
  private fallbackEl: HTMLElement | null = null;
  private readonly setFallbackEl = (el: HTMLElement | null): void => {
    this.fallbackEl = el;
  };
  /** Set by Retry until its commit; `pending` lives on until the recovered content is focused. */
  private retrying = false;
  private pending: PendingFocus | null = null;

  private readonly retry = (): void => {
    this.cancelFocus();
    const root = this.fallbackEl;
    const host = root?.parentElement ?? null;
    if (root !== null && host !== null) {
      this.pending = { host, before: root.previousSibling, after: root.nextSibling, observer: null };
    }
    this.retrying = true;
    this.setState((prior) => ({ failed: false, nonce: prior.nonce + 1 }));
  };

  /**
   * After Retry, move focus off <body> (where it falls with the Retry button): to the fallback's
   * heading if the content failed again, else to the recovered content's h1 or page root. If the
   * content is not there yet (a descendant Suspense is loading it), focus the host when it is
   * focusable and wait for the content to commit. The wait ends on unmount, a reset, a new error,
   * or when the user moves focus themselves.
   */
  componentDidUpdate(prevProps: PageErrorBoundaryProps): void {
    if (this.retrying) {
      this.retrying = false;
      if (this.state.failed) {
        this.cancelFocus();
        const heading = this.fallbackEl?.querySelector<HTMLElement>(`#${cssEscape(this.headingId())}`);
        if (heading) focusElement(heading);
        return;
      }
      const pending = this.pending;
      if (pending === null || this.focusRecovered()) return;
      if (pending.host.hasAttribute("tabindex")) pending.host.focus({ preventScroll: true });
      pending.observer = new MutationObserver(() => this.focusRecovered());
      pending.observer.observe(pending.host, { childList: true, subtree: true });
      return;
    }
    if (this.state.failed || prevProps.resetKey !== this.props.resetKey) this.cancelFocus();
  }

  componentWillUnmount(): void {
    this.cancelFocus();
  }

  /** Try to settle the pending focus; true when there is nothing left to wait for. */
  private focusRecovered(): boolean {
    const pending = this.pending;
    if (pending === null) return true;
    if (!focusIsLost() && document.activeElement !== pending.host) {
      this.cancelFocus(); // the user has moved focus on purpose
      return true;
    }
    const target = recoveredTarget(pending);
    if (target === null) return false;
    this.cancelFocus();
    focusElement(target);
    return true;
  }

  private cancelFocus(): void {
    this.pending?.observer?.disconnect();
    this.pending = null;
  }

  private headingId(): string {
    return pageHeadingId(this.props.title ?? DEFAULT_TITLE);
  }

  render(): ReactNode {
    if (this.state.failed) {
      const {
        title = DEFAULT_TITLE,
        message = "Something went wrong rendering this view. Other pages may still work.",
        retryLabel = "Retry",
        level = 1,
      } = this.props;
      const headingId = this.headingId();
      const { pageSlot } = this.props;
      const fallback = (
        <section
          ref={pageSlot === undefined ? this.setFallbackEl : undefined}
          data-slot="page-error-boundary"
          aria-labelledby={headingId}
          className="flex flex-col gap-6"
        >
          <PageHeader id={headingId} title={title} level={level} />
          <ErrorState title={message} onRetry={this.retry} retryLabel={retryLabel} />
        </section>
      );
      return pageSlot === undefined ? (
        fallback
      ) : (
        <div
          ref={this.setFallbackEl}
          data-slot={pageSlot}
          data-state="error"
          className="flex min-w-0 flex-col"
        >
          {fallback}
        </div>
      );
    }
    return <Fragment key={this.state.nonce}>{this.props.children}</Fragment>;
  }
}
