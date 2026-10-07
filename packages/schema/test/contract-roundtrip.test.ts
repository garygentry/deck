import { merge, validate, validateSnapshot } from "@deck/schema";
import type {
  Access, Action, ActionParam, Address, Agent, Backup, Bindings, Collectors, Container,
  Coverage, DeckConfigDocument, DriftFinding, DriftLocation, Estate, ExitClassification,
  Finding, FindingCode, FindingSummary, Group, GroupItem, Guest, Host, HostKind, HostStatus,
  Integration, InvalidFixture, JsonObject, JsonPrimitive, JsonValue, Layer, Link, LinkItem,
  ManagedConfig, ObservedHost, ObservedManagedConfig, ObservedService, SecretRef, Service,
  ServiceItem, ServiceKind, ServiceState, ServiceStatus, Severity, SnapshotDocument, Source,
  Subgroup, ToolErrorCode, ValidateLayer, ValidateOptions, ValidationResult, Waiver,
} from "@deck/schema";
import { primary } from "@deck/schema/fixtures";
import { expect, test } from "vitest";

type DocumentedSurface = Access | Action | ActionParam | Address | Agent | Backup | Bindings |
  Collectors | Container | Coverage | DeckConfigDocument | DriftFinding | DriftLocation | Estate |
  ExitClassification | Finding | FindingCode | FindingSummary | Group | GroupItem | Guest | Host |
  HostKind | HostStatus | Integration | InvalidFixture | JsonObject | JsonPrimitive | JsonValue | Layer | Link |
  LinkItem | ManagedConfig | ObservedHost | ObservedManagedConfig | ObservedService | SecretRef |
  Service | ServiceItem | ServiceKind | ServiceState | ServiceStatus | Severity | SnapshotDocument |
  Source | Subgroup | ToolErrorCode | ValidateLayer | ValidateOptions | ValidationResult | Waiver;
void (undefined as unknown as DocumentedSurface);

test("the public package surface completes the fixture loader round trip", () => {
  expect(validate(primary.base, { layer: "base" }).classification).toBe(0);
  expect(validate(primary.overlay, { layer: "overlay", base: primary.base }).classification).toBe(0);
  const merged = merge(primary.base, primary.overlay);
  expect(merged).toEqual(primary.merged);
  expect(validate(merged).classification).toBe(0);
  expect(validateSnapshot(primary.snapshots.combined, merged).classification).toBe(0);
});
