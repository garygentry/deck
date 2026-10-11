/* GENERATED from modules/portal/schema.json by apps/server/src/scripts/gen-module-types.ts — do not edit; run `pnpm gen:module-types`. */

/**
 * A service reference, plain link, or one-level subgroup.
 */
export type GroupItem = (ServiceItem | LinkItem | Subgroup)

/**
 * Settings of the portal module, at modules.portal.
 */
export interface PortalModuleConfig {
/**
 * Portal layout groups; absent is equivalent to an empty array.
 */
groups?: Group[]
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
