/* GENERATED from primary/00-base.yaml by scripts/build-fixtures.ts — do not edit; run pnpm fixtures:build */

import type { JsonObject } from "../../types.js";

export const base = {
  "schemaVersion": 2,
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
      ]
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
      ]
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
      "purpose": "Invented unclassified device"
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
      }
    },
    {
      "name": "beacon",
      "host": "dapple",
      "kind": "systemd",
      "purpose": "Invented metrics relay",
      "status": "active"
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
      "status": "active"
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
      "status": "active"
    }
  ]
} satisfies JsonObject;
