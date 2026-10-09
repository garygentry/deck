import { ErrorState, PageHeader, StatusBadge } from "@/ui";

/** Why a runtime module's web half does not render. */
export type ModuleProblem = "incompatible" | "failed";

const TEXT: Record<ModuleProblem, { label: string; title: string; message: (module: string) => string }> = {
  incompatible: {
    label: "incompatible",
    title: "Module incompatible",
    message: (module) =>
      `The ${module} module's web half was built for another version of deck or of the module, so deck does not run it. Update the module, restart deck and reload this page.`,
  },
  failed: {
    label: "failed to load",
    title: "Module failed to load",
    message: (module) => `The ${module} module's web half failed. Reload this page to try again; the browser console has the cause.`,
  },
};

/** In a runtime module's slot (a pill, a widget, a section): a compact tile naming the module and what went wrong. */
export function ModuleProblemTile({ module, state }: { module: string; state: ModuleProblem }) {
  const text = TEXT[state];
  return (
    <span data-slot="module-problem-tile" className="inline-flex">
      <StatusBadge tone="danger" icon="triangle-alert" label={`${module}: ${text.label}`} title={text.message(module)} />
    </span>
  );
}

/** At a runtime module's page: what went wrong, and what to do. */
export function ModuleProblemPage({ module, state, title }: { module: string; state: ModuleProblem; title?: string }) {
  const text = TEXT[state];
  return (
    <div data-slot="module-problem-page" className="flex flex-col gap-6">
      <PageHeader title={title ?? text.title} />
      <ErrorState title={text.title} message={text.message(module)} />
    </div>
  );
}
