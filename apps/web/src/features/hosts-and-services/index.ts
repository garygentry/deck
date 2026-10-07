import { registerPage } from "../../registry/registry.js";
import { HostDetailPage, HostsPage, ServiceDetailPage, ServicesPage } from "./pages.js";

// Exactly four inventory registrations: the visible Hosts and Services lists in
// primary navigation, plus the two navigation-hidden dynamic detail routes that
// remain directly and link-routable.
registerPage({
  id: "page:inventory/hosts",
  path: "/hosts",
  label: "Hosts",
  icon: "server",
  group: "Inventory",
  component: HostsPage,
});
registerPage({
  id: "page:inventory/services",
  path: "/services",
  label: "Services",
  icon: "boxes",
  group: "Inventory",
  component: ServicesPage,
});
registerPage({
  id: "page:inventory/host-detail",
  path: "/hosts/:name",
  label: "Host",
  component: HostDetailPage,
  nav: false,
});
registerPage({
  id: "page:inventory/service-detail",
  path: "/services/:host/:name",
  label: "Service",
  component: ServiceDetailPage,
  nav: false,
});
