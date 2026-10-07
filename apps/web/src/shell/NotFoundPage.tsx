import { Button, EmptyState } from "@/ui";

/** Rendered for any path no page registration matches. */
export function NotFoundPage() {
  return (
    <div data-slot="not-found-page" className="py-10">
      <EmptyState
        icon="search-x"
        title="Page not found"
        description="Nothing is registered at this address."
        action={
          <Button asChild variant="outline">
            <a href="/">Go to the portal</a>
          </Button>
        }
      />
    </div>
  );
}
