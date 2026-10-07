/**
 * Pure keyboard-intent primitives for the confirm/run interaction and audit detail.
 *
 * Mirrors `drift-and-coverage/keyboard.ts`: pure functions that never touch the DOM,
 * read live state, or filter by control origin. The mounted component owns
 * event-target filtering (e.g. not hijacking Enter inside a typed-confirm field until
 * it matches) and applying the intent.
 */

/** Resolved single-key intent for the confirm/run interaction. */
export type ActionKeyIntent = "cancel" | "submit" | "none";

/** Minimal keyboard-event shape consumed by the resolver. */
export type ActionKeyEvent = Readonly<
  Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">
>;

/**
 * Map one keyboard event to an intent:
 *  - Escape → "cancel"  (abandon the confirm step / close a detail view)
 *  - Enter  → "submit"  (activate the armed run; the mounted handler still checks
 *                        isRunArmed(...) and whether focus is in a multi-line field)
 *  - otherwise → "none"
 * Any Ctrl/Meta chord yields "none" so native shortcuts are never hijacked.
 */
export function resolveActionIntent(event: ActionKeyEvent): ActionKeyIntent {
  if (event.ctrlKey || event.metaKey) {
    // Every modifier chord stays with the browser so native shortcuts are never
    // hijacked.
    return "none";
  }

  switch (event.key) {
    case "Escape":
      return "cancel";
    case "Enter":
      return "submit";
    default:
      return "none";
  }
}

/**
 * True when a resolved-and-handled intent should suppress the browser default.
 * "none" is never handled and must not preventDefault so unrelated keys behave
 * normally.
 */
export function shouldPreventActionDefault(intent: ActionKeyIntent): boolean {
  return intent !== "none";
}
