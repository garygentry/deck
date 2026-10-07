/**
 * The secret-reference pattern (REQ-SCHEMA-05): a short opaque id — lowercase
 * alphanumeric with dash/dot separators, no whitespace, no "://". This exact string
 * is ALSO the literal `pattern` on `SecretRef` in both schema files; schema-files.test.ts
 * asserts equality so the two cannot drift (07-testing-strategy.md).
 */
export const SECRET_REF_PATTERN = "^[a-z0-9]+(?:[.-][a-z0-9]+)*$";
/** Bound on a secret reference's length; the schema's SecretRef sets maxLength to this. */
export const SECRET_REF_MAX_LENGTH = 64;

/**
 * Credential key names for the secret-value heuristic (REQ-VAL-10). A string value
 * under a key whose NORMALISED name (lowercased, "-" and "_" stripped) is in this
 * list, and which does NOT match SECRET_REF_PATTERN, yields a SECRET_VALUE_SUSPECTED
 * info finding. Info, not warning, so a false positive stays visible without failing
 * the exit-code contract (REQ-VAL-03).
 */
export const CREDENTIAL_KEY_NAMES = [
  "password", "passwd", "pass", "passphrase", "token", "secret", "apikey",
  "credential", "credentials", "privatekey", "accesskey", "clientsecret",
  "auth", "authorization", "bearer",
] as const;

/**
 * Recognisable token shapes. ANY string value in the document (including open
 * `facts`/binding values) matching one of these also yields SECRET_VALUE_SUSPECTED.
 * Messages report only the path and the value's length, never the value.
 */
export const TOKEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "jwt",         pattern: /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/ },
  { name: "github",      pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "aws-access",  pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack",       pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "long-random", pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9+/=_-]{40,}$/ },
];
