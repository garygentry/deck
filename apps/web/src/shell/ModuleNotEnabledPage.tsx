import type { UiModuleSwitch } from "@deck/module-sdk";
import { Fragment, type ReactNode } from "react";
import { EmptyState, PageHeader } from "@/ui";
import { useHomeAction } from "./home-action.js";
import type { NotEnabledRoute } from "./routes.js";

/**
 * Rendered at the path of a page whose module is off: says so, and names every setting that
 * turns the module on (env vars and config keys), or why else it is off.
 */
export function ModuleNotEnabledPage({ route }: { route: NotEnabledRoute }) {
  const action = useHomeAction();
  return (
    <div data-slot="module-not-enabled-page" className="flex flex-col gap-6">
      <PageHeader title={route.label} />
      <EmptyState
        icon="power-off"
        title={`The ${route.module} module is not enabled`}
        description={howToEnable(route)}
        action={action}
      />
    </div>
  );
}

function howToEnable({ enabledBy, reason }: NotEnabledRoute): ReactNode {
  if (enabledBy.length === 0) return reason ?? "This module is off on this deck instance.";
  const steps = [...enabledBy.map((entry, index) => step(entry, index === 0)), "restart deck"];
  // "Set A, add B and restart deck."
  return (
    <>
      {steps.map((part, index) => (
        <Fragment key={index}>
          {index === 0 ? "" : index === steps.length - 1 ? " and " : ", "}
          {part}
        </Fragment>
      ))}
      .
    </>
  );
}

function step(entry: UiModuleSwitch, first: boolean): ReactNode {
  if ("env" in entry) {
    return (
      <>
        {first ? "Set" : "set"} <code className="font-mono">{entry.env}=true</code> in deck&apos;s environment
      </>
    );
  }
  return (
    <>
      {first ? "Add" : "add"} a <code className="font-mono">{entry.config}</code> section to the estate config
    </>
  );
}
