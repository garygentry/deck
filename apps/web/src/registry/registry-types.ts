import type { FreshnessStamp } from "@deck/contract";
import type { ComponentType } from "react";

export type IconRef = string;

/** An extension id: `<kind>:<module>/<name>`, e.g. `pill:llm-usage/summary`. */
export type ExtensionId = `${string}:${string}/${string}`;

/**
 * One contribution in the extension tree: a component attached to a slot at an order. Every
 * `register*` blueprint produces one (a page also produces its `nav:` entry). The ids match
 * the ones the server's UI manifest lists, so config can address them.
 */
export interface Extension {
  readonly id: ExtensionId;
  /**
   * What the extension is, matched against its slot's `accepts`: `page`, `nav`, `pill`,
   * `widget` (a card), `entity-section` or `action`.
   */
  readonly kind: string;
  /** The id's module segment. */
  readonly module: string;
  readonly attachTo: { readonly slot: string; readonly order: number };
  readonly enabled: boolean;
  /** Blueprint data the slot host reads (a page's path, a section's name, …). */
  readonly config: Readonly<Record<string, unknown>>;
  /** Absent for entries that render through another one (a nav entry renders its page's link). */
  readonly component?: ComponentType<any>;
}

export interface EntityRef {
  entity: "host" | "service";
  host: string;
  name?: string;
}

export interface PageRegistration {
  /** `page:<module>/<name>`. */
  id: ExtensionId;
  path: string;
  label: string;
  icon?: IconRef;
  component: ComponentType;
  order?: number;
  /** Whether the page appears in primary navigation; defaults to true. */
  nav?: boolean;
  /**
   * Navigation group: a manifest group id (`inventory`) or a built-in group's heading
   * ("Inventory"); used by the fallback nav only. Ungrouped pages are listed last.
   */
  group?: string;
}

export interface CardRegistration<T = unknown> {
  /** `card:<module>/<name>`. */
  id: ExtensionId;
  slot: string;
  providerId?: string;
  component: ComponentType<{ data: T | null; freshness: FreshnessStamp }>;
  order?: number;
}

export interface EntityFragmentRegistration {
  /** `section:<module>/<name>`. */
  id: ExtensionId;
  entity: "host" | "service";
  /** The section's heading. When several fragments share a section, the first one's (by order) shows. */
  title: string;
  /**
   * The section the fragment renders in, e.g. `findings`, shared with every fragment naming it.
   * By default `<module>.<name>` from the id: a section of its own that no other module joins.
   */
  section?: string;
  component: ComponentType<{ entity: EntityRef }>;
  /** Sections render in the order of their first fragment; fragments within one, by order. */
  order?: number;
}

/** One section of an entity page: its name, heading and fragments in order. */
export interface EntitySection {
  readonly section: string;
  readonly title: string;
  readonly fragments: readonly EntityFragmentRegistration[];
}

export interface SummarySlot<P> {
  slotId: string;
  readonly __payload?: P;
}

export interface SummaryFragmentRegistration<P> {
  /** `pill:<module>/<name>`. */
  id: ExtensionId;
  component: ComponentType<P>;
  order?: number;
}
