/**
 * The single integer schema version shared by the config document and the
 * snapshot document (REQ-VER-01). One contract, one number. Bumped only on a
 * breaking change (REQ-VER-02); additive changes ship under the same number.
 */
export const SCHEMA_VERSION = 1 as const;

/**
 * The set of schema versions this library can validate. The library supports the
 * current version ONLY (REQ-VER-04): a document at any other version is rejected
 * by the version gate with a VERSION_UNSUPPORTED finding (see 03-validation.md).
 * Exported as a `ReadonlySet<number>` — not a scalar — so a future multi-version
 * library does not change this export's type (REQ-VAL-05). Exactly one entry today.
 */
export const supportedVersions: ReadonlySet<number> = new Set([SCHEMA_VERSION]);
