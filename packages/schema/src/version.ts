/**
 * The estate config document's schema version. Bumped only on a breaking change; additive
 * changes ship under the same number. Version 2 moved module settings under `modules.<id>`;
 * a version 1 config is migrated with `deck config migrate`.
 */
export const CONFIG_SCHEMA_VERSION = 2 as const;

/**
 * The snapshot document's schema version. The snapshot is produced outside deck (by the
 * estate projector), so it is versioned independently of the config document.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** The config schema version that `deck config migrate` upgrades from. */
export const MIGRATABLE_CONFIG_VERSION = 1 as const;

/**
 * The config schema versions this library validates: the current version only. A document
 * at any other version is rejected by the version gate. A `ReadonlySet<number>` rather than a
 * scalar, so a future multi-version library keeps this export's type.
 */
export const supportedConfigVersions: ReadonlySet<number> = new Set([CONFIG_SCHEMA_VERSION]);

/** The snapshot schema versions this library validates. */
export const supportedSnapshotVersions: ReadonlySet<number> = new Set([SNAPSHOT_SCHEMA_VERSION]);
