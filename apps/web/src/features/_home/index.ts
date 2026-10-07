import { registerCard, registerPage } from "../../registry/registry.js";
import { HomePage } from "./HomePage.js";
import { PortalGrid } from "./PortalGrid.js";

// Portal owns "/" and the nav; Home stays registered but hidden.
registerPage({
  id: "home",
  path: "/",
  label: "Home",
  icon: "house",
  component: HomePage,
  order: 0,
  nav: false,
});
registerCard({ id: "portal-links", slot: "portal", component: PortalGrid });
