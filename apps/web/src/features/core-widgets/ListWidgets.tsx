import type { ReactNode } from "react";
import { CardGrid, ExternalLink, LinkTile, List, ListItem, isIconName, useNow } from "@/ui";

import type { WidgetProps } from "../../registry/registry.js";
import { ToneBadge, toneOf, useStatusMaps } from "./status-maps.js";
import { Truncated } from "./Truncated.js";
import { UnexpectedValue } from "./UnexpectedValue.js";
import { formatValue, isRecord, isScalar, linkOf, readField, type ValueFormat } from "./values.js";

/** A list row's link that leaves deck: a new tab, announced (the row's stretched link). */
function NewTabLink({ href, className, children }: { href: string; className?: string; children?: ReactNode }) {
  return (
    <ExternalLink href={href} plain className={className}>
      {children}
    </ExternalLink>
  );
}

/** Text of a field for a title or a line: a scalar as text, anything else none. */
function textOf(value: unknown): string | undefined {
  return isScalar(value) ? String(value) : undefined;
}

interface ListOptions {
  titleField?: string;
  descriptionField?: string;
  metaField?: string;
  metaFormat?: ValueFormat;
  statusField?: string;
  statusMap?: string;
  hrefField?: string;
  limit?: number;
}

/**
 * `core/list`: a list's items as rows. An item that is text or a number is its own title; an
 * object's fields give its title (default `name`), description, meta, status badge and link.
 */
export function ListWidget({ value, options, widget }: WidgetProps<ListOptions>) {
  const maps = useStatusMaps();
  const now = useNow(15_000, options.metaFormat === "relative-time");
  if (!Array.isArray(value)) return <UnexpectedValue type={widget.type} expected="a list" value={value} />;
  const limit = options.limit ?? 25;
  const tone = toneOf(maps, options.statusMap);
  const rows = value.slice(0, limit);
  return (
    <>
      <List variant="divided" aria-label={widget.title ?? widget.type}>
        {rows.map((item, index) => {
          if (!isRecord(item)) return <ListItem key={index} title={textOf(item) ?? formatValue(item, "text", undefined, now)} />;
          const title = textOf(readField(item, options.titleField ?? "name")) ?? `Item ${index + 1}`;
          const description = options.descriptionField === undefined ? undefined : textOf(readField(item, options.descriptionField));
          const meta = options.metaField === undefined ? undefined : readField(item, options.metaField);
          const status = options.statusField === undefined ? undefined : readField(item, options.statusField);
          const link = options.hrefField === undefined ? undefined : linkOf(readField(item, options.hrefField));
          return (
            <ListItem
              key={index}
              title={title}
              {...(description === undefined ? {} : { description })}
              {...(meta === undefined || meta === null ? {} : { meta: formatValue(meta, options.metaFormat, undefined, now) })}
              {...(isScalar(status) ? { leading: <ToneBadge text={String(status)} presentation={tone(status)} /> } : {})}
              {...(link === undefined ? {} : { href: link.href, ...(link.external ? { linkAs: NewTabLink } : {}) })}
            />
          );
        })}
      </List>
      <Truncated shown={rows.length} total={value.length} />
    </>
  );
}

interface StatusGridOptions {
  labelField?: string;
  statusField?: string;
  hrefField?: string;
  statusMap?: string;
  limit?: number;
}

/**
 * `core/status-grid`: named states as tiles, each a status badge (tone from the status map, with
 * its icon and the state's text). The value is a list of objects (name and status fields), or an
 * object of name → state.
 */
export function StatusGridWidget({ value, options, widget }: WidgetProps<StatusGridOptions>) {
  const maps = useStatusMaps();
  const tone = toneOf(maps, options.statusMap);
  const entries = Array.isArray(value)
    ? value.filter(isRecord).map((item) => ({
        label: textOf(readField(item, options.labelField ?? "name")),
        status: readField(item, options.statusField ?? "status"),
        link: options.hrefField === undefined ? undefined : linkOf(readField(item, options.hrefField)),
      }))
    : isRecord(value)
      ? Object.entries(value).map(([label, status]) => ({ label, status, link: undefined }))
      : undefined;
  if (entries === undefined) return <UnexpectedValue type={widget.type} expected="a list of objects, or an object of names and states" value={value} />;
  const shown = entries.slice(0, options.limit ?? 48);
  return (
    <>
      <CardGrid aria-label={widget.title ?? widget.type}>
        {shown.map((entry, index) => (
          <LinkTile
            key={`${entry.label ?? ""}#${index}`}
            title={entry.label ?? `Item ${index + 1}`}
            status={<ToneBadge text={isScalar(entry.status) ? String(entry.status) : "Unknown"} presentation={isScalar(entry.status) ? tone(entry.status) : undefined} />}
            {...(entry.link === undefined ? {} : { href: entry.link.href, external: entry.link.external })}
          />
        ))}
      </CardGrid>
      <Truncated shown={shown.length} total={entries.length} noun="states" />
    </>
  );
}

interface LinkEntry {
  title: string;
  href: string;
  description?: string;
  icon?: string;
}

/** A value's link entries: objects with a title and a safe href (others are left out). */
function linksOf(value: unknown): LinkEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): LinkEntry[] => {
    const title = textOf(readField(item, "title"));
    const href = readField(item, "href");
    if (title === undefined || linkOf(href) === undefined) return [];
    const description = textOf(readField(item, "description"));
    const icon = textOf(readField(item, "icon"));
    return [{ title, href: href as string, ...(description === undefined ? {} : { description }), ...(icon === undefined ? {} : { icon }) }];
  });
}

/**
 * `core/link-tiles`: link tiles from `options.links`, else from the value (a list of objects
 * with `title`, `href`, `description` and `icon`). A link leaving deck opens in a new tab; an
 * href that is neither http(s) nor an absolute path in deck is not shown.
 */
export function LinkTilesWidget({ value, options, widget }: WidgetProps<{ links?: LinkEntry[] }>) {
  const links = options.links ?? linksOf(value);
  if (links === undefined) return <UnexpectedValue type={widget.type} expected="links (options.links, or a list of objects with title and href)" value={value} />;
  return (
    <CardGrid aria-label={widget.title ?? widget.type} navigable>
      {links.map((link, index) => {
        const target = linkOf(link.href);
        return (
          <LinkTile
            key={`${link.href}#${index}`}
            title={link.title}
            {...(link.description === undefined ? {} : { description: link.description })}
            {...(link.icon !== undefined && isIconName(link.icon) ? { icon: link.icon } : {})}
            {...(target === undefined ? {} : { href: target.href, external: target.external })}
          />
        );
      })}
    </CardGrid>
  );
}
