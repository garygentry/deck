import { APP_TITLE } from "@/ui";
import { useUiManifest, type UiManifestState } from "../data/index.js";
import { getAllExtensions, type Extension } from "../registry/registry.js";
import { useRegistryVersion } from "../registry/use-registry.js";

/**
 * The extensions a shell slot renders, by order then id. The UI manifest decides which render,
 * at what order and with what config: each of its entries for the slot renders the web
 * extension of the same id and kind (one the web does not bundle is skipped), with the entry's
 * config in place of the registered one. Until the manifest loads the slot is empty;
 * if it cannot be read, the slot renders what the web registered there, so the shell keeps
 * working.
 */
export function placeExtensions(
  slot: string,
  manifest: UiManifestState,
  registered: readonly Extension[],
): readonly Extension[] {
  if (manifest.status === "loading") return [];
  if (manifest.status === "error" || !Array.isArray(manifest.manifest.extensions)) {
    return registered.filter((extension) => extension.enabled && extension.attachTo.slot === slot).sort(byOrderThenId);
  }
  const byId = new Map(registered.map((extension) => [extension.id as string, extension]));
  return manifest.manifest.extensions
    .flatMap((entry) => {
      if (entry.slot !== slot) return [];
      const extension = byId.get(entry.id);
      // The web's own switch still applies: an extension it registered as off never renders.
      if (extension?.component === undefined || !extension.enabled || extension.kind !== entry.kind) return [];
      // The manifest's config is the resolved one (defaults, then overrides): it replaces the
      // registered config wholesale, never merged.
      return [{ ...extension, attachTo: { slot, order: entry.order }, config: Object.freeze({ ...(entry.config ?? {}) }) }];
    })
    .sort(byOrderThenId);
}

function byOrderThenId(a: Extension, b: Extension): number {
  return a.attachTo.order - b.attachTo.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** {@link placeExtensions} for a slot, re-rendering when the manifest loads or the registry changes. */
export function useManifestSlot(slot: string): readonly Extension[] {
  useRegistryVersion();
  return placeExtensions(slot, useUiManifest(), getAllExtensions());
}

/** The brand title from the manifest; deck's when it cannot be read, none while it loads. */
export function brandTitle(manifest: UiManifestState): string | undefined {
  if (manifest.status === "loading") return undefined;
  if (manifest.status === "error") return APP_TITLE;
  const title = manifest.manifest.brand?.title;
  return typeof title === "string" && title.trim() !== "" ? title : APP_TITLE;
}

/** The brand's first character (a whole code point, so an emoji stays intact), upper-cased. */
export function brandInitial(brand: string | undefined): string {
  return brand === undefined ? "" : (Array.from(brand.trim())[0] ?? "").toUpperCase();
}

export function useBrandTitle(): string | undefined {
  return brandTitle(useUiManifest());
}
