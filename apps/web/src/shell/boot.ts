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

let frameOrigins: { value: readonly string[] | undefined } | undefined;

/**
 * The origins this page's Content-Security-Policy lets it frame (`DeckBoot.frameOrigins`), as
 * the server wrote them when it served the page; `undefined` without a boot object (the dev
 * server, which sends no policy). Read once: the policy is fixed for the page's life.
 */
export function bootFrameOrigins(): readonly string[] | undefined {
  frameOrigins ??= { value: typeof document === "undefined" ? undefined : readDeckBoot(document).frameOrigins };
  return frameOrigins.value;
}

let frameSelf: { value: readonly string[] } | undefined;

/**
 * The embed origins the server left out of this page's policy as deck's own (`DeckBoot.frameSelf`):
 * deck as the page was requested, behind a proxy, say. Empty without any. Read once.
 */
export function bootFrameSelf(): readonly string[] {
  frameSelf ??= { value: typeof document === "undefined" ? [] : readDeckBoot(document).frameSelf ?? [] };
  return frameSelf.value;
}
