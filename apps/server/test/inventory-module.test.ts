/**
 * The inventory module's manifest: its identity and UI contributions are the copy the web
 * half registers against.
 */

import { INVENTORY_UI } from "@deck/contract/modules/inventory";
import { describe, expect, it } from "vitest";

import { INVENTORY_MANIFEST } from "../src/inventory/module.js";
import { serverOnlyFields } from "./util/shared-ui.js";

describe("inventory module", () => {
  it("takes its identity and UI contributions from the copy the web half registers against", () => {
    const { id, version, deckApi, contributes } = INVENTORY_MANIFEST;
    expect({ id, version, deckApi, contributes }).toEqual(INVENTORY_UI);
    expect(contributes).toBe(INVENTORY_UI.contributes);
  });

  it("keeps its server-only fields out of the shared copy", () => {
    expect(INVENTORY_MANIFEST.dependsOn).toEqual(["snapshot"]);
    expect(serverOnlyFields(INVENTORY_UI)).toEqual([]);
  });
});
