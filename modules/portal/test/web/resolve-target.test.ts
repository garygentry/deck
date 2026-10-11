import type { Service } from "@deck/schema";
import { describe, expect, it } from "vitest";
import type { GroupItem } from "../../server/types.js";
import { resolveTarget } from "../../web/PortalGroupsWidget.js";

const link = (href: string): GroupItem => ({ type: "link", title: "L", href }) as GroupItem;
const serviceItem = { type: "service", host: "alpha", name: "web" } as GroupItem;
const service = (href: string): Service => ({ host: "alpha", name: "web", kind: "container", purpose: "p", links: [{ title: "Open", href }] }) as Service;

describe("resolveTarget", () => {
  it.each(["https://grafana.lab/", "http://10.0.0.5:3000/", "/inventory"])("keeps the safe href %j", (href) => {
    expect(resolveTarget(link(href))).toBe(href);
    expect(resolveTarget(serviceItem, service(href))).toBe(href);
  });

  it.each(["data:text/html,<script>alert(1)</script>", "javascript:alert(1)", "//evil.example/", "/\\evil.example"])(
    "leaves the card without a target for %j",
    (href) => {
      expect(resolveTarget(link(href))).toBeUndefined();
      expect(resolveTarget(serviceItem, service(href))).toBeUndefined();
    },
  );
});
