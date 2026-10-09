// The web half. deck's page maps `react`, `react-dom`, `react/jsx-runtime` and `@deck/sdk` to
// its own modules with an import map, so the build leaves those imports as they are
// (vite.config.ts) and these components share deck's React, data cache and look. Everything
// else is bundled into the one web.js deck serves.
import { defineWebModule, type WebModuleManifest } from "@deck/sdk";

import manifest from "../../deck-module.json";
import { HelloPage } from "./HelloPage";
import { HelloPill } from "./HelloPill";
import "./web.css";

// deck checks at load that this manifest's id, version and deckApi are the server's.
export default defineWebModule(manifest as WebModuleManifest, { components: { HelloPage, HelloPill } });
