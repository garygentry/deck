import type { Backup } from "@deck/schema";
import type { HostState } from "@deck/server";
import type { JSX, ReactNode } from "react";
import {
  ComparisonGrid,
  ErrorState,
  KeyValueList,
  LoadingState,
  Section,
  defineStatusMap,
  type KeyValueItem,
} from "@/ui";
import type { InventoryModel } from "../model.js";
import type { InventoryData } from "../use-inventory-data.js";
import { INVENTORY_MARKER_UI, renderAbsent, renderHostState, renderMarker } from "./HostStateChip.js";
import { SnapshotStatus } from "./SnapshotStatus.js";

// ---------------------------------------------------------------------------
// Shared building blocks of the two detail pages (/hosts/:name and
// /services/:host/:name): the page frame, the intent-beside-reality section,
// the absent-value markers, and the declared-only sections both entities carry.
// ---------------------------------------------------------------------------

/** Whether the committed snapshot can speak for reality at all. */
export type Reality = "available" | "no-snapshot";

/**
 * The absent values, built once. Muted text rather than badges: an absent value
 * is not a status. Each keeps its `data-marker` slug as a stable test hook.
 */
export const ABSENT = {
  notDeclared: renderAbsent(INVENTORY_MARKER_UI["not-declared"]),
  notObserved: renderAbsent(INVENTORY_MARKER_UI["not-observed"]),
  noSnapshot: renderAbsent(INVENTORY_MARKER_UI["no-snapshot"]),
  unspecified: renderAbsent(INVENTORY_MARKER_UI.unspecified),
} as const;

/** The entity annotations shown in the page header (outline badges, as in the lists). */
export const HEADER_MARKERS = {
  undeclared: renderMarker(INVENTORY_MARKER_UI.undeclared, "outline"),
  hidden: renderMarker(INVENTORY_MARKER_UI.hidden, "outline"),
} as const;

/**
 * The reality side of a section with no observed counterpart (or whose
 * observation is absent): `No snapshot` when reality is unavailable, otherwise
 * the given content (`null` lets `IntentReality` say `Not observed`).
 */
export function realitySide(reality: Reality, available: ReactNode | null): ReactNode | null {
  return reality === "no-snapshot" ? ABSENT.noSnapshot : available;
}

/** A reality cell of a paired table: the value, `No snapshot`, or `Not observed`. */
export function realityCell(reality: Reality, value: ReactNode | null): ReactNode {
  if (value !== null) return value;
  return reality === "no-snapshot" ? ABSENT.noSnapshot : ABSENT.notObserved;
}

/** A boolean as explicit Yes/No text rather than a bare checkbox glyph. */
export function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/** One label/value pair, or nothing when the value is absent. */
export type Field = readonly [label: string, value: ReactNode | undefined];

/** Key/value items from `[label, value]` pairs, skipping absent (`undefined`) values. */
export function fieldItems(fields: readonly Field[]): KeyValueItem[] {
  const items: KeyValueItem[] = [];
  for (const [label, value] of fields) {
    if (value !== undefined) items.push({ label, value });
  }
  return items;
}

/** A stacked description list of the present fields. */
export function Fields({ fields }: { fields: readonly Field[] }): JSX.Element {
  return <KeyValueList layout="stacked" items={fieldItems(fields)} />;
}

// ---------------------------------------------------------------------------
// Page frame.
// ---------------------------------------------------------------------------

export interface DetailFrameProps {
  /** `data-slot` of the page root, so the whole page gets Tailwind Preflight. */
  slot: string;
  /** DOM id of the config-error text (it names the error section). */
  configErrorId: string;
  data: InventoryData;
  /** The resolved page, rendered once a model has committed. */
  children: (model: InventoryModel) => ReactNode;
}

/**
 * The detail page frame. Loading never claims not-found; a config failure shows
 * its alert beside the snapshot diagnosis (so it never hides a snapshot
 * failure) and performs no lookup. Only a committed model reaches `children`.
 */
export function DetailFrame({ slot, configErrorId, data, children }: DetailFrameProps): JSX.Element {
  const { configError, snapshot, model, loading } = data;
  if (model !== null) {
    return (
      <div data-slot={slot} className="flex flex-col gap-6">
        {children(model)}
      </div>
    );
  }
  if (loading) {
    return (
      <div data-slot={slot}>
        <LoadingState label="Loading inventory…" preset="detail" />
      </div>
    );
  }
  return (
    <section data-slot={slot} aria-labelledby={configErrorId} className="flex flex-col gap-4">
      <SnapshotStatus snapshot={snapshot} />
      <ErrorState
        title={
          <span id={configErrorId}>
            {"Inventory configuration unavailable: "}
            {configError ?? "Unknown configuration error"}
          </span>
        }
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Intent beside reality.
// ---------------------------------------------------------------------------

export interface IntentRealityProps {
  /** Visible section label and accessible-heading source. */
  label: string;
  /** Declared-intent content, or null when no declaration exists. */
  intent: ReactNode | null;
  /** Observed-reality content, or null when no observation exists. */
  reality: ReactNode | null;
}

/**
 * One labelled detail section with explicit intent and reality sides.
 *
 * Returns `null` only when both sides are null, so an entirely absent section
 * leaves no empty heading. Otherwise the declared intent side always precedes
 * the observed reality side, and a null side reads `Not declared` /
 * `Not observed` rather than a blank card.
 */
export function IntentReality({ label, intent, reality }: IntentRealityProps): JSX.Element | null {
  if (intent === null && reality === null) return null;
  return (
    <Section title={label} headingId={intentRealityId(label)}>
      <ComparisonGrid
        headingLevel={3}
        declared={intent ?? ABSENT.notDeclared}
        observed={reality ?? ABSENT.notObserved}
      />
    </Section>
  );
}

/**
 * A stable DOM id from a fixed caller-supplied English section label. The label
 * is chosen by the page (never entity data), and stripping to `[a-z0-9-]` keeps
 * hostile characters out of the id even defensively.
 */
export function intentRealityId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `intent-reality-${slug === "" ? "section" : slug}`;
}

/**
 * One decoded JSON value as stable display text, never interpreted as markup.
 * `JSON.stringify` returns `undefined` for unsupported roots (a bare `undefined`
 * or a function) and throws on a cyclic value; both fall back to safe literal
 * text so a malformed fact cannot crash the page.
 */
export function formatFactValue(value: unknown): string {
  try {
    const formatted = JSON.stringify(value, null, 2);
    return formatted === undefined ? "Unsupported value" : formatted;
  } catch {
    return "Unable to display value";
  }
}

/** Open observed facts, keys in the caller's order, each value as escaped JSON text. */
export function FactList({ entries }: { entries: readonly (readonly [string, unknown])[] }): JSX.Element {
  return (
    <KeyValueList
      layout="stacked"
      items={entries.map(([key, value]) => ({
        id: key,
        label: <span className="font-mono">{key}</span>,
        value: (
          <pre className="m-0 overflow-x-auto rounded-md bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words">
            {formatFactValue(value)}
          </pre>
        ),
      }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Sections both entities carry.
// ---------------------------------------------------------------------------

export interface FreshnessSectionProps {
  /** `host` or `service`: the heading id is `{entity}-freshness-heading`. */
  entity: "host" | "service";
  hostState: HostState | null;
  /** Extra detail under the state (the host's partial collector outcomes). */
  children?: ReactNode;
}

/** Host collection freshness (inherited by a service); distinct from the provider status. */
export function FreshnessSection({ entity, hostState, children }: FreshnessSectionProps): JSX.Element {
  return (
    <Section title="Freshness" headingId={`${entity}-freshness-heading`}>
      <div>{hostState !== null ? renderHostState(hostState) : ABSENT.noSnapshot}</div>
      {children}
    </Section>
  );
}

/** Declared backup expectations; the snapshot has no observed backup field. */
export function BackupSection({ backup, reality }: { backup: Backup | undefined; reality: Reality }): JSX.Element | null {
  if (backup === undefined) return null;
  return (
    <IntentReality
      label="Backup"
      intent={
        <Fields
          fields={[
            ["Expected", yesNo(backup.expected)],
            ["Schedule", backup.schedule],
            ["Target", backup.target],
            ["Notes", backup.notes],
          ]}
        />
      }
      reality={realitySide(reality, null)}
    />
  );
}

/** Declared secret ids only, rendered literally; there is no resolver or lookup. */
export function SecretsSection({ secrets, reality }: { secrets: readonly string[] | undefined; reality: Reality }): JSX.Element | null {
  if (secrets === undefined || secrets.length === 0) return null;
  return (
    <IntentReality
      label="Secrets"
      intent={
        <ul className="flex flex-col gap-1 text-sm">
          {secrets.map((secretId, index) => (
            <li key={`${secretId}:${index}`}>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{secretId}</code>
            </li>
          ))}
        </ul>
      }
      reality={realitySide(reality, null)}
    />
  );
}

/** A declared presentation link. */
export interface DeclaredLink {
  title: string;
  href: string;
}

/** Declared presentation links: plain anchors (same tab, as declared). */
export function LinksSection({ links, reality }: { links: readonly DeclaredLink[] | undefined; reality: Reality }): JSX.Element | null {
  if (links === undefined || links.length === 0) return null;
  return (
    <IntentReality
      label="Links"
      intent={
        <ul className="flex flex-col gap-1 text-sm">
          {links.map((link, index) => (
            <li key={`${link.href}:${index}`}>
              <a
                href={link.href}
                className="rounded-sm font-medium break-all text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {link.title}
              </a>
            </li>
          ))}
        </ul>
      }
      reality={realitySide(reality, null)}
    />
  );
}

// ---------------------------------------------------------------------------
// Managed-config sync verdict.
// ---------------------------------------------------------------------------

/** Managed-config sync verdict: icon plus text, never colour alone. */
export const SYNC_UI = defineStatusMap<"in-sync" | "out-of-sync">({
  "in-sync": { tone: "ok", icon: "circle-check", label: "In sync" },
  "out-of-sync": { tone: "warn", icon: "triangle-alert", label: "Out of sync" },
});

/** The sync verdict badge for one observed managed config. */
export function renderSync(inSync: boolean): JSX.Element {
  return renderMarker(SYNC_UI[inSync ? "in-sync" : "out-of-sync"]);
}
