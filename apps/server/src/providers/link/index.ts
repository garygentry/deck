import type { Provider, ProviderHealth } from "../../contract/index.js";
import { register } from "../registry.js";

export interface LinkDescriptor {
  label: string;
  href: string;
  icon?: string;
}

export class LinkProvider implements Provider<LinkDescriptor> {
  readonly kind = "link";

  constructor(
    readonly id: string,
    private readonly descriptor: LinkDescriptor,
  ) {}

  async health(): Promise<ProviderHealth> {
    return { ok: true };
  }

  async fetch(): Promise<LinkDescriptor> {
    return this.descriptor;
  }
}

export function registerLink(id: string, descriptor: LinkDescriptor): void {
  register(new LinkProvider(id, descriptor));
}
