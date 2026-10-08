import type { ReactNode } from "react";
import { Button } from "@/ui";
import { useHomePage } from "./use-home.js";

/** A way back from a dead end: a link to `/` while some page is home, else none. */
export function useHomeAction(): ReactNode | undefined {
  if (useHomePage() === undefined) return undefined;
  return (
    <Button asChild variant="outline">
      <a href="/">Go to the home page</a>
    </Button>
  );
}
