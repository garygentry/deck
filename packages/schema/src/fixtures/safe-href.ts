/**
 * The link check the fixtures are validated with: an http(s) URL with a host, or an absolute
 * path that is not `//host`. A stand-in for `@deck/module-sdk`'s `isSafeHref` (which this
 * library cannot import, and which refuses more), enough to drive ENTITY_LINK_HREF_UNSAFE.
 */
export function fixtureSafeHref(href: string): boolean {
  return /^https?:\/\/[^/\s]\S*$/i.test(href) || /^\/(?![/\\])\S*$/.test(href);
}
