import { statusTone, type StatusMapData } from "@deck/module-sdk";
import { createContext, useContext } from "react";
import { StatusBadge, TONE_ICON, type IconName, type Tone } from "@/ui";

import { useUiManifest } from "../../data/index.js";

/** A toned value's presentation: its tone, the tone's icon, and the value's own text. */
export interface TonePresentation {
  tone: Tone;
  icon: IconName;
}

/** Gives a value's tone under one named status map; `undefined` when it gives none. */
export type ToneOf = (value: unknown) => TonePresentation | undefined;

const NO_TONE: ToneOf = () => undefined;

/** Status maps that replace the manifest's, for widgets rendered outside a config page (the workbench). */
export const StatusMapsOverride = createContext<Readonly<Record<string, StatusMapData>> | null>(null);

/**
 * The status maps the UI manifest publishes (`ui.statusMaps`), by name; none while it loads or
 * when it cannot be read, so values then show untoned. A {@link StatusMapsOverride} wins.
 */
export function useStatusMaps(): Readonly<Record<string, StatusMapData>> {
  const override = useContext(StatusMapsOverride);
  const manifest = useUiManifest();
  if (override !== null) return override;
  const maps = manifest.status === "ready" ? manifest.manifest.statusMaps : undefined;
  return maps !== null && typeof maps === "object" ? maps : {};
}

/**
 * The tone of values under the map `name`. A name the config does not declare (a finding at
 * boot) gives no tone, like no name at all.
 */
export function toneOf(maps: Readonly<Record<string, StatusMapData>>, name: string | undefined): ToneOf {
  if (name === undefined || !Object.hasOwn(maps, name)) return NO_TONE;
  const map = maps[name];
  return (value) => {
    const tone = statusTone(map, value);
    return tone === undefined ? undefined : { tone, icon: TONE_ICON[tone] };
  };
}

/**
 * A value as a status badge: its tone under the map (neutral when it gives none), the tone's
 * icon and the value's text, so the state is never colour alone.
 */
export function ToneBadge({ text, presentation }: { text: string; presentation: TonePresentation | undefined }) {
  const { tone, icon } = presentation ?? { tone: "neutral" as const, icon: TONE_ICON.neutral };
  return <StatusBadge tone={tone} icon={icon} label={text} />;
}
