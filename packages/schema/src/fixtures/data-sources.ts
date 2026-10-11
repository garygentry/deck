import type { ConfigContribution } from "../compose/compose.js";
import type { JsonObject } from "../types.js";
import alertmanagerInstance from "./data-sources/alertmanager.instance.schema.json" with { type: "json" };
import dockerInstance from "./data-sources/docker.instance.schema.json" with { type: "json" };
import fileTreeInstance from "./data-sources/file-tree.instance.schema.json" with { type: "json" };
import gatusInstance from "./data-sources/gatus.instance.schema.json" with { type: "json" };
import markdownTreeInstance from "./data-sources/markdown-tree.instance.schema.json" with { type: "json" };
import prometheusInstance from "./data-sources/prometheus.instance.schema.json" with { type: "json" };

/**
 * The provider kinds deck's data-source modules declare (`link`, `http-health`, `docker`,
 * `gatus`, `prometheus`, `alertmanager`, `markdown-tree`, `file-tree`, `snapshot`), as the fixtures use
 * them. The modules live in the server, so this library cannot compose them; fixtures are
 * validated with this stand-in instead. It carries each kind's name, `bindable` flag, instance
 * list and instance schema, and the server checks them against the modules' manifests.
 */
export const FIXTURE_DATA_SOURCES: ConfigContribution = {
  id: "fixture-data-sources",
  providerKinds: [
    { kind: "link", bindable: true },
    { kind: "http-health", bindable: true },
    { kind: "docker", bindable: true, instanceSchema: dockerInstance as unknown as JsonObject },
    { kind: "gatus", bindable: true, instanceSchema: gatusInstance as unknown as JsonObject },
    { kind: "prometheus", instanceSchema: prometheusInstance as unknown as JsonObject },
    { kind: "alertmanager", instanceSchema: alertmanagerInstance as unknown as JsonObject },
    { kind: "markdown-tree", bindable: false, instanceList: "sources", instanceSchema: markdownTreeInstance as unknown as JsonObject },
    { kind: "file-tree", bindable: false, instanceList: "sources", instanceSchema: fileTreeInstance as unknown as JsonObject },
    { kind: "snapshot" },
  ],
};
