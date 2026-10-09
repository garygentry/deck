import { copyFileSync } from "node:fs";
import { join } from "node:path";

import { IMPORT_MAP_SPECIFIERS } from "@deck/sdk/lint";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin, type UserConfig } from "vite";

import manifest from "./deck-module.json" with { type: "json" };

/**
 * The module directory the build writes: `dist/<id>/`, named by the module's id, holding
 * deck-module.json, server.mjs, web.js and web.css. Copy it into DECK_MODULES_DIR (or point
 * DECK_MODULES_DIR at dist/). `vite build --outDir <dir>` writes it elsewhere.
 */
const OUT_DIR = `dist/${manifest.id}`;

/**
 * The fixed externals: deck's import map provides exactly these to a web half (react,
 * react-dom, react/jsx-runtime and @deck/sdk), so they are never bundled. They are deck's, not
 * the module's to change: bundling another copy of React breaks hooks, and any other bare
 * import would not resolve in the browser.
 */
const DECK_SHARED = [...IMPORT_MAP_SPECIFIERS];

/** Copy the manifest beside the built entries, wherever the build writes them. */
function copyManifest(): Plugin {
  let outDir = OUT_DIR;
  return {
    name: "deck-module-manifest",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle() {
      copyFileSync("deck-module.json", join(outDir, "deck-module.json"));
    },
  };
}

/** `vite build`: the web half, one ES module (web.js) and its stylesheet (web.css). */
const web: UserConfig = {
  plugins: [tailwindcss(), copyManifest()],
  esbuild: { jsx: "automatic" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    copyPublicDir: false,
    target: "es2022",
    lib: { entry: "src/web/index.tsx", formats: ["es"], fileName: () => "web.js", cssFileName: "web" },
    // One file: deck serves web.js and nothing beside it, so a dynamic import() is inlined
    // rather than split into a chunk.
    rollupOptions: { external: DECK_SHARED, output: { inlineDynamicImports: true } },
  },
};

/** `vite build --mode server`: the server half, with every dependency bundled into server.mjs. */
const server: UserConfig = {
  build: {
    outDir: OUT_DIR,
    emptyOutDir: false,
    copyPublicDir: false,
    target: "es2022",
    ssr: "src/server.ts",
    rollupOptions: { output: { entryFileNames: "server.mjs" } },
  },
  ssr: { noExternal: true },
};

export default defineConfig(({ mode }) => (mode === "server" ? server : web));
