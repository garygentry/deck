import type { ReactNode } from "react";
import { Button, EmptyState, PageHeader } from "@/ui";
import type { NotEnabledRoute } from "./routes.js";

/**
 * Rendered at the path of a page whose module is off: says so, and names the setting that
 * turns the module on (an env var or a config key), or why else it is off.
 */
export function ModuleNotEnabledPage({ route }: { route: NotEnabledRoute }) {
  const moduleId = route.module?.id ?? route.id.slice(route.id.indexOf(":") + 1, route.id.indexOf("/"));
  return (
    <div data-slot="module-not-enabled-page" className="flex flex-col gap-6">
      <PageHeader title={route.label} />
      <EmptyState
        icon="power-off"
        title={`The ${moduleId} module is not enabled`}
        description={howToEnable(route.module)}
        action={
          <Button asChild variant="outline">
            <a href="/">Go to the portal</a>
          </Button>
        }
      />
    </div>
  );
}

function howToEnable(module: NotEnabledRoute["module"]): ReactNode {
  const enabledBy = module?.enabledBy;
  if (enabledBy !== undefined && "env" in enabledBy) {
    return (
      <>
        Set <code className="font-mono">{enabledBy.env}=true</code> in deck&apos;s environment and restart deck.
      </>
    );
  }
  if (enabledBy !== undefined && "config" in enabledBy) {
    return (
      <>
        Add a <code className="font-mono">{enabledBy.config}</code> section to the estate config and restart deck.
      </>
    );
  }
  return module?.reason ?? "This module is off on this deck instance.";
}
