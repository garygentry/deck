import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { injectImportMap, SHARED_MODULES } from "./src/sdk/import-map";
import { configDefaults, defineConfig } from "vitest/config";
import { PRE_PAINT_MARKER, prePaintScript } from "./src/shell/theme-chain";

/** Inline the pre-paint theme script into index.html, from the one implementation the app uses. */
function prePaintTheme(): Plugin {
  return {
    name: "deck-pre-paint-theme",
    transformIndexHtml(html) {
      if (!html.includes(PRE_PAINT_MARKER)) throw new Error(`index.html lacks ${PRE_PAINT_MARKER}`);
      return html.replace(PRE_PAINT_MARKER, () => prePaintScript());
    },
  };
}

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The import map runtime modules resolve `react`, `react-dom`, `react/jsx-runtime` and
 * `@deck/sdk` through (see src/sdk/import-map.ts). A build adds each shared module as an entry
 * chunk with its exports kept, sharing chunks with the app, and maps each specifier to its
 * hashed file; the dev server maps them to the sources, which it serves on the app's own deps.
 */
function deckImportMap(): Plugin {
  let base = "/";
  return {
    name: "deck-import-map",
    config(_config, { command }) {
      if (command !== "build") return;
      return {
        build: {
          rollupOptions: {
            input: {
              index: fromRoot("./index.html"),
              ...Object.fromEntries(Object.values(SHARED_MODULES).map((source) => [`sdk-${source.split("/").pop()!.replace(/\.[jt]s$/, "")}`, fromRoot(`./${source}`)])),
            },
            // Keep every export of the shared entries: runtime modules import them by name.
            preserveEntrySignatures: "strict",
          },
        },
      };
    },
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const imports: Record<string, string> = {};
        for (const [specifier, source] of Object.entries(SHARED_MODULES)) {
          if (context.bundle === undefined) {
            imports[specifier] = `${base}${source}`;
            continue;
          }
          const chunk = Object.values(context.bundle).find((output) => output.type === "chunk" && output.isEntry && output.facadeModuleId === fromRoot(`./${source}`));
          if (chunk === undefined) throw new Error(`deck-import-map: no entry chunk for ${specifier}`);
          imports[specifier] = `${base}${chunk.fileName}`;
        }
        return injectImportMap(html, imports);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), prePaintTheme(), deckImportMap()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Pin to IPv4 loopback (same reachability as Vite's default localhost bind).
    // Port-conflict detection is per address family: when another process holds
    // 127.0.0.1:5173, an unpinned Vite can still bind ::1:5173 and believe the
    // port is free, so /api requests split across stacks. Pinning IPv4 makes the
    // conflict visible and Vite increments to the next free port. DECK_PROXY_TARGET
    // overrides the API origin when the server runs on a non-default port (DECK_PORT).
    host: "127.0.0.1",
    proxy: {
      "/api": process.env.DECK_PROXY_TARGET ?? "http://127.0.0.1:8788",
      // Runtime modules' web halves, which the server serves: `/modules` and below only.
      "^/modules(/|$)": process.env.DECK_PROXY_TARGET ?? "http://127.0.0.1:8788",
    },
  },
  test: {
    // The Playwright suite under test/e2e uses .spec.ts naming that Vitest's
    // default discovery would otherwise collect. Keep the default unit run
    // (test:unit) browser-free; Playwright owns test/e2e via test:e2e.
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    setupFiles: ["./test/support/setup.ts"],
    // Registration tests import a feature's whole module graph (now including
    // @/ui), which can pass 5s on a loaded host; 15s still catches real hangs.
    testTimeout: 15_000,
  },
});
