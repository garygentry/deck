/* GENERATED from schema/deck.schema.json — do not edit; run pnpm types:build */

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
 * A service reference, plain link, or one-level subgroup.
 */
export type GroupItem = (ServiceItem | LinkItem | Subgroup)
/**
 * Optional default value matching the declared type.
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
 * A merged deck config document containing projected estate inventory and presentation data.
 */
export interface DeckConfigDocument {
/**
 * The shared schema contract version.
 */
schemaVersion: 1
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
 * Portal layout groups; absent is equivalent to an empty array.
 */
groups?: Group[]
/**
 * Document and configuration source declarations; absent is equivalent to an empty array.
 */
sources?: Source[]
/**
 * External tool integrations; absent is equivalent to an empty array.
 */
integrations?: Integration[]
llmUsage?: LlmUsage
/**
 * Governed actions; absent is equivalent to an empty array.
 */
actions?: Action[]
/**
 * Reserved agent slots; absent is equivalent to an empty array.
 */
agents?: Agent[]
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
export interface Group {
/**
 * Group id, unique across the groups tree.
 */
id: string
/**
 * Group heading shown in the portal.
 */
title: string
/**
 * Optional sort key among sibling groups.
 */
order?: number
/**
 * Optional icon token for the group heading.
 */
icon?: string
/**
 * Ordered service, link, or subgroup items.
 */
items: GroupItem[]
}
export interface ServiceItem {
/**
 * Discriminator for a declared service reference.
 */
type: "service"
/**
 * Host name of the referenced service.
 */
host: string
/**
 * Service name on the referenced host.
 */
name: string
/**
 * Optional label override.
 */
title?: string
/**
 * Optional icon token.
 */
icon?: string
/**
 * Optional one-line description.
 */
description?: string
}
export interface LinkItem {
/**
 * Discriminator for a plain external link.
 */
type: "link"
/**
 * Link label.
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
/**
 * Optional one-line description.
 */
description?: string
}
export interface Subgroup {
/**
 * Discriminator for a one-level subgroup.
 */
type: "group"
/**
 * Subgroup id, unique across the groups tree.
 */
id: string
/**
 * Subgroup heading.
 */
title: string
/**
 * Optional sort key among sibling items.
 */
order?: number
/**
 * Optional icon token.
 */
icon?: string
/**
 * Service or link items only; nested subgroups are forbidden.
 */
items: (ServiceItem | LinkItem)[]
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
/**
 * Optional subscription plan-usage limits; absent disables the feature.
 */
export interface LlmUsage {
/**
 * Claude Code (Claude.ai Pro/Max) usage; presence enables the Claude panel.
 */
claude?: {
/**
 * Read-only path to a Claude Code .credentials.json; enables the OAuth usage backfill. Never written or refreshed by deck.
 */
credentialsFile?: string
/**
 * Optional read-only path to a Claude Code projects directory for the token-count transcript scan.
 */
transcriptsDir?: string
/**
 * statusLine hook ingest; the route exists only when the credential is set.
 */
statusLine?: {
/**
 * Environment variable name holding the ingest bearer token, never its value.
 */
credentialEnv: string
}
/**
 * ISO-8601 OAuth poll interval while a session is active; clamped to at least PT2M.
 */
activeInterval?: string
/**
 * ISO-8601 OAuth poll interval while idle; clamped to at least PT2M.
 */
idleInterval?: string
}
/**
 * Codex (ChatGPT subscription) usage; presence enables the Codex panel.
 */
codex?: {
/**
 * Read-write CODEX_HOME holding auth.json (the app-server refreshes it); mount the host's ~/.codex at the same path so its absolute symlinks resolve.
 */
codexHome: string
/**
 * Codex executable path as deck sees it; defaults to codex on PATH. The deck image ships no codex: mount the host's Linux binary and point this at it.
 */
command?: string
/**
 * Optional rollout sessions directory; defaults to <codexHome>/sessions.
 */
rolloutDir?: string
}
/**
 * Percent-used bands for warn and danger tones.
 */
thresholds?: {
/**
 * Percent used at which a bar turns warn; default 75.
 */
warn?: number
/**
 * Percent used at which a bar turns danger; default 90.
 */
danger?: number
}
/**
 * ISO-8601 duration without a viewer after which upstream polling pauses; default PT5M.
 */
idlePause?: string
}
export interface Action {
/**
 * Action id, unique across actions.
 */
id: string
/**
 * Human-readable action label.
 */
title: string
/**
 * Estate-side runner or playbook name, never a command.
 */
runner: string
/**
 * Confirmation policy before running.
 */
confirm: ("none" | "confirm" | "typed-confirm")
/**
 * Typed parameters accepted by the runner.
 */
params?: ActionParam[]
/**
 * Optional host or service target.
 */
target?: {
/**
 * Target host name.
 */
host: string
/**
 * Optional target service name on that host.
 */
service?: string
}
/**
 * Optional longer action description.
 */
description?: string
}
export interface ActionParam {
/**
 * Parameter name, unique within the action.
 */
name: string
/**
 * Parameter value type.
 */
type: ("string" | "number" | "boolean" | "enum")
/**
 * Whether the parameter must be supplied.
 */
required?: boolean
default?: JsonValue
/**
 * Allowed values when the type is enum.
 */
values?: string[]
/**
 * Optional parameter description.
 */
description?: string
}
export interface Agent {
/**
 * Reserved agent id, unique across agents.
 */
id: string
/**
 * Reserved and unstable agent kind.
 */
kind: string
/**
 * Opaque reserved agent configuration.
 */
config?: {
[k: string]: unknown | undefined
}
}
