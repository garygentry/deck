import { readFileSync } from "node:fs";
import { parse, wcagContrast, formatHex, converter } from "culori";
const css = readFileSync("src/styles/theme.css", "utf8");
const block = (sel) => { const m = css.match(new RegExp(`\\n${sel.replace(".", "\\.")} \\{([^}]*)\\}`)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) out[k] = v.trim(); return out; };
const light = block(":root"), dark = { ...light, ...block(".dark") };
const oklch = converter("oklch");
let fails = 0;
for (const [mode, t] of [["light", light], ["dark", dark]]) {
  const c = (a, b, min, label) => { const r = wcagContrast(parse(t[a]), parse(t[b])); const ok = r >= min; if (!ok) fails++; if (!ok || process.env.V) console.log(`${ok ? "  " : "!!"} ${mode} ${label ?? a + " on " + b} ${r.toFixed(2)} (min ${min})`); };
  for (const tone of ["ok","warn","danger","info","pending","neutral"]) { for (const s of ["background","card","muted"]) c(`status-${tone}-fg`, s, 4.5); c(`status-${tone}-fg`, `status-${tone}-bg`, 4.5); }
  for (const [f, b] of [["foreground","background"],["card-foreground","card"],["muted-foreground","background"],["muted-foreground","card"],["muted-foreground","muted"],["primary-foreground","primary"],["primary","background"],["primary","card"],["destructive-foreground","destructive"],["destructive","card"],["accent-foreground","accent"],["sidebar-foreground","sidebar"],["sidebar-primary-foreground","sidebar-primary"],["sidebar-accent-foreground","sidebar-accent"]]) c(f, b, 4.5);
  for (const s of ["background","card","muted"]) { c("ring", s, 3); c("input", s, 3); }
  const h = (k) => oklch(parse(t[k])).h; const d = Math.abs(h("status-ok-fg") - h("primary")); console.log(`   ${mode} hue ok vs primary ${d.toFixed(0)}°`); if (d < 40) fails++;
}
console.log("fails", fails);
