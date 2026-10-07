/* GENERATED from primary/00-base.yaml + 10-overlay.yaml by scripts/build-fixtures.ts — do not edit; run pnpm fixtures:build */

import type { DeckConfigDocument } from "../../types.js";

export const merged = {
  "schemaVersion": 1,
  "estate": {
    "name": "lantern-estate",
    "domains": {
      "lan": "lantern.invalid",
      "tailnet": "lantern-tail.invalid",
      "mgmt": "lantern-mgmt.invalid"
    },
    "timezone": "Etc/UTC"
  },
  "hosts": [
    {
      "name": "azurite",
      "kind": "bare-metal",
      "purpose": "Invented fixture hypervisor alpha",
      "addresses": [
        {
          "network": "lan",
          "address": "192.0.2.10",
          "primary": true
        },
        {
          "network": "tailnet",
          "address": "100.64.10.10"
        },
        {
          "network": "mgmt",
          "address": "198.51.100.10"
        }
      ],
      "access": {
        "reachable": true,
        "method": "ssh",
        "port": 22,
        "user": "fixture"
      },
      "backup": {
        "expected": true,
        "schedule": "nightly",
        "target": "archive-alpha"
      },
      "managedConfigs": [
        {
          "path": "/etc/lantern/azurite.conf",
          "source": "configs/azurite.conf"
        }
      ],
      "stacksRoot": "/srv/lantern/stacks",
      "secrets": [
        "azurite.ssh-key"
      ],
      "bindings": {
        "docker": {
          "endpoint": "fixture-docker"
        },
        "snapshot": {
          "dataset": "fixture-alpha"
        }
      },
      "links": [
        {
          "title": "Alpha Console",
          "href": "https://azurite.lantern.invalid/"
        }
      ]
    },
    {
      "name": "beryl",
      "kind": "bare-metal",
      "purpose": "Invented fixture hypervisor beta",
      "addresses": [
        {
          "network": "lan",
          "address": "192.0.2.11",
          "primary": true
        },
        {
          "network": "mgmt",
          "address": "198.51.100.11"
        }
      ],
      "backup": {
        "expected": true,
        "schedule": "weekly",
        "target": "archive-beta"
      },
      "bindings": {
        "alertmanager": {
          "route": "fixture-alerts"
        }
      }
    },
    {
      "name": "cirrus",
      "kind": "vm",
      "purpose": "Invented application guest",
      "hypervisor": "azurite",
      "vmid": 100,
      "addresses": [
        {
          "network": "lan",
          "address": "192.0.2.20",
          "primary": true
        }
      ],
      "secrets": [
        "cirrus.runtime-ref"
      ],
      "bindings": {
        "gatus": {
          "group": "fixture-apps"
        }
      }
    },
    {
      "name": "dapple",
      "kind": "vm",
      "purpose": "Invented monitoring guest",
      "hypervisor": "beryl",
      "vmid": 100,
      "addresses": [
        {
          "network": "lan",
          "address": "192.0.2.21",
          "primary": true
        }
      ],
      "bindings": {
        "prometheus": {
          "job": "fixture-metrics"
        },
        "http-health": {
          "url": "https://dapple.lantern.invalid/health"
        }
      }
    },
    {
      "name": "ember",
      "kind": "lxc",
      "purpose": "Invented lightweight guest",
      "hypervisor": "azurite",
      "vmid": 101
    },
    {
      "name": "fable",
      "kind": "appliance",
      "purpose": "Invented network appliance",
      "addresses": [
        {
          "network": "mgmt",
          "address": "198.51.100.30",
          "primary": true
        }
      ]
    },
    {
      "name": "glint",
      "kind": "endpoint",
      "purpose": "Invented operator endpoint"
    },
    {
      "name": "hush",
      "kind": "unknown",
      "purpose": "Invented unclassified device",
      "hidden": true
    }
  ],
  "services": [
    {
      "name": "beacon",
      "host": "cirrus",
      "kind": "docker-compose",
      "purpose": "Invented portal service",
      "status": "active",
      "stack": "beacon",
      "secrets": [
        "beacon.session-ref"
      ],
      "backup": {
        "expected": true,
        "schedule": "nightly",
        "target": "archive-alpha"
      },
      "bindings": {
        "link": {
          "href": "https://beacon.lantern.invalid/"
        }
      },
      "links": [
        {
          "title": "Beacon",
          "href": "https://beacon.lantern.invalid/"
        }
      ]
    },
    {
      "name": "beacon",
      "host": "dapple",
      "kind": "systemd",
      "purpose": "Invented metrics relay",
      "status": "active",
      "links": [
        {
          "title": "Relay",
          "href": "https://relay.lantern.invalid/"
        }
      ]
    },
    {
      "name": "kiln",
      "host": "azurite",
      "kind": "appliance",
      "purpose": "Invented management interface",
      "status": "active"
    },
    {
      "name": "lumen",
      "host": "ember",
      "kind": "container",
      "purpose": "Invented document service",
      "status": "active",
      "bindings": {
        "markdown-tree": {
          "source": "fixture-handbook"
        }
      }
    },
    {
      "name": "mirage",
      "host": "fable",
      "kind": "external",
      "purpose": "Invented external catalogue",
      "status": "planned"
    },
    {
      "name": "northstar",
      "host": "azurite",
      "kind": "docker-compose",
      "purpose": "Invented status collector",
      "status": "active"
    },
    {
      "name": "opal",
      "host": "beryl",
      "kind": "systemd",
      "purpose": "Invented alert relay",
      "status": "active"
    },
    {
      "name": "quill",
      "host": "cirrus",
      "kind": "container",
      "purpose": "Invented file browser",
      "status": "active",
      "bindings": {
        "file-tree": {
          "source": "fixture-files"
        }
      },
      "hidden": true
    }
  ],
  "groups": [
    {
      "id": "overview",
      "title": "Fixture Overview",
      "order": 1,
      "icon": "lantern",
      "items": [
        {
          "type": "service",
          "host": "cirrus",
          "name": "beacon",
          "title": "Portal"
        },
        {
          "type": "link",
          "title": "Fixture Guide",
          "href": "https://guide.lantern.invalid/"
        },
        {
          "type": "group",
          "id": "operations",
          "title": "Operations",
          "items": [
            {
              "type": "service",
              "host": "dapple",
              "name": "beacon"
            },
            {
              "type": "link",
              "title": "Operations Guide",
              "href": "https://ops.lantern.invalid/"
            }
          ]
        }
      ]
    }
  ],
  "sources": [
    {
      "id": "fixture-handbook",
      "kind": "markdown-tree",
      "title": "Fixture Handbook",
      "location": {
        "repo": "lantern-docs",
        "ref": "main"
      },
      "include": [
        "guides/**"
      ],
      "exclude": [
        "drafts/**"
      ],
      "owner": {
        "host": "ember",
        "service": "lumen"
      }
    }
  ],
  "integrations": [
    {
      "id": "fixture-metrics",
      "kind": "prometheus",
      "title": "Fixture Metrics",
      "baseUrl": "https://metrics.lantern.invalid/",
      "deepLink": "/targets/{target}",
      "card": {
        "theme": "lantern"
      },
      "credentialEnv": "FIXTURE_METRICS_REF"
    }
  ],
  "actions": [
    {
      "id": "restart-beacon",
      "title": "Restart Fixture Beacon",
      "runner": "fixture-restart-service",
      "confirm": "typed-confirm",
      "params": [
        {
          "name": "reason",
          "type": "string",
          "required": true,
          "default": "routine",
          "description": "Fixture change note"
        },
        {
          "name": "graceful",
          "type": "boolean",
          "default": true
        },
        {
          "name": "mode",
          "type": "enum",
          "values": [
            "safe",
            "quick"
          ],
          "default": null
        }
      ],
      "target": {
        "host": "cirrus",
        "service": "beacon"
      },
      "description": "Exercises the governed action shape"
    }
  ],
  "agents": []
} satisfies DeckConfigDocument;
