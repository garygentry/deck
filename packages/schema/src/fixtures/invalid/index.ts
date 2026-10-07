import type { InvalidFixture } from "../../types.js";
import { fixture as versionUnsupported } from "./version-unsupported.js";
import { fixture as schemaInvalid } from "./schema-invalid.js";
import { fixture as schemaUnknownProperty } from "./schema-unknown-property.js";
import { fixture as schemaRequiredMissing } from "./schema-required-missing.js";
import { fixture as hostDuplicate } from "./host-duplicate.js";
import { fixture as serviceDuplicate } from "./service-duplicate.js";
import { fixture as idDuplicate } from "./id-duplicate.js";
import { fixture as refHostUnresolved } from "./ref-host-unresolved.js";
import { fixture as refServiceUnresolved } from "./ref-service-unresolved.js";
import { fixture as layerOverlayKeyInBase } from "./layer-overlay-key-in-base.js";
import { fixture as layerBaseKeyInOverlay } from "./layer-base-key-in-overlay.js";
import { fixture as overlayDanglingRef } from "./overlay-dangling-ref.js";
import { fixture as providerKindUnknown } from "./provider-kind-unknown.js";
import { fixture as llmUsageInvalid } from "./llm-usage-invalid.js";
import { fixture as secretValueSuspected } from "./secret-value-suspected.js";
import { fixture as snapshotHostDuplicate } from "./snapshot-host-duplicate.js";
import { fixture as snapshotServiceDuplicate } from "./snapshot-service-duplicate.js";
import { fixture as driftIdDuplicate } from "./drift-id-duplicate.js";
import { fixture as snapshotHostUndeclared } from "./snapshot-host-undeclared.js";
import { fixture as snapshotServiceUndeclared } from "./snapshot-service-undeclared.js";
import { fixture as driftLocationUnresolved } from "./drift-location-unresolved.js";
import { fixture as hostNotCollected } from "./host-not-collected.js";

export const invalid: readonly InvalidFixture[] = [
  versionUnsupported,
  schemaInvalid,
  schemaUnknownProperty,
  schemaRequiredMissing,
  hostDuplicate,
  serviceDuplicate,
  idDuplicate,
  refHostUnresolved,
  refServiceUnresolved,
  layerOverlayKeyInBase,
  layerBaseKeyInOverlay,
  overlayDanglingRef,
  providerKindUnknown,
  secretValueSuspected,
  llmUsageInvalid,
  snapshotHostDuplicate,
  snapshotServiceDuplicate,
  driftIdDuplicate,
  snapshotHostUndeclared,
  snapshotServiceUndeclared,
  driftLocationUnresolved,
  hostNotCollected,
];
