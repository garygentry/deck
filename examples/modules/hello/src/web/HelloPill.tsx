import { HealthPill, useProvider } from "@deck/sdk";

import type { Greeting } from "../greeting";

/** The module's header pill: a link to its page, once the provider has answered. */
export function HelloPill() {
  const { envelope } = useProvider<Greeting>("hello");
  if (envelope?.data === undefined || envelope.data === null) return null;
  return <HealthPill tone="ok" icon="hello/wave" label="Hello" href="/hello" />;
}
