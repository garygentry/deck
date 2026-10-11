import { finding, type Finding } from "../findings.js";
import { supportedConfigVersions, supportedSnapshotVersions } from "../version.js";
import type {
  DeckConfigDocument,
  SnapshotDocument,
  ValidationResult,
} from "../types.js";
import { checkSnapshot } from "./ajv.js";
import { buildContext, serviceKey } from "./context.js";
import { build, toolError } from "./result.js";
import { checkVersion } from "./rules/version.js";
import { mapAjvErrors } from "./shape.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotIdentity(snapshot: SnapshotDocument): Finding[] {
  const findings: Finding[] = [];
  const hosts = new Set<string>();
  const services = new Set<string>();
  const driftIds = new Set<string>();

  for (const [index, host] of (snapshot.hosts ?? []).entries()) {
    if (hosts.has(host.name)) {
      findings.push(finding("SNAPSHOT_HOST_DUPLICATE", `/hosts/${index}`, `Observed host ${host.name} is duplicated.`));
    }
    hosts.add(host.name);
  }

  for (const [index, service] of (snapshot.services ?? []).entries()) {
    const key = serviceKey(service.host, service.name);
    if (services.has(key)) {
      findings.push(finding("SNAPSHOT_SERVICE_DUPLICATE", `/services/${index}`, `Observed service ${service.host}/${service.name} is duplicated.`));
    }
    services.add(key);
  }

  for (const [index, drift] of (snapshot.drift ?? []).entries()) {
    if (driftIds.has(drift.id)) {
      findings.push(finding("DRIFT_ID_DUPLICATE", `/drift/${index}`, `Drift finding ${drift.id} is duplicated.`));
    }
    driftIds.add(drift.id);
  }

  return findings;
}

function crossCheck(snapshot: SnapshotDocument, config: DeckConfigDocument): Finding[] {
  const findings: Finding[] = [];
  const context = buildContext(config);
  const observedHosts = new Set((snapshot.hosts ?? []).map((host) => host.name));

  for (const [index, host] of (snapshot.hosts ?? []).entries()) {
    if (!context.hosts.has(host.name)) {
      findings.push(finding("SNAPSHOT_HOST_UNDECLARED", `/hosts/${index}`, `Observed host ${host.name} is not declared in the config.`));
    }
  }

  for (const [index, service] of (snapshot.services ?? []).entries()) {
    if (!context.services.has(serviceKey(service.host, service.name))) {
      findings.push(finding("SNAPSHOT_SERVICE_UNDECLARED", `/services/${index}`, `Observed service ${service.host}/${service.name} is not declared in the config.`));
    }
  }

  for (const [index, drift] of (snapshot.drift ?? []).entries()) {
    const { host, service } = drift.location;
    const resolves = service === undefined
      ? context.hosts.has(host)
      : context.services.has(serviceKey(host, service));
    if (!resolves) {
      findings.push(finding("DRIFT_LOCATION_UNRESOLVED", `/drift/${index}/location`, `Drift location ${host}${service === undefined ? "" : `/${service}`} is not declared in the config.`));
    }
  }

  for (const host of config.hosts ?? []) {
    if (!observedHosts.has(host.name)) {
      findings.push(finding("HOST_NOT_COLLECTED", "/hosts", `Configured host ${host.name} was not collected.`));
    }
  }

  return findings;
}

/** Validate an already-parsed snapshot, optionally cross-checking a config. Never throws. */
export function validateSnapshot(snapshot: unknown, config?: unknown): ValidationResult {
  try {
    if (!isObject(snapshot)) {
      return toolError("INPUT_NOT_OBJECT", "snapshot is not an object");
    }

    const version = snapshot.schemaVersion;
    if (!Number.isInteger(version)) {
      return toolError("VERSION_UNREADABLE", "schemaVersion is not an integer");
    }

    const versionFinding = checkVersion(version as number, supportedSnapshotVersions);
    if (versionFinding) return build([versionFinding]);

    if (!checkSnapshot(snapshot)) return build(mapAjvErrors(checkSnapshot.errors, "merged"));

    const document = snapshot as unknown as SnapshotDocument;
    const findings = snapshotIdentity(document);

    if (config !== undefined) {
      if (!isObject(config)) {
        return toolError("INPUT_NOT_OBJECT", "config is not an object");
      }
      if (!Number.isInteger(config.schemaVersion) || !supportedConfigVersions.has(config.schemaVersion as number)) {
        return toolError("CONFIG_UNSUPPORTED", "config schemaVersion is absent, unreadable, or unsupported");
      }
      findings.push(...crossCheck(document, config as unknown as DeckConfigDocument));
    }

    return build(findings);
  } catch (error) {
    return toolError("INTERNAL", error instanceof Error ? error.message : String(error));
  }
}
