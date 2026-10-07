import { createRoot } from "react-dom/client";
import "./styles/app.css";
// Declare the health-header slot BEFORE feature discovery so siblings filling it
// find it declared (else UNKNOWN_SLOT). Order is load-bearing.
import "./shell/health-header/slot.js";
import "./registry/discover.js";
import { App } from "./shell/App.js";
import { installChunkReload } from "./shell/chunk-reload.js";

installChunkReload();

createRoot(document.getElementById("app")!).render(<App />);
