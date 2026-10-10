/** "true" / "1" (case-insensitive) => true; unset => fallback; anything else => false. */
export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1";
}
