import { EmptyState, formatTimestamp, KeyValueList, LoadingState, PageHeader, Section, StatusBadge, useProvider } from "@deck/sdk";

import type { Greeting } from "../greeting";

/** The module's page, at /hello: the `hello` provider's greeting. */
export function HelloPage() {
  const { envelope, loading } = useProvider<Greeting>("hello");
  const greeting = envelope?.data ?? null;
  return (
    <div data-slot="hello-page" className="hello:flex hello:flex-col hello:gap-6">
      <PageHeader title="Hello" description="A runtime module built from deck's module template." />
      {loading ? (
        <LoadingState label="Loading the greeting…" />
      ) : greeting === null ? (
        <EmptyState title="No greeting yet" description="The hello provider has not answered. Check the module's health in /api/health." />
      ) : (
        <Section title="Greeting">
          {/* Styles of the module's own: utilities from @deck/sdk/tailwind, under its prefix. */}
          <p data-slot="hello-greeting" className="hello:mb-4 hello:rounded-md hello:border hello:border-border hello:bg-muted hello:p-4 hello:text-lg">
            {greeting.message}
          </p>
          <KeyValueList
            items={[
              { label: "Status", value: <StatusBadge tone="ok" icon="hello/wave" label="Saying hello" /> },
              { label: "Served", value: formatTimestamp(greeting.servedAt) },
            ]}
          />
        </Section>
      )}
    </div>
  );
}
