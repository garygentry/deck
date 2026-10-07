import { registerPage } from "../../registry/registry.js";
import { ActionsPage } from "./pages.js";

// Exactly one eager registration discovered by `import.meta.glob`. The Actions
// surface is a standalone page — no cards, no entity fragments, no summary-slot
// contribution, no shell edit. Registration errors are intentionally uncaught so
// eager discovery fails loudly (mirrors `drift-and-coverage/index.ts`).
registerPage({
  id: "page:actions/overview",
  path: "/actions",
  label: "Actions",
  icon: "zap",
  group: "Operate",
  component: ActionsPage,
});
