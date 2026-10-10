/** Below a widget's items when it shows fewer than its value holds: never a silent cut. */
export function Truncated({ shown, total, noun = "" }: { shown: number; total: number; noun?: string }) {
  if (shown >= total) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      Showing the first {shown} of {total}
      {noun === "" ? "" : ` ${noun}`}.
    </p>
  );
}
