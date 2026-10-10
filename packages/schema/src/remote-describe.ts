import deckSchema from "../schema/deck.schema.json" with { type: "json" };
import { CORE_WIDGET_TYPE_SCHEMAS } from "./core-widgets.js";

/**
 * The JSON Schema of a remote provider's describe document (`GET /deck/v1/describe`), built
 * from the config schema's own descriptors so the two cannot drift:
 * - a widget is a `ui.pages` widget (`$defs.UiWidget`) without `source`, which deck pins to the
 *   sidecar, and with a required, bounded `id`;
 * - a link is a `core/link-tiles` link;
 * - a nav entry is a `ui.nav.items` link entry (`$defs.UiNavItem`, http(s) form) whose `id` is
 *   a bare name deck namespaces, with bounded strings.
 * `schema/remote-describe.schema.json` is this document, written by `pnpm describe:build`; a
 * test keeps the file equal to it.
 */

/** Version of the remote provider protocol this schema describes (`deck` in the document). */
export const REMOTE_PROTOCOL_VERSION = 1;

/** Bounds on a describe document's lists and plain strings. */
export const REMOTE_DESCRIBE_LIMITS = {
  widgets: 24,
  links: 32,
  nav: 8,
  /** Ids, the version and icon names. */
  name: 64,
  /** Titles and labels. */
  label: 80,
  href: 2048,
} as const;

type Schema = Record<string, unknown>;

const defs = (deckSchema as { $defs: Record<string, Schema> }).$defs;

const NAME = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9-]*$",
  maxLength: REMOTE_DESCRIBE_LIMITS.name,
} as const;

function remoteWidget(): Schema {
  const widget = structuredClone(defs.UiWidget!) as Schema & { properties: Record<string, Schema> };
  delete widget.properties.source;
  widget.title = "RemoteWidget";
  widget.required = ["id", "type"];
  widget.properties.id = { ...widget.properties.id, maxLength: REMOTE_DESCRIBE_LIMITS.name };
  return widget;
}

function remoteLink(): Schema {
  const linkTiles = CORE_WIDGET_TYPE_SCHEMAS.find((entry) => entry.type === "core/link-tiles")!;
  const link = structuredClone((linkTiles.optionsSchema.properties as Record<string, { items: Schema }>).links.items) as Schema & {
    properties: Record<string, Schema>;
  };
  link.title = "RemoteLink";
  link.properties.icon = { ...link.properties.icon, maxLength: REMOTE_DESCRIBE_LIMITS.name };
  return link;
}

function remoteNavItem(): Schema {
  const [entry] = (defs.UiNavItem as { oneOf: Schema[] }).oneOf;
  const nav = structuredClone(entry!) as Schema & { properties: Record<string, Schema> };
  delete nav.properties.group;
  nav.title = "RemoteNavItem";
  nav.required = ["id", "label", "href"];
  nav.properties.id = { ...NAME, description: "The entry's name, unique in the document; deck lists it as nav:remote/<instance>.<id>." };
  nav.properties.label = { ...nav.properties.label, maxLength: REMOTE_DESCRIBE_LIMITS.label };
  nav.properties.href = { ...nav.properties.href, maxLength: REMOTE_DESCRIBE_LIMITS.href };
  nav.properties.icon = { ...nav.properties.icon, maxLength: REMOTE_DESCRIBE_LIMITS.name };
  return nav;
}

/** The describe document's JSON Schema (draft 2020-12). */
export function remoteDescribeSchema(): Schema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:deck:schema:remote-describe:1",
    title: "RemoteDescribe",
    description:
      "What a remote provider (sidecar) contributes, served at GET /deck/v1/describe: declarative widgets over its own data, links and nav entries. Deck renders them with its own widget types; nothing in it runs as code.",
    type: "object",
    additionalProperties: false,
    required: ["deck", "id", "version"],
    properties: {
      deck: { const: REMOTE_PROTOCOL_VERSION, description: "The protocol version the document speaks." },
      id: { ...NAME, description: "The sidecar's id; it must equal the id of the integration that polls it." },
      version: {
        type: "string",
        minLength: 1,
        maxLength: REMOTE_DESCRIBE_LIMITS.name,
        pattern: "^[0-9A-Za-z][0-9A-Za-z.+-]*$",
        description: "The sidecar's own version, shown in its health detail.",
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: REMOTE_DESCRIBE_LIMITS.label,
        pattern: "\\S",
        description: "The heading over its widgets; default the integration's title.",
      },
      columns: { type: "integer", minimum: 1, maximum: 4, description: "Grid columns of its widget section from the md breakpoint up; default 1." },
      widgets: {
        type: "array",
        maxItems: REMOTE_DESCRIBE_LIMITS.widgets,
        items: { $ref: "#/$defs/RemoteWidget" },
        description: "Widgets over the sidecar's data (GET /deck/v1/data), in reading order.",
      },
      links: {
        type: "array",
        maxItems: REMOTE_DESCRIBE_LIMITS.links,
        items: { $ref: "#/$defs/RemoteLink" },
        description: "Links shown as tiles below its widgets.",
      },
      nav: {
        type: "array",
        maxItems: REMOTE_DESCRIBE_LIMITS.nav,
        items: { $ref: "#/$defs/RemoteNavItem" },
        description: "External sidebar links, in the nav group of the integration's page.",
      },
    },
    $defs: {
      RemoteWidget: remoteWidget(),
      RemoteLink: remoteLink(),
      RemoteNavItem: remoteNavItem(),
      JsonValue: structuredClone(defs.JsonValue!),
    },
  };
}
