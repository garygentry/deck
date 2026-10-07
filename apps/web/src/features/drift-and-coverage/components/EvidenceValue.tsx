import { buildEvidencePreview } from "@deck/server";
import type {
  EvidencePreviewLimits,
  EvidencePreviewReason,
  ReadonlyJsonValue,
} from "@deck/server";
import type { JsonValue } from "@deck/schema";
import { Component } from "react";
import type { ReactNode, JSX } from "react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/ui";

/** One labelled expected/observed JSON value. */
export interface EvidenceValueProps {
  /** Visible and programmatic label: `Expected` or `Observed`. */
  readonly label: "Expected" | "Observed";
  /** Exact supplied JSON value; field absence is handled by the parent. */
  readonly value: JsonValue;
  /** Optional test/internal limits; production omits these to use release defaults. */
  readonly limits?: EvidencePreviewLimits;
}

/** Boundary render state: whether the inner evidence field threw. */
interface EvidenceFieldBoundaryState {
  readonly failed: boolean;
}

/**
 * Field-local error boundary. A throw from `buildEvidencePreview` or from the
 * structural renderer is isolated here to a fixed sanitized alert; it never
 * exposes the exception or the value and never removes the surrounding finding.
 */
class EvidenceFieldBoundary extends Component<
  { readonly children: ReactNode },
  EvidenceFieldBoundaryState
> {
  state: EvidenceFieldBoundaryState = { failed: false };

  static getDerivedStateFromError(): EvidenceFieldBoundaryState {
    return { failed: true };
  }

  componentDidCatch(): void {
    // Intentionally swallow: evidence values and exception text are never logged.
  }

  render(): JSX.Element {
    if (this.state.failed) {
      return (
        <p role="alert" className="text-sm text-status-danger-fg">
          Evidence could not be displayed.
        </p>
      );
    }
    return <>{this.props.children}</>;
  }
}

/** Ordinal code-point comparator for deterministic object-key rendering. */
function compareCodePoints(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Render one bounded preview node as inert semantic markup. Strings retain their
 * JSON quotes, `null` is literal text, arrays expose visible indices, and object
 * keys are shown in code-point order. No HTML parsing, URL activation, evaluator,
 * or secret resolution occurs; every leaf is framework-interpolated text.
 */
function JsonNode({ value }: { readonly value: ReadonlyJsonValue }): JSX.Element {
  if (value === null) return <code>null</code>;
  if (typeof value === "string") return <code>{JSON.stringify(value)}</code>;
  if (typeof value === "number" || typeof value === "boolean") {
    return <code>{String(value)}</code>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <code>[]</code>;
    return (
      <ol className="m-0 flex list-none flex-col gap-0.5 border-l pl-3">
        {value.map((item, index) => (
          <li key={index}>
            <span className="font-mono text-muted-foreground">[{index}]</span>{" "}
            <JsonNode value={item} />
          </li>
        ))}
      </ol>
    );
  }
  const entries = value as { readonly [key: string]: ReadonlyJsonValue };
  const keys = Object.keys(entries).sort(compareCodePoints);
  if (keys.length === 0) return <code>{"{}"}</code>;
  return (
    <dl className="m-0 flex flex-col gap-0.5 border-l pl-3">
      {keys.map((key) => (
        <div key={key} className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted-foreground">
            <code>{JSON.stringify(key)}</code>
          </dt>
          <dd className="m-0 min-w-0 break-all">
            <JsonNode value={entries[key] as ReadonlyJsonValue} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Compose the fixed truncation sentence from the preview's ordered reasons. */
function truncationText(reasons: readonly EvidencePreviewReason[]): string {
  const clause = reasons
    .map((reason) => (reason === "depth" ? "depth" : "size"))
    .join(" and ");
  return `Preview truncated by ${clause}; full supplied value is available on request.`;
}

/**
 * Schedule lazy full-value preparation after the initiating event so the page and
 * unrelated navigation controls can paint first. Uses `requestAnimationFrame` when
 * available, otherwise an immediate microtask.
 */
function scheduleInspection(run: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => run());
  } else {
    void Promise.resolve().then(run);
  }
}

/**
 * Build the bounded preview and render the inert structural tree, a truncation
 * notice, and an on-demand complete inspection. Full text is produced lazily only
 * after activation, never eagerly, and collapse restores focus to the same
 * trigger. Expansion is local to this field.
 */
function EvidenceInner({ label, value, limits }: EvidenceValueProps): JSX.Element {
  // A throwing build surfaces during render and is caught by the field boundary.
  const preview = useMemo(
    () => buildEvidencePreview(value, limits),
    [value, limits],
  );
  const [expanded, setExpanded] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const lower = label.toLowerCase();

  const onToggle = (): void => {
    if (expanded) {
      setExpanded(false);
      setFullText(null);
      // One toggling control: keep focus on the trigger after collapse.
      buttonRef.current?.focus();
      return;
    }
    setExpanded(true);
    scheduleInspection(() => {
      setFullText(JSON.stringify(preview.fullValue, null, 2));
    });
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-1 font-mono text-xs break-all"
      data-drift-evidence={label}
    >
      <p className="font-sans text-xs font-semibold break-normal text-muted-foreground">{label}</p>
      <JsonNode value={preview.preview} />
      {preview.truncated ? (
        <div className="flex flex-col items-start gap-1.5 font-sans text-xs break-normal text-muted-foreground">
          <p>{truncationText(preview.reasons)}</p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            ref={buttonRef}
            aria-expanded={expanded ? "true" : "false"}
            onClick={onToggle}
          >
            {expanded
              ? `Collapse full ${lower} value`
              : `Inspect full ${lower} value`}
          </Button>
          {expanded ? (
            fullText === null ? (
              <p role="status">Preparing full evidence value.</p>
            ) : (
              <pre
                aria-label={`Full ${lower} value`}
                className="max-h-96 w-full overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre text-foreground"
              >
                {fullText}
              </pre>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Render a bounded structural preview and on-demand inert full value. */
export function EvidenceValue(props: EvidenceValueProps): JSX.Element {
  return (
    <EvidenceFieldBoundary>
      <EvidenceInner {...props} />
    </EvidenceFieldBoundary>
  );
}
