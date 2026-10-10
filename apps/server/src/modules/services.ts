/**
 * The services modules offer one another, scoped to one module host. An offer (from a kind
 * handler or from init) waits until its module has started; a module that never starts (its
 * kind handler failed, its init threw) never publishes. Stopping the host, or a failed start,
 * releases every offer, so nothing outlives the host that made it.
 */
export class ServiceRegistry {
  private readonly pending = new Map<string, Array<{ name: string; impl: unknown }>>();
  private published: Array<{ moduleId: string; name: string; impl: unknown }> = [];

  /** Record `moduleId`'s offer of `name`, visible once {@link publish} runs for it. */
  offer(moduleId: string, name: string, impl: unknown): void {
    const offers = this.pending.get(moduleId) ?? [];
    offers.push({ name, impl });
    this.pending.set(moduleId, offers);
  }

  /** The module has started: its offers become visible, after those of earlier modules. */
  publish(moduleId: string): void {
    for (const { name, impl } of this.pending.get(moduleId) ?? []) this.published.push({ moduleId, name, impl });
    this.pending.delete(moduleId);
  }

  /** The module will not start: drop its offers. */
  drop(moduleId: string): void {
    this.pending.delete(moduleId);
  }

  /** Every published offer of `name` with its module, in publish (init) order. */
  entries(name: string): ReadonlyArray<{ moduleId: string; impl: unknown }> {
    return this.published.filter((offer) => offer.name === name).map(({ moduleId, impl }) => ({ moduleId, impl }));
  }

  /** Release every offer. */
  clear(): void {
    this.pending.clear();
    this.published = [];
  }
}
