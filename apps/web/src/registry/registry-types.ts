import type { FreshnessStamp } from "@deck/server";
import type { ComponentType } from "react";

export type IconRef = string;

export interface EntityRef {
  entity: "host" | "service";
  host: string;
  name?: string;
}

export interface PageRegistration {
  id: string;
  path: string;
  label: string;
  icon?: IconRef;
  component: ComponentType;
  order?: number;
  /** Whether the page appears in primary navigation; defaults to true. */
  nav?: boolean;
  /** Navigation group heading, e.g. "Inventory"; ungrouped pages are listed last. */
  group?: string;
}

export interface CardRegistration<T = unknown> {
  id: string;
  slot: string;
  providerId?: string;
  component: ComponentType<{ data: T | null; freshness: FreshnessStamp }>;
  order?: number;
}

export interface EntityFragmentRegistration {
  id: string;
  entity: "host" | "service";
  slot?: string;
  component: ComponentType<{ entity: EntityRef }>;
  order?: number;
}

export interface SummarySlot<P> {
  slotId: string;
  readonly __payload?: P;
}

export interface SummaryFragmentRegistration<P> {
  id: string;
  component: ComponentType<P>;
  order?: number;
}
