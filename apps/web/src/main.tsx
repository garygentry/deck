import { createRoot } from "react-dom/client";
import "./styles/app.css";
import "./registry/discover.js";
import { App } from "./shell/App.js";
import { installChunkReload } from "./shell/chunk-reload.js";

installChunkReload();

createRoot(document.getElementById("app")!).render(<App />);
