import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDENTITY, OWNERSHIP, resolveOwner } from "../src/ownership.js";

type Schema = Record<string, unknown>;

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schema/deck.schema.json", import.meta.url)), "utf8"),
) as Schema;

function shallowConfigPaths(): string[] {
  const paths: string[] = [];
  const properties = schema.properties as Record<string, Schema>;
  const definitions = schema.$defs as Record<string, Schema>;
  for (const [root, rootSchema] of Object.entries(properties)) {
    paths.push(root);
    const isArray = rootSchema.type === "array";
    const target = isArray ? rootSchema.items as Schema : rootSchema;
    const reference = target.$ref;
    if (typeof reference !== "string") continue;
    const definition = definitions[reference.slice("#/$defs/".length)];
    for (const key of Object.keys((definition.properties ?? {}) as object)) {
      paths.push(`${root}${isArray ? "[]" : ""}.${key}`);
    }
  }
  return paths;
}

describe("layer ownership", () => {
  it("resolves exact and nearest-ancestor rows", () => {
    expect(resolveOwner("hosts[].kind")).toBe("base");
    expect(resolveOwner("hosts[].access.method")).toBe("base");
    expect(resolveOwner("hosts[].addresses[].network")).toBe("base");
    expect(resolveOwner("hosts[].bindings.docker")).toBe("overlay");
    expect(resolveOwner("hosts[]")).toBe("container");
    expect(resolveOwner("groups[].items[].title")).toBe("overlay");
    expect(resolveOwner("estate.freshness.snapshotStaleAfter")).toBe("overlay");
    expect(resolveOwner("schemaVersion")).toBe("both");
  });

  it("covers every root and depth-two config property", () => {
    const owners = new Set(["base", "overlay", "both", "container"]);
    for (const path of shallowConfigPaths()) expect(owners.has(resolveOwner(path))).toBe(true);
  });

  it("keeps inventory identity fields base-owned", () => {
    expect(IDENTITY.hosts).toEqual(["name"]);
    expect(IDENTITY.services).toEqual(["host", "name"]);
    expect(resolveOwner("hosts[].name")).toBe("base");
    expect(resolveOwner("services[].host")).toBe("base");
    expect(resolveOwner("services[].name")).toBe("base");
    expect(OWNERSHIP["estate.freshness"]).toBe("overlay");
  });
});
