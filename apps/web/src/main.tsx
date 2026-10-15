import { createRoot } from "react-dom/client";
import "./styles/app.css";
import "./registry/discover.js";
import { App } from "./shell/App.js";
import { installChunkReload } from "./shell/chunk-reload.js";
import { installStyleNonce } from "./ui/lib/style-nonce.js";

installChunkReload();
installStyleNonce();

createRoot(document.getElementById("app")!).render(<App />);
