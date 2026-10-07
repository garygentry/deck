# Snapshot contract reference

The snapshot is the observed-reality document deck reads to populate Hosts,
Services, and Drift.
It records what was observed, without any fresh-or-stale judgement — freshness is
derived at display time from timestamps and the wall clock.

This page is derived from the authoritative JSON Schema at
[`packages/schema/schema/snapshot.schema.json`](../../packages/schema/schema/snapshot.schema.json).
The schema is the source of truth; where this page and the schema differ, the
schema wins.

Timestamps are RFC 3339 (`date-time`) strings throughout.
The top-level document forbids unknown properties, but open `facts` objects and
drift value fields accept arbitrary JSON.

## Envelope

The document has two required keys and three optional arrays.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | integer | yes | Must be the constant `1`. |
| `generatedAt` | string (date-time) | yes | When the snapshot was produced, in RFC 3339 form. |
| `hosts` | array of ObservedHost | no | Absent is equivalent to an empty array. |
| `services` | array of ObservedService | no | Absent is equivalent to an empty array. |
| `drift` | array of DriftFinding | no | Absent is equivalent to an empty array. |

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-02T15:00:00Z",
  "hosts": [],
  "services": [],
  "drift": []
}
```

## Observed hosts

An `ObservedHost` requires `name` and `coverage`; all other fields are optional.
`name` is the join key back to the declared host in the estate config.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Host name; join key to the config host. |
| `coverage` | Coverage | yes | How completely the host was observed. |
| `collectedAt` | string (date-time) | conditional | When the host was observed; see coverage rules below. |
| `collectors` | Collectors | conditional | Per-collector outcomes; required for `partial` coverage. |
| `reachable` | boolean | no | Whether the host answered at all. |
| `addresses` | array of Address | no | Observed addresses labelled by network. |
| `os` | object | no | `name`, `version`, `kernel` — all optional strings. |
| `uptimeSeconds` | integer (≥ 0) | no | Observed uptime in seconds. |
| `containers` | array of Container | no | Observed containers. |
| `guests` | array of Guest | no | Observed guests for hypervisors. |
| `managedConfigs` | array of ObservedManagedConfig | no | Managed configuration files and sync state. |
| `facts` | object | no | Open, display-only facts; arbitrary keys and values. |

### Coverage

`coverage` is an enum with three values, and it governs which timestamp and
collector fields are required.

| Value | Meaning | Field rules |
| --- | --- | --- |
| `collected` | Fully observed. | `collectedAt` is required. |
| `partial` | Some collectors failed. | `collectedAt` and `collectors` are both required. |
| `unreachable` | Host did not answer. | `collectedAt` is forbidden. |

`Collectors` records `succeeded` (an array of collector names) and `failed` (an
array of `{ name, reason }` objects); both keys are required when `collectors` is
present.

### Nested host shapes

| Type | Required fields | Optional fields |
| --- | --- | --- |
| `Address` | `network`, `address` | `primary` (boolean) |
| `Container` | `name`, `image`, `state` | — |
| `Guest` | `vmid` (integer ≥ 1), `name`, `state` | — |
| `ObservedManagedConfig` | `path`, `inSync` (boolean) | — |

`network` is an open label (for example `lan` or `tailnet`), drawn from the same
vocabulary the estate config's domains key off.

## Observed services

An `ObservedService` requires `host`, `name`, and `state`.
`host` and `name` together form the join key to the declared service.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `host` | string | yes | Host name in the service join key. |
| `name` | string | yes | Service name in the service join key. |
| `state` | ServiceState | yes | Observed running state. |
| `facts` | object | no | Open, display-only facts. |

`ServiceState` is one of `running`, `stopped`, `degraded`, or `unknown`.

## Drift findings and waivers

A `DriftFinding` reports one difference between declared intent and observed
reality.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Stable finding id, unique across drift. |
| `severity` | Severity | yes | `error`, `warning`, or `info`. |
| `location` | DriftLocation | yes | Where the drift occurs. |
| `category` | string | yes | Open category string grouping the finding. |
| `message` | string | yes | Plain-language description. |
| `expected` | any JSON | no | Expected value, of any JSON type. |
| `observed` | any JSON | no | Observed value, of any JSON type. |
| `waiver` | Waiver | no | Labels the finding rather than removing it. |

`Severity` is shared with validation findings and is one of `error`, `warning`,
or `info`.

### DriftLocation

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `host` | string | yes | Host on which the drift occurs. |
| `service` | string | no | Service on that host. |
| `path` | string | no | Managed-configuration path. |

### Waiver

A waiver labels a finding as acknowledged; it does not delete it.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `reason` | string | yes | Why the finding is waived. |
| `who` | string | yes | Identity of who waived it. |
| `until` | string (date-time) | no | Optional expiry, evaluated by display-time consumers. |

```json
{
  "id": "drift-warning",
  "severity": "warning",
  "location": { "host": "cirrus", "service": "beacon" },
  "category": "runtime",
  "message": "Replica count differs",
  "expected": [2, "ready"],
  "observed": null,
  "waiver": {
    "reason": "Known transient",
    "who": "operator",
    "until": "2027-01-01T00:00:00Z"
  }
}
```
