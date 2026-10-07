/* GENERATED from schema/snapshot.schema.json — do not edit; run pnpm types:build */

export type ObservedHost = ({
[k: string]: unknown | undefined
} & ObservedHost1)
/**
 * How completely this host was observed.
 */
export type Coverage = ("collected" | "partial" | "unreachable")
/**
 * Observed running state.
 */
export type ServiceState = ("running" | "stopped" | "degraded" | "unknown")
/**
 * Finding severity shared with validation findings.
 */
export type Severity = ("error" | "warning" | "info")
/**
 * Optional expected value of any JSON type.
 */
export type JsonValue = (string | number | boolean | null | JsonValue1[] | {
[k: string]: JsonValue1 | undefined
})
/**
 * Any value representable in JSON.
 */
export type JsonValue1 = (string | number | boolean | null | JsonValue1[] | {
[k: string]: JsonValue1 | undefined
})
/**
 * Any value representable in JSON.
 */
export type JsonValue2 = (string | number | boolean | null | JsonValue1[] | {
[k: string]: JsonValue1 | undefined
})

/**
 * Observed reality projected from observation and drift outputs without a fresh or stale judgement.
 */
export interface SnapshotDocument {
/**
 * The shared schema contract version.
 */
schemaVersion: 1
/**
 * When this snapshot was produced in RFC 3339 form.
 */
generatedAt: string
/**
 * Observed hosts; absent is equivalent to an empty array.
 */
hosts?: ObservedHost[]
/**
 * Observed services; absent is equivalent to an empty array.
 */
services?: ObservedService[]
/**
 * Drift findings; absent is equivalent to an empty array.
 */
drift?: DriftFinding[]
}
export interface ObservedHost1 {
/**
 * Host name and join key to the config host.
 */
name: string
coverage: Coverage
/**
 * When this host was observed, subject to coverage conditions.
 */
collectedAt?: string
collectors?: Collectors
/**
 * Whether the host answered at all.
 */
reachable?: boolean
/**
 * Observed addresses labelled by network.
 */
addresses?: Address[]
/**
 * Observed operating-system and kernel summary.
 */
os?: {
/**
 * Operating-system name.
 */
name?: string
/**
 * Operating-system version.
 */
version?: string
/**
 * Kernel version.
 */
kernel?: string
}
/**
 * Observed uptime in seconds.
 */
uptimeSeconds?: number
/**
 * Observed containers.
 */
containers?: Container[]
/**
 * Observed guests for hypervisors.
 */
guests?: Guest[]
/**
 * Observed managed configuration files and sync state.
 */
managedConfigs?: ObservedManagedConfig[]
/**
 * Open display-only observed facts outside the structured core.
 */
facts?: {
[k: string]: unknown | undefined
}
}
/**
 * Per-collector outcomes required for partial coverage.
 */
export interface Collectors {
/**
 * Names of collectors that succeeded.
 */
succeeded: string[]
/**
 * Collectors that failed with reasons.
 */
failed: {
/**
 * Collector name.
 */
name: string
/**
 * Reason the collector failed.
 */
reason: string
}[]
}
export interface Address {
/**
 * Network label for this address (e.g. lan, tailnet). An open label — the same vocabulary Estate.domains keys off.
 */
network: string
/**
 * The address on that network.
 */
address: string
/**
 * Whether this is the host's primary address on that network.
 */
primary?: boolean
}
export interface Container {
/**
 * Container name.
 */
name: string
/**
 * Container image reference.
 */
image: string
/**
 * Observed container state.
 */
state: string
}
export interface Guest {
/**
 * Guest id on this hypervisor.
 */
vmid: number
/**
 * Guest name.
 */
name: string
/**
 * Observed guest state.
 */
state: string
}
export interface ObservedManagedConfig {
/**
 * Live configuration file path.
 */
path: string
/**
 * Whether the live file matches its source of truth.
 */
inSync: boolean
}
export interface ObservedService {
/**
 * Host name in the service join key.
 */
host: string
/**
 * Service name in the service join key.
 */
name: string
state: ServiceState
/**
 * Open display-only observed service facts.
 */
facts?: {
[k: string]: unknown | undefined
}
}
export interface DriftFinding {
/**
 * Stable drift-finding id, unique across drift.
 */
id: string
severity: Severity
location: DriftLocation
/**
 * Open category string grouping the finding.
 */
category: string
/**
 * Plain-language description of the drift.
 */
message: string
expected?: JsonValue
observed?: JsonValue2
waiver?: Waiver
}
/**
 * Location of the drift.
 */
export interface DriftLocation {
/**
 * Host on which the drift occurs.
 */
host: string
/**
 * Optional service on that host.
 */
service?: string
/**
 * Optional managed-configuration path.
 */
path?: string
}
/**
 * Optional waiver that labels rather than removes the finding.
 */
export interface Waiver {
/**
 * Reason the finding is waived.
 */
reason: string
/**
 * Identity of who waived the finding.
 */
who: string
/**
 * Optional expiry evaluated by display-time consumers.
 */
until?: string
}
