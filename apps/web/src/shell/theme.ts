/** A resolved theme: "system" is resolved against the OS before it gets here. */
export type ResolvedTheme = "light" | "dark";

/**
 * Apply a resolved mode to <html>: the `.dark` class switches every token in
 * theme.css. `index.html` runs the same logic inline before first paint, so
 * there is no flash of the wrong theme.
 */
export function applyTheme(root: HTMLElement, mode: ResolvedTheme): void {
  root.classList.toggle("dark", mode === "dark");
}
