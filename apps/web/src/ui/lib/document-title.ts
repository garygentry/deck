/** The app name that ends every document title. */
export const APP_TITLE = "Deck";

/** `"{page} · Deck"`, or just `"Deck"` when there is no page title. */
export function formatDocumentTitle(page?: string | null): string {
  const trimmed = page?.trim() ?? "";
  return trimmed === "" ? APP_TITLE : `${trimmed} · ${APP_TITLE}`;
}
