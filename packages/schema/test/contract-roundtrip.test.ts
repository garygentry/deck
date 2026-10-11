import { merge, validate, validateSnapshot } from "@deck/schema";
import type {
  Access, Address, Backup, Bindings, Collectors, Container,
  Coverage, DeckConfigDocument, DriftFinding, DriftLocation, Estate, ExitClassification,
  Finding, FindingCode, FindingSummary, Guest, Host, HostKind, HostStatus,
  Integration, InvalidFixture, JsonObject, JsonPrimitive, JsonValue, Layer, Link,
  ManagedConfig, ObservedHost, ObservedManagedConfig, ObservedService, SecretRef, Service,
  ServiceKind, ServiceState, ServiceStatus, Severity, SnapshotDocument, Source,
  ToolErrorCode, ValidateLayer, ValidateOptions, ValidationResult, Waiver,
} from "@deck/schema";
import { composeFixtures, primary } from "@deck/schema/fixtures";
import { expect, test } from "vitest";

type DocumentedSurface = Access | Address | Backup | Bindings |
  Collectors | Container | Coverage | DeckConfigDocument | DriftFinding | DriftLocation | Estate |
  ExitClassification | Finding | FindingCode | FindingSummary | Guest | Host |
  HostKind | HostStatus | Integration | InvalidFixture | JsonObject | JsonPrimitive | JsonValue | Layer | Link |
  ManagedConfig | ObservedHost | ObservedManagedConfig | ObservedService | SecretRef |
  Service | ServiceKind | ServiceState | ServiceStatus | Severity | SnapshotDocument |
  Source | ToolErrorCode | ValidateLayer | ValidateOptions | ValidationResult | Waiver;
void (undefined as unknown as DocumentedSurface);

test("the public package surface completes the fixture loader round trip", () => {
  // The fixture carries a server module's section (`modules.actions`) and binds the data-source
  // modules' kinds; both are stood in for here.
  const composed = composeFixtures();
  expect(validate(primary.base, { layer: "base", composed }).classification).toBe(0);
  expect(validate(primary.overlay, { layer: "overlay", base: primary.base, composed }).classification).toBe(0);
  const merged = merge(primary.base, primary.overlay);
  expect(merged).toEqual(primary.merged);
  expect(validate(merged, { composed }).classification).toBe(0);
  expect(validateSnapshot(primary.snapshots.combined, merged).classification).toBe(0);
});
