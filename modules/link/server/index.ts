import type { ProviderHealth, ProviderSpec } from "@deck/module-sdk";

export interface LinkDescriptor {
  label: string;
  href: string;
  icon?: string;
}

export class LinkProvider implements ProviderSpec<LinkDescriptor> {
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
