import { BootFatalError, type JsonObject, type ProviderKindContext, type ProviderOffer } from "@deck/module-sdk";
import { estateBindings, type EstateBinding } from "@deck/schema";

import type { DeckConfig } from "../contract/index.js";
import { builtinKindHandlers } from "../modules/builtin.js";
import type { KindRuntime } from "../modules/host.js";
import { hasProvider, register } from "./registry.js";

interface Registration {
  id: string;
  kind: string;
  order: number;
  /** The module whose kind handler offered it. */
  moduleId: string;
  /**
   * The id came from the estate (a binding's own `id`, or the kernel's `<kind>:<owner>`), or is
   * a module's `fixedId`, not chosen freely by the module: a clash with another estate id stays
   * fatal, as before modules.
   */
  estateId?: boolean;
  /** Which handler offered it, for attributing a clash. */
  handler: "binding" | "instances";
  runtime: KindRuntime;
  register(): void;
}

type Offer = ProviderOffer;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a handler's return value is not a list of provider offers of `kind`, or null. */
function offersProblem(value: unknown, kind: string): string | null {
  if (!Array.isArray(value)) return `returned ${value === null ? "null" : typeof value}, not a list of offers`;
  for (const [index, offer] of value.entries()) {
    const provider = isObject(offer) ? (offer as { provider?: unknown }).provider : undefined;
    if (
      typeof provider !== "object" || provider === null ||
      typeof (provider as { id?: unknown }).id !== "string" ||
      typeof (provider as { kind?: unknown }).kind !== "string" ||
      typeof (provider as { fetch?: unknown }).fetch !== "function" ||
      typeof (provider as { health?: unknown }).health !== "function"
    ) {
      return `returned an offer at index ${index} without a provider (id, kind, fetch, health)`;
    }
    const offered = (provider as { kind: string }).kind;
    if (offered !== kind) return `offered a provider of kind "${offered}" at index ${index}; a handler may offer only its own kind`;
  }
  return null;
}

/**
 * Run one kind handler, isolating its module: a handler that throws or returns something
 * other than a list of offers fails its module (none of its offers are registered) and
 * yields null. Failures are attributed to the module and kind. A built-in's
 * {@link BootFatalError} is rethrown instead, failing boot.
 */
function runHandler(
  runtime: KindRuntime,
  failed: Set<string>,
  name: "binding" | "instances",
  call: () => unknown,
): readonly Offer[] | null {
  if (failed.has(runtime.moduleId)) return null;
  let problem: string | null;
  let detail: string | undefined;
  let result: unknown;
  try {
    result = call();
    problem = offersProblem(result, runtime.kind);
  } catch (error) {
    if (error instanceof BootFatalError && runtime.builtin) throw error;
    const thrown = error instanceof Error ? error.message : String(error);
    // What another module's code threw (a path, a value) stays in the log; the public reason is fixed.
    if (runtime.builtin) problem = `threw: ${thrown}`;
    else [problem, detail] = ["threw", thrown];
  }
  if (problem === null) return result as readonly Offer[];
  failed.add(runtime.moduleId);
  runtime.fail(`kind "${runtime.kind}": ${name} handler ${problem}`, detail);
  return null;
}

/**
 * Queue the providers a module's handler offers for one host or service binding, under the
 * id config validation checks for uniqueness ({@link estateBindings}).
 */
function collectBinding(
  registrations: Registration[],
  failed: Set<string>,
  runtime: KindRuntime,
  context: ProviderKindContext,
  { id, owner, value: raw }: EstateBinding,
): void {
  const handler = runtime.handler.binding;
  if (handler === undefined) return;
  const order = typeof raw.order === "number" ? raw.order : 0;
  const value = deepFreeze(structuredClone(raw)) as JsonObject;
  const offers = runHandler(runtime, failed, "binding", () => handler({ id, owner, value, env: context.env }, context));
  for (const offer of offers ?? []) {
    registrations.push({
      id: offer.provider.id,
      kind: runtime.kind,
      order,
      moduleId: runtime.moduleId,
      estateId: offer.provider.id === id,
      handler: "binding",
      runtime,
      register: () => adopt(runtime, offer),
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Register one offered provider and hand its handle to the module that offered it. */
function adopt(runtime: KindRuntime, offer: Offer): void {
  runtime.adopt(register(offer.provider, offer.timing, undefined, runtime.static ? { static: true } : undefined));
}

/**
 * Translate estate declarations into providers, then register by (order, id).
 *
 * Each provider kind a module declares is handled by that module (`kinds`, the enabled
 * modules' handlers; by default the built-in modules'): its `instances` handler gets every
 * `integrations[]` (or `sources[]`) entry of the kind, and its `binding` handler each host
 * and service binding of the kind. A handler that throws or returns no list of offers
 * disables its module: none of that module's providers are registered. A provider that keeps
 * its instance's or binding's own id is an estate id: a duplicate fails boot
 * (PROVIDER_DUPLICATE_ID); any other taken module-chosen id disables the offering module. An
 * `instances` offer marked `fixedId` by a built-in module (a
 * public id clients address literally) is reserved like an estate id: another estate provider
 * with that id fails boot with PROVIDER_DUPLICATE_ID. `fixedId` is ignored on binding offers
 * and on other modules' offers.
 *
 * A binding of a kind no module handles registers nothing; config validation reports it
 * (PROVIDER_KIND_UNKNOWN, PROVIDER_KIND_DISABLED or PROVIDER_BINDING_UNSUPPORTED).
 *
 * Every handler sees the estate as a deep-frozen copy of `config` (`context.estate`).
 *
 * @throws {BootFatalError} When a built-in module's handler throws one: a deployment setting
 * deck cannot start with. Its message is the module's, kept free of secrets.
 */
export function registerAllProviders(
  config: DeckConfig,
  kinds: ReadonlyMap<string, KindRuntime> = builtinKindHandlers(config),
): void {
  const registrations: Registration[] = [];

  // One frozen estate for every handler, and one context per kind that carries it.
  const estate = deepFreeze(structuredClone(config)) as unknown as Readonly<JsonObject>;
  const contexts = new Map<KindRuntime, ProviderKindContext>();
  const contextOf = (runtime: KindRuntime): ProviderKindContext => {
    let context = contexts.get(runtime);
    if (context === undefined) {
      context = Object.freeze({ ...runtime.context, estate });
      contexts.set(runtime, context);
    }
    return context;
  };

  const failed = new Set<string>();
  const instanceOffers: Array<{ runtime: KindRuntime; offer: Offer }> = [];
  for (const kind of kinds.values()) {
    const handler = kind.handler.instances;
    if (handler === undefined) continue;
    const list = (config[kind.instanceList] ?? []) as readonly unknown[];
    const instances = kind.issueInstances(list.filter((item): item is JsonObject => isObject(item) && item.kind === kind.kind));
    const instanceIds = new Set(instances.map((instance) => instance.id).filter((id): id is string => typeof id === "string"));
    for (const offer of runHandler(kind, failed, "instances", () => handler(instances, contextOf(kind))) ?? []) {
      // A provider that keeps its instance's own id follows the estate, and so does a built-in's
      // fixed, public id: a clash fails boot when registered. Any other module's `fixedId` is
      // ignored: its id is module-chosen.
      if (instanceIds.has(offer.provider.id) || (offer.fixedId === true && kind.builtin)) {
        registrations.push({
          id: offer.provider.id,
          kind: kind.kind,
          order: 0,
          moduleId: kind.moduleId,
          estateId: true,
          handler: "instances",
          runtime: kind,
          register: () => adopt(kind, offer),
        });
      } else {
        instanceOffers.push({ runtime: kind, offer });
      }
    }
  }

  for (const binding of estateBindings(config)) {
    const handler = kinds.get(binding.kind);
    if (handler !== undefined) collectBinding(registrations, failed, handler, contextOf(handler), binding);
  }

  // Every handler has run. An id a module chose itself must not collide with a registered
  // provider, an estate id or another module-chosen id: the offering module fails instead of
  // boot. Estate ids (a built-in's `fixedId` among them) clashing with each other fail boot when
  // registered.
  const estateIds = new Set(
    registrations.filter((r) => r.estateId === true && !failed.has(r.moduleId)).map((r) => r.id),
  );
  const claimed = new Set<string>();
  const moduleChosen = [
    ...instanceOffers.map(({ runtime: offerer, offer }) => ({ id: offer.provider.id, runtime: offerer, handler: "instances" as const })),
    ...registrations.filter((r) => r.estateId !== true).map((r) => ({ id: r.id, runtime: r.runtime, handler: r.handler })),
  ];
  for (const { id, runtime: offerer, handler } of moduleChosen) {
    if (failed.has(offerer.moduleId)) continue;
    if (hasProvider(id) || estateIds.has(id) || claimed.has(id)) {
      failed.add(offerer.moduleId);
      offerer.fail(`kind "${offerer.kind}": ${handler} handler offered provider id "${id}", which another provider already has`);
      continue;
    }
    claimed.add(id);
  }

  // Register what modules that did not fail offered.
  for (const { runtime, offer } of instanceOffers) {
    if (!failed.has(runtime.moduleId)) adopt(runtime, offer);
  }
  registrations
    .filter((registration) => !failed.has(registration.moduleId))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .forEach((registration) => registration.register());
}

