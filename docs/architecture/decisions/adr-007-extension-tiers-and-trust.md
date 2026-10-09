# ADR-007: Graded extension tiers, with a trust model per tier

- Status: accepted
- Date: 2026-10-09

## Context

With one module contract (ADR-005) and a config-driven UI (ADR-006), deck could in principle load
anyone's module. Most of what home-lab operators want that deck lacks is small, though:

- show a number from some JSON API, coloured by meaning;
- link to a tool;
- put a device's status on a page.

Homepage's `customapi` and Glance's `custom-api` show that "fetch an API, pick a few values,
colour them" covers most of it with no code at all. Anything heavier, such as a protocol that is
not HTTP/JSON, credentials deck should not hold, or another language, does not need to run
inside deck.

Running third-party code in deck's process or page is a different matter. A server module in
the Bun process can read deck's environment and files, and a web module in deck's origin can call
every API as the signed-in viewer. Sandboxing that (iframes per extension, Module Federation,
isolates) is built for multi-tenant hosts. Deck serves one operator behind an authenticating
reverse proxy.

## Decision

Offer **five tiers**, from no code to full trust. Each tier carries only the trust its form
needs, so an operator climbs only as far as the problem requires:

| Tier | What it is | Runs code? | Trust |
| --- | --- | --- | --- |
| 1. Config | `ui` pages of `core/…` widgets, `select`, status maps, nav links | No | Declarative, schema-checked |
| 2. Generic adapter | An `http-json` integration polling any JSON API, shown by tier-1 widgets | No | Declarative; deck makes the request |
| 3. Sidecar | A `remote` integration: an out-of-process HTTP service speaking the remote provider protocol | Out of process | Its answers are untrusted input |
| 4. In-repo module | A built-in under `modules/<id>/`, compiled into deck and reviewed with it | In process | Full: it is deck |
| 5. Runtime module | A directory in `DECK_MODULES_DIR`, loaded at boot without rebuilding deck | In process and in deck's page | Full, opt-in, pinned |

The generic tiers come first. `http-json` and the generic widgets give a no-code path that most
needs never leave.

**Declarative tiers (1–3) never run their author's code in deck.**

- Config is validated against the composed schema. Each widget's options are checked against its
  type's options schema.
- `select` runs on the server under step, size and depth budgets.
- Links pass one check (`isSafeHref`), and markdown is sanitised by DOMPurify.
- `core/embed`, the one widget that shows another site's page, is off unless
  `ui.allowUnsafeEmbeds` is `true`. Its frame is always sandboxed, and the page's CSP
  `frame-src` names only the embedded origins, never deck's own.
- `http-json` takes its credential only from the variable `credentialEnv` names. It caps
  response size, depth and time, never sends the credential off its origin, and refuses a
  response that echoes the credential.

**A sidecar is out of process and declarative only.** The protocol is two `GET` endpoints:

- `/deck/v1/data` returns `{ data, observedAt }`, polled like any provider;
- `/deck/v1/describe` returns widgets, links and nav entries, refreshed on its own cadence.

The describe document is untrusted input:

- it is checked against `remote-describe.schema.json`;
- it may use only an allowlist of deck's declarative widget types (never `core/embed`,
  `core/health-pills` or another module's types), and every string is bounded;
- its markdown may link only to absolute external URLs;
- any failed check refuses the whole document, and the last good one keeps rendering.

Config, not the sidecar, chooses its page path and nav placement, and deck refuses a redirect
off the sidecar's origin. The sidecar holds no UI code, may be written in any language, and
crashing it degrades only its own provider.

**Runtime modules are full trust, and gated.**

- **Server:** deck reads every `deck-module.json` at boot. It imports the server entry with
  `import()` only when `DECK_MODULES_ENABLED` is on, after planning the whole module set from
  manifests.
- **Web:** `web.js` is native ESM, served from deck's origin. An import map gives it deck's own
  `react`, `react-dom`, `react/jsx-runtime` and `@deck/sdk`, so it renders with deck's React
  and reads deck's data hooks.

Iframe isolation and Module Federation were rejected: they defend against a multi-tenant threat
deck does not have, at a large cost in complexity. The safeguards instead are:

- the env gate, off by default;
- a `deckApi` semver check;
- an optional `moduleIntegrity` digest, checked just before each import;
- load failures disable only the module, reported as fixed categories and never the module's
  own error text;
- an error boundary around every runtime component (a "failed" tile, not a white page);
- deck's Content-Security-Policy on `web.js` (scripts from deck's origin only, no `eval`,
  requests to deck only);
- icons rebuilt from an element and attribute allowlist;
- CSS confined to the module's own Tailwind prefix;
- `deck-module lint`, which applies the web app's own UI guardrails to a module.

The trust model is stated plainly in [Security & access posture](../../security.md#trust-tiers):
in-process code has every privilege deck has.

## Consequences

- **Most unforeseen needs are met with no code.** The [dashboard guide](../../guides/build-a-dashboard.md)
  builds pages from any JSON API in config alone, and a sidecar covers the rest without touching
  deck's process.
- **Tier choice is a trust choice.** The tiers share one contract and one renderer, so moving
  up is incremental: a sidecar's widgets are `ui.pages` widgets, and a runtime module's manifest
  is a built-in's. Each step up hands more trust to the author, and the docs say so at each
  step.
- **The declarative surface is a security boundary that must stay small.**
  - The sidecar widget allowlist, the `select` budgets, the link check and the markdown policy
    are enforced on the server and again in the browser where they render.
  - A new declarative widget type is a review of what it lets an untrusted describe do.
  - Adding `core/embed` to the sidecar allowlist would hand frame control to the sidecar.
- **Runtime modules are only as safe as the operator's review.** A pin protects the module's
  files at rest. It does not stop someone who can write the module directory while deck
  starts. Operators are told to mount it read-only and pin every module.
- **Compatibility is explicit.** A module built for another `deckApi` is refused, not half-run.
  A web half that imports a name `@deck/sdk` does not export, or whose manifest differs from the
  server's copy, shows as "incompatible" instead of failing silently.
- **One shared React is a hard rule.** A runtime module that bundles its own React breaks every
  hook. The template's build keeps the import-mapped names external, and `deck-module lint`
  refuses a build that bundles them.

## Related

- [Kernel and modules](../../explanation/kernel-and-modules.md)
- [Security & access posture](../../security.md)
- [Build a dashboard without code](../../guides/build-a-dashboard.md)
- [Write a sidecar module](../../guides/write-a-sidecar-module.md)
- [Remote provider protocol](../../reference/remote-provider-protocol.md)
- [Write a module](../../guides/write-a-module.md)
- [Run a runtime module](../../guides/runtime-modules.md)
- [ADR-005: One module contract for every feature, around a small kernel](./adr-005-module-contract-and-kernel.md)
