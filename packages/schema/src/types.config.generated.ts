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
export type UiNavItem = ({
/**
 * The entry id, in the reserved ui namespace: nav:ui/<name>, such as nav:ui/grafana.
 */
id: string
/**
 * The group the entry belongs to.
 */
group: string
/**
 * The entry's label.
 */
label: string
/**
 * An external http(s) URL.
 */
href: string
/**
 * An icon name from the shell's icon set.
 */
icon?: string
/**
 * Order within the group; default 100.
 */
order?: number
} | {
/**
 * The separator's id, nav:ui/<name>.
 */
id: string
/**
 * The group the separator belongs to.
 */
group: string
/**
 * Marks the entry as a separator.
 */
separator: true
/**
 * Order within the group; default 100.
 */
order?: number
})
export type UiOverride = (boolean | {
/**
 * Whether it renders.
 */
enabled?: boolean
/**
 * Where it attaches, replacing its default (and an earlier layer's attachTo) whole; an omitted slot keeps the slot, an omitted order is 100, and group (nav entries only) when omitted keeps the entry's own.
 */
attachTo?: {
/**
 * The slot id.
 */
slot?: string
/**
 * Order within the slot.
 */
order?: number
/**
 * For a nav entry, the group it moves to.
 */
group?: string
}
/**
 * Replaces the extension's config (and an earlier layer's) wholesale.
 */
config?: {
[k: string]: JsonValue | undefined
}
})
/**
 * Any value representable in JSON.
 */
export type JsonValue = (string | number | boolean | null | JsonValue[] | {
[k: string]: JsonValue | undefined
})

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
ui?: Ui
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
/**
 * Presentation settings: brand, theme, home page, navigation and extension overrides.
 */
export interface Ui {
brand?: UiBrand
theme?: UiTheme
/**
 * The id of the page rendered at /, such as page:inventory/hosts; default the built-in home page.
 */
home?: string
nav?: UiNav
/**
 * Overrides by extension, page or nav entry id. They replace, never merge: false disables, an object replaces attachTo and/or config, and a later layer's attachTo or config replaces an earlier layer's whole.
 */
extensions?: {
[k: string]: UiOverride | undefined
}
/**
 * Config-defined pages (dashboards): sections of widgets, each page routed as page:ui/<id>.
 */
pages?: UiPage[]
}
/**
 * The product name and mark the shell shows.
 */
export interface UiBrand {
/**
 * The product name in the sidebar and the document title; default estate.name, then Deck.
 */
title?: string
/**
 * An icon name from the shell's icon set, shown in place of the title's initial.
 */
icon?: string
/**
 * An http(s) URL or a root-relative path to a logo image, shown in place of the icon.
 */
logoUrl?: string
}
/**
 * The operator's theme defaults; a viewer's own choice of mode still wins.
 */
export interface UiTheme {
/**
 * The colour mode a viewer who has not chosen one sees; default system.
 */
mode?: ("light" | "dark" | "system")
/**
 * The named colour preset, a contrast-tested token set; default teal.
 */
preset?: ("teal" | "slate" | "copper" | "rose" | "high-contrast")
/**
 * Spacing of tables, lists and sections; default comfortable.
 */
density?: ("compact" | "comfortable")
/**
 * Corner radius scale; default md.
 */
radius?: ("none" | "sm" | "md" | "lg")
}
/**
 * Sidebar group order, labels and icons, and extra nav entries.
 */
export interface UiNav {
/**
 * Groups in sidebar order; the built-in groups not listed follow in their default order, then any other group by id. Across layers groups merge by id: a group keeps its first layer's position and a new id is appended.
 */
groups?: UiNavGroup[]
/**
 * Extra nav entries: external links and separators.
 */
items?: UiNavItem[]
}
export interface UiNavGroup {
/**
 * The group id, a built-in group or a new one.
 */
id: string
/**
 * The group heading; default the built-in heading, else the id.
 */
label?: string
/**
 * An icon name from the shell's icon set.
 */
icon?: string
}
export interface UiPage {
/**
 * The page's name; its id is page:ui/<id>.
 */
id: string
/**
 * The page's path, such as /lab: literal segments only.
 */
path: string
/**
 * The page heading, nav label and document title.
 */
title: string
/**
 * An icon name from the shell's icon set.
 */
icon?: string
nav?: UiPageNav
/**
 * The page's sections, in reading order.
 * 
 * @minItems 1
 */
sections: [UiSection, ...(UiSection)[]]
}
/**
 * The page's sidebar entry (nav:ui/<id>); without it the page has none.
 */
export interface UiPageNav {
/**
 * The nav group the entry belongs to.
 */
group: string
/**
 * The entry's label; default the page title.
 */
label?: string
/**
 * Order within the group; default 100.
 */
order?: number
}
export interface UiSection {
/**
 * The section heading.
 */
title: string
/**
 * Grid columns from the md breakpoint up (one column below it); default 1.
 */
columns?: number
/**
 * The section's widgets, in reading order.
 * 
 * @minItems 1
 */
widgets: [UiWidget, ...(UiWidget)[]]
}
export interface UiWidget {
/**
 * A stable name, unique on the page; its id is widget:ui/<page>.<id>. Without one, the id is positional and changes when widgets move.
 */
id?: string
/**
 * The widget type, <module>/<name>, such as core/json.
 */
type: string
/**
 * The widget's heading.
 */
title?: string
/**
 * The provider the widget reads: a provider id, or the first provider of a kind.
 */
source?: (string | {
/**
 * A provider kind.
 */
kind: string
})
/**
 * A JMESPath expression over the provider's data, evaluated on the server at each poll.
 */
select?: string
/**
 * Options of the widget type, checked against its schema.
 */
options?: {
[k: string]: JsonValue | undefined
}
/**
 * Columns the widget spans; default 1, at most the section's columns.
 */
span?: number
/**
 * Rows the widget spans; default 1.
 */
rows?: number
}
