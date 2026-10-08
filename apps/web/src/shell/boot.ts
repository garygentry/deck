import { readDeckBoot } from "@deck/contract";

let home: { value: string | null | undefined } | undefined;

/**
 * The home page id the server wrote into this page's boot object (`DeckBoot.home`): `null`
 * when no page can be home, `undefined` without a boot object (the dev server). Read once.
 */
export function bootHome(): string | null | undefined {
  home ??= { value: typeof document === "undefined" ? undefined : readDeckBoot(document).home };
  return home.value;
}
