import { EmptyState } from "@/ui";
import { useHomeAction } from "./home-action.js";

/** Rendered for any path no page registration matches. */
export function NotFoundPage() {
  const action = useHomeAction();
  return (
    <div data-slot="not-found-page" className="py-10">
      <EmptyState
        icon="search-x"
        title="Page not found"
        description="Nothing is registered at this address."
        action={action}
      />
    </div>
  );
}
