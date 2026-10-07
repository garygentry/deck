/* GENERATED from schema/deck.schema.json composed with the built-in contributions — do not edit; run pnpm types:build */

/**
 * What kind of host this is.
 */
export type HostKind = ("bare-metal" | "vm" | "lxc" | "appliance" | "endpoint" | "unknown")
/**
 * Declared lifecycle status rather than observed state.
 */
export type HostStatus = ("active" | "planned" | "retired")
/**
 * An opaque secret reference id, never a secret value.
 */
export type SecretRef = string
/**
 * What kind of service this is.
 */
export type ServiceKind = ("docker-compose" | "systemd" | "appliance" | "container" | "external")
/**
 * Declared lifecycle status rather than observed state.
 */
export type ServiceStatus = ("active" | "planned" | "retired")

/**
 * A merged deck config document containing projected estate inventory and presentation data.
 */
export interface DeckConfigDocument {
/**
 * The config schema version.
 */
schemaVersion: 2
estate: Estate
/**
 * Declared hosts; absent is equivalent to an empty array.
 */
hosts?: Host[]
/**
 * Declared services; absent is equivalent to an empty array.
 */
services?: Service[]
/**
 * Document and configuration source declarations; absent is equivalent to an empty array.
 */
sources?: Source[]
/**
 * External tool integrations; absent is equivalent to an empty array.
 */
integrations?: Integration[]
/**
 * Reserved for presentation settings; no keys are defined yet.
 */
ui?: {

}
/**
 * Module settings keyed by module id; each module contributes its own section schema.
 */
modules?: {
[k: string]: unknown | undefined
}
}
/**
 * Estate-wide identity and conventions.
 */
export interface Estate {
/**
 * Human-readable estate name shown in the shell header.
 */
name: string
/**
 * Per-network domain suffixes keyed by network label.
 */
domains?: {
/**
 * A domain suffix for the network named by the key.
 */
[k: string]: string | undefined
}
/**
 * IANA timezone name used by consumers for display.
 */
timezone?: string
/**
 * Freshness defaults consumers use to derive staleness.
 */
freshness?: {
/**
 * ISO-8601 duration after which a snapshot is considered stale.
 */
snapshotStaleAfter?: string
}
}
export interface Host {
/**
 * Host name, unique across the config.
 */
name: string
kind: HostKind
/**
 * One-line statement of what the host is for.
 */
purpose: string
status?: HostStatus
/**
 * Name of the host that runs this guest; required with vmid.
 */
hypervisor?: string
/**
 * Numeric guest id on its hypervisor; required with hypervisor.
 */
vmid?: number
/**
 * Network addresses labelled by network.
 */
addresses?: Address[]
access?: Access
backup?: Backup
/**
 * Live config files mapped to source-of-truth files.
 */
managedConfigs?: ManagedConfig[]
/**
 * Filesystem root under which container stacks live.
 */
stacksRoot?: string
/**
 * Opaque secret references this host depends on.
 */
secrets?: SecretRef[]
/**
 * Presentation links shown on the host card.
 */
links?: Link[]
bindings?: Bindings
/**
 * Hide this host from default views without affecting validation.
 */
hidden?: boolean
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
/**
 * Reachability and collection-method summary, never credentials.
 */
export interface Access {
/**
 * Whether the host is expected to be reachable.
 */
reachable?: boolean
/**
 * Expected collection or access method.
 */
method?: ("ssh" | "api" | "none")
/**
 * Network port used by the access method.
 */
port?: number
/**
 * Non-secret user name used for access.
 */
user?: string
/**
 * Whether privileged elevation is expected.
 */
sudo?: boolean
/**
 * Additional non-secret access notes.
 */
notes?: string
}
/**
 * Backup expectations for this host.
 */
export interface Backup {
/**
 * Whether this entity is expected to be backed up.
 */
expected: boolean
/**
 * Human-readable backup schedule.
 */
schedule?: string
/**
 * Non-secret backup destination identifier.
 */
target?: string
/**
 * Additional backup notes.
 */
notes?: string
}
export interface ManagedConfig {
/**
 * Live configuration file path.
 */
path: string
/**
 * Owning source-of-truth file reference.
 */
source: string
/**
 * Additional management notes.
 */
notes?: string
}
export interface Link {
/**
 * Human-readable link label.
 */
title: string
/**
 * Link target URL.
 */
href: string
/**
 * Optional icon token.
 */
icon?: string
}
/**
 * Live-provider bindings keyed by provider kind.
 */
export interface Bindings {
[k: string]: unknown | undefined
}
export interface Service {
/**
 * Service name, unique per host.
 */
name: string
/**
 * Name of the host this service runs on.
 */
host: string
kind: ServiceKind
/**
 * One-line statement of what the service is for.
 */
purpose: string
status?: ServiceStatus
/**
 * Stack directory when it differs from the service name.
 */
stack?: string
/**
 * Opaque secret references this service depends on.
 */
secrets?: SecretRef[]
backup?: Backup1
/**
 * Presentation links shown on the service card.
 */
links?: Link[]
bindings?: Bindings1
/**
 * Hide this service from default views without affecting validation.
 */
hidden?: boolean
}
/**
 * Backup expectations for this service.
 */
export interface Backup1 {
/**
 * Whether this entity is expected to be backed up.
 */
expected: boolean
/**
 * Human-readable backup schedule.
 */
schedule?: string
/**
 * Non-secret backup destination identifier.
 */
target?: string
/**
 * Additional backup notes.
 */
notes?: string
}
/**
 * Live-provider bindings keyed by provider kind.
 */
export interface Bindings1 {
[k: string]: unknown | undefined
}
export interface Source {
/**
 * Source id, unique across sources.
 */
id: string
/**
 * Open source kind string.
 */
kind: string
/**
 * Human-readable source title.
 */
title: string
/**
 * Filesystem or repository source location.
 */
location: {
/**
 * Filesystem path to the source root.
 */
path?: string
/**
 * Repository reference.
 */
repo?: string
/**
 * Optional revision or branch.
 */
ref?: string
}
/**
 * Optional include glob patterns.
 */
include?: string[]
/**
 * Optional exclude glob patterns.
 */
exclude?: string[]
/**
 * Optional owning host or service.
 */
owner?: {
/**
 * Owning host name.
 */
host: string
/**
 * Optional owning service name on that host.
 */
service?: string
}
/**
 * Environment variable name holding a credential, never its value.
 */
credentialEnv?: string
}
export interface Integration {
/**
 * Integration id, unique across integrations.
 */
id: string
/**
 * Open provider kind string.
 */
kind: string
/**
 * Human-readable integration title.
 */
title: string
/**
 * Base URL of the integrated tool.
 */
baseUrl: string
/**
 * Optional deep-link template into the tool.
 */
deepLink?: string
/**
 * Opaque provider-defined card specification.
 */
card?: {
[k: string]: unknown | undefined
}
/**
 * Environment variable name holding a credential, never its value.
 */
credentialEnv?: string
}
