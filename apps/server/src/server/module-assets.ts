import type { UiModuleWeb } from "@deck/module-sdk";
import type { Context, Hono } from "hono";

import { RUNTIME_MANIFEST_FILE, WEB_SCRIPT_FILE, WEB_STYLES_FILE, type RuntimeWebAssets, type WebAsset } from "../modules/runtime.js";

/** The root path runtime modules' web halves are served under: `/modules/<id>/<file>`. */
export const MODULE_ASSETS_PATH = "/modules";


/**
 * The web halves deck serves: those of loaded runtime modules the module plan enables. The one
 * source for both `/modules/<id>/…` and `UiModule.web`, so a module the manifest offers a web
 * half for is exactly one whose files answer, and every other module's answer 404.
 */
export function servedWebModules(
  web: ReadonlyMap<string, RuntimeWebAssets>,
  plan: readonly { readonly id: string; readonly enabled: boolean }[],
): ReadonlyMap<string, RuntimeWebAssets> {
  const enabled = new Set(plan.filter((entry) => entry.enabled).map((entry) => entry.id));
  return new Map([...web].filter(([id]) => enabled.has(id)));
}

/** Where the web shell loads a served module's web half from. */
export function webEntryOf(id: string, assets: RuntimeWebAssets): UiModuleWeb {
  return {
    script: `${MODULE_ASSETS_PATH}/${id}/${WEB_SCRIPT_FILE}`,
    ...(assets.styles === undefined ? {} : { styles: `${MODULE_ASSETS_PATH}/${id}/${WEB_STYLES_FILE}` }),
  };
}

/**
 * Serve `GET /modules/<id>/{web.js,web.css,deck-module.json}` for the served web halves, from
 * the bytes read at load. Anything else under `/modules` is a plain 404, never the SPA shell:
 * mount this before the static files and the SPA fallback.
 */
export function mountModuleAssets(app: Hono, served: ReadonlyMap<string, RuntimeWebAssets>): void {
  const handler = (context: Context) => {
    const parts = context.req.path.slice(MODULE_ASSETS_PATH.length + 1).split("/");
    const assets = parts.length === 2 ? served.get(parts[0]!) : undefined;
    const asset = assets === undefined ? undefined : assetOf(assets, parts[1]!);
    if (asset === undefined) return context.text("404 Not Found", 404);
    const etag = `"${asset.sha256}"`;
    const headers = {
      ETag: etag,
      // Revalidated on every load; the bytes change only when deck restarts with a new module.
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    if (context.req.header("If-None-Match")?.split(",").some((tag: string) => tag.trim() === etag) === true) return new Response(null, { status: 304, headers });
    return new Response(asset.body as Uint8Array<ArrayBuffer>, { headers: { ...headers, "Content-Type": asset.type } });
  };
  app.get(MODULE_ASSETS_PATH, handler);
  app.get(`${MODULE_ASSETS_PATH}/*`, handler);
}

/** The file `name` of a web half, with its content type; undefined for any other name. */
function assetOf(assets: RuntimeWebAssets, name: string): (WebAsset & { type: string }) | undefined {
  // Read per request (runtime.ts and this module import each other through the app).
  const files: Record<string, [WebAsset | undefined, string]> = {
    [WEB_SCRIPT_FILE]: [assets.script, "text/javascript; charset=utf-8"],
    [WEB_STYLES_FILE]: [assets.styles, "text/css; charset=utf-8"],
    [RUNTIME_MANIFEST_FILE]: [assets.manifest, "application/json; charset=utf-8"],
  };
  const [asset, type] = Object.hasOwn(files, name) ? files[name]! : [undefined, ""];
  return asset === undefined ? undefined : { ...asset, type };
}
