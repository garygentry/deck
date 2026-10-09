import type { LucideProps } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";
import { getContributedIcon, getContributedIconsVersion, subscribeContributedIcons } from "@/ui/lib/contributed-icons";
import { FALLBACK_ICON, ICONS, isIconName, type IconName } from "@/ui/lib/icons";
import { cn } from "@/ui/lib/utils";

export interface IconProps extends Omit<LucideProps, "ref"> {
  /** A curated `IconName`, a module's contributed icon (`<module>/<name>`), or a config-supplied token that may be neither. */
  name: IconName | (string & {});
  /** Pixel size; defaults to 16. */
  size?: number;
}

const warned = new Set<string>();

/**
 * A decorative icon from the curated set, or one a module contributes as SVG (sanitised; see
 * `contributed-icons.ts`). Always `aria-hidden`: the adjacent text is the accessible label,
 * so an icon is never the only signal. An unknown token renders a neutral circle (and warns
 * once in development) rather than an empty box or the raw token text.
 */
export function Icon({ name, size = 16, ...props }: IconProps) {
  useSyncExternalStore(subscribeContributedIcons, getContributedIconsVersion, getContributedIconsVersion);
  const contributed = isIconName(name) ? undefined : getContributedIcon(name);
  if (contributed !== undefined) return <ContributedIcon svg={contributed} size={size} className={props.className} />;
  let Component = FALLBACK_ICON;
  if (isIconName(name)) {
    Component = ICONS[name];
    // Not for a module's icon (`<module>/<name>`): it may not have arrived with the manifest yet.
  } else if (import.meta.env.DEV && !warned.has(name) && !name.includes("/")) {
    warned.add(name);
    console.warn(`[deck] Unknown icon "${name}"; rendering the fallback icon.`);
  }
  return <Component aria-hidden="true" focusable="false" size={size} data-slot="icon" {...props} />;
}

/** A contributed icon at `size`, its markup already sanitised; it inherits the text colour. */
function ContributedIcon({ svg, size, className }: { svg: SVGSVGElement; size: number; className?: string | undefined }) {
  const markup = useMemo(() => {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("width", String(size));
    copy.setAttribute("height", String(size));
    copy.setAttribute("aria-hidden", "true");
    copy.setAttribute("focusable", "false");
    return copy.outerHTML;
  }, [svg, size]);
  return <span aria-hidden="true" data-slot="icon" className={cn("inline-flex shrink-0", className)} dangerouslySetInnerHTML={{ __html: markup }} />;
}
