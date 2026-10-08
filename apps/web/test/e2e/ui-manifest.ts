import type { Page } from "@playwright/test";

export interface ManifestProvider {
  id: string;
  kind: string;
}

/**
 * Rewrite the provider list of the real `GET /api/ui` for a page. The web polls only the
 * providers the UI manifest lists, so a spec that mocks provider envelopes the booted
 * fixture does not register must list them here too (the rest of the manifest stays real).
 *
 * A request superseded by the next navigation (or by the test ending) is disposed while its
 * handler still runs; that request no longer has a reader, so its failure is ignored.
 */
export async function mockUiManifest(
  page: Page,
  providers: (real: readonly ManifestProvider[]) => ManifestProvider[],
): Promise<void> {
  await page.route("**/api/ui", async (route) => {
    let body: { providers: ManifestProvider[] };
    try {
      const response = await route.fetch();
      body = (await response.json()) as { providers: ManifestProvider[] };
    } catch (error) {
      if (isSuperseded(error)) return;
      throw error;
    }
    await route.fulfill({ json: { ...body, providers: providers(body.providers) } }).catch((error: unknown) => {
      if (!isSuperseded(error)) throw error;
    });
  });
}

/** One entry of the manifest's `extensions` list. */
export interface ManifestExtension {
  id: string;
  kind: string;
  module: string;
  slot: string;
  order: number;
  /** The resolved config the web renders the extension with (an entity section's title, section). */
  config?: Record<string, unknown>;
}

/**
 * Rewrite the extension list of the real `GET /api/ui` for a page: add entries for
 * extensions a spec registers in the browser (as the server lists those of a module that is
 * on), or drop a module's entries (as it does for a module that is off).
 */
export async function editManifestExtensions(
  page: Page,
  edit: (real: readonly ManifestExtension[]) => ManifestExtension[],
): Promise<void> {
  await page.route("**/api/ui", async (route) => {
    let body: { extensions: ManifestExtension[] };
    try {
      const response = await route.fetch();
      body = (await response.json()) as { extensions: ManifestExtension[] };
    } catch (error) {
      if (isSuperseded(error)) return;
      throw error;
    }
    await route.fulfill({ json: { ...body, extensions: edit(body.extensions) } }).catch((error: unknown) => {
      if (!isSuperseded(error)) throw error;
    });
  });
}

/** Errors Playwright raises for a request whose page navigated away or closed. */
function isSuperseded(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /has been disposed|has been closed|Route is already handled|Test ended/i.test(message);
}
