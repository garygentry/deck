import type {
  CardRegistration,
  EntityFragmentRegistration,
  PageRegistration,
  SummaryFragmentRegistration,
  SummarySlot,
} from "./registry-types.js";

export type {
  CardRegistration,
  EntityFragmentRegistration,
  EntityRef,
  IconRef,
  PageRegistration,
  SummaryFragmentRegistration,
  SummarySlot,
} from "./registry-types.js";

const DEFAULT_ORDER = 100;

const pages: PageRegistration[] = [];
const cards: CardRegistration<unknown>[] = [];
const entityFragments: EntityFragmentRegistration[] = [];
const summaryFragments = new Map<string, SummaryFragmentRegistration<unknown>[]>();
const declaredSlots = new Set<string>();

export class RegistrationError extends Error {
  constructor(
    readonly code:
      | "MISSING_FIELD"
      | "DUPLICATE_ID"
      | "UNKNOWN_SLOT"
      | "DUPLICATE_SLOT",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

function requireString(value: unknown, field: string, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RegistrationError(
      "MISSING_FIELD",
      `${context}: "${field}" must be a non-empty string`,
    );
  }
}

/** A function component or class, or a React object component (lazy, memo, forwardRef). */
function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function requireComponent(value: unknown, context: string): void {
  if (!isComponent(value)) {
    throw new RegistrationError("MISSING_FIELD", `${context}: "component" must be a component`);
  }
}

function byOrderThenId(
  left: { id: string; order?: number },
  right: { id: string; order?: number },
): number {
  const leftOrder = left.order ?? DEFAULT_ORDER;
  const rightOrder = right.order ?? DEFAULT_ORDER;
  return leftOrder !== rightOrder
    ? leftOrder - rightOrder
    : left.id < right.id
      ? -1
      : left.id > right.id
        ? 1
        : 0;
}

export function registerPage(registration: PageRegistration): void {
  requireString(registration.id, "id", "registerPage");
  requireString(registration.path, "path", "registerPage");
  requireString(registration.label, "label", "registerPage");
  requireComponent(registration.component, `registerPage(${registration.id})`);
  if (pages.some(({ id }) => id === registration.id)) {
    throw new RegistrationError("DUPLICATE_ID", `registerPage: duplicate page id "${registration.id}"`);
  }
  pages.push(registration);
}

export function registerCard<T = unknown>(registration: CardRegistration<T>): void {
  requireString(registration.id, "id", "registerCard");
  requireString(registration.slot, "slot", "registerCard");
  requireComponent(registration.component, `registerCard(${registration.id})`);
  if (cards.some(({ id }) => id === registration.id)) {
    throw new RegistrationError("DUPLICATE_ID", `registerCard: duplicate card id "${registration.id}"`);
  }
  cards.push(registration as CardRegistration<unknown>);
}

export function registerEntityFragment(registration: EntityFragmentRegistration): void {
  requireString(registration.id, "id", "registerEntityFragment");
  if (registration.entity !== "host" && registration.entity !== "service") {
    throw new RegistrationError(
      "MISSING_FIELD",
      `registerEntityFragment(${registration.id}): "entity" must be "host" | "service"`,
    );
  }
  requireComponent(registration.component, `registerEntityFragment(${registration.id})`);
  if (entityFragments.some(({ id }) => id === registration.id)) {
    throw new RegistrationError(
      "DUPLICATE_ID",
      `registerEntityFragment: duplicate fragment id "${registration.id}"`,
    );
  }
  entityFragments.push(registration);
}

export function defineSummarySlot<P>(options: { slotId: string }): SummarySlot<P> {
  requireString(options.slotId, "slotId", "defineSummarySlot");
  if (declaredSlots.has(options.slotId)) {
    throw new RegistrationError(
      "DUPLICATE_SLOT",
      `defineSummarySlot: slot "${options.slotId}" already declared`,
    );
  }
  declaredSlots.add(options.slotId);
  summaryFragments.set(options.slotId, []);
  return { slotId: options.slotId };
}

export function registerSummaryFragment<P>(
  slot: SummarySlot<P>,
  registration: SummaryFragmentRegistration<NoInfer<P>>,
): void {
  if (!slot || !declaredSlots.has(slot.slotId)) {
    throw new RegistrationError(
      "UNKNOWN_SLOT",
      `registerSummaryFragment: slot "${slot?.slotId}" was never declared via defineSummarySlot`,
    );
  }
  requireString(registration.id, "id", "registerSummaryFragment");
  requireComponent(registration.component, `registerSummaryFragment(${registration.id})`);
  const fragments = summaryFragments.get(slot.slotId)!;
  if (fragments.some(({ id }) => id === registration.id)) {
    throw new RegistrationError(
      "DUPLICATE_ID",
      `registerSummaryFragment: duplicate fragment id "${registration.id}" in slot "${slot.slotId}"`,
    );
  }
  fragments.push(registration as SummaryFragmentRegistration<unknown>);
}

export function getPages(): readonly PageRegistration[] {
  return [...pages].sort(byOrderThenId);
}

export function getCards(slot: string): readonly CardRegistration<unknown>[] {
  return cards.filter((card) => card.slot === slot).sort(byOrderThenId);
}

export function getEntityFragments(
  entity: "host" | "service",
  slot?: string,
): readonly EntityFragmentRegistration[] {
  return entityFragments
    .filter((fragment) => fragment.entity === entity && (slot === undefined || fragment.slot === slot))
    .sort(byOrderThenId);
}

export function getSummaryFragments<P>(
  slot: SummarySlot<P>,
): readonly SummaryFragmentRegistration<P>[] {
  return [...(summaryFragments.get(slot.slotId) ?? [])].sort(byOrderThenId) as SummaryFragmentRegistration<P>[];
}
