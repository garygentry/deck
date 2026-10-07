import { lazy } from "react";

// Inventory pages (and the table engine they share) load on first visit.
export const HostsPage = lazy(() => import("./hosts/list.js").then((m) => ({ default: m.HostsPage })));
export const ServicesPage = lazy(() =>
  import("./services/list.js").then((m) => ({ default: m.ServicesPage })),
);
export const HostDetailPage = lazy(() =>
  import("./hosts/detail.js").then((m) => ({ default: m.HostDetailPage })),
);
export const ServiceDetailPage = lazy(() =>
  import("./services/detail.js").then((m) => ({ default: m.ServiceDetailPage })),
);
