/**
 * `@deck/sdk`: what a runtime module's web half imports from deck, through the page's import
 * map. The host builds it as its own chunk, on the same module instances the shell runs, so a
 * module's components share deck's React, query cache, UI manifest and registry.
 *
 * It is a curated surface: the `@/ui` patterns (which carry deck's look and a11y contract),
 * `Icon`, tones and status maps, and the data hooks. It never re-exports the vendored
 * shadcn/Radix primitives or `cn`: they are implementation detail the host must stay free to
 * change, and a module that styles from them leaks the host's framework into its API. Adding
 * a name here makes it part of the module API (test/sdk.test.ts pins the list).
 */

// The module contract.
export { defineWebModule, DECK_API_VERSION, satisfiesDeckApi, statusTone, type StatusMapData, type WebModule } from "@deck/module-sdk";

// Data: provider envelopes, the config and the UI manifest, all from the shell's one query cache.
export { useConfig, useProvider, useProviders, useUiManifest } from "../data/index.js";

// Tones and icons.
export { defineStatusMap, Icon, TONE_ICON, TONES, type IconProps, type StatusMap, type StatusPresentation, type Tone } from "@/ui";

// Formatting.
export { formatAge, formatRelative, formatTimestamp } from "@/ui";

// Page structure and states.
export {
  Callout,
  EmptyState,
  ErrorState,
  FragmentBoundary,
  LoadingState,
  PageHeader,
  Section,
  type CalloutProps,
  type EmptyStateProps,
  type ErrorStateProps,
  type LoadingStateProps,
  type PageHeaderProps,
  type SectionProps,
} from "@/ui";

// Content, status and data display.
export {
  CardGrid,
  CodeBlock,
  DataTable,
  Disclosure,
  ExternalLink,
  FreshnessBadge,
  HealthPill,
  KeyValue,
  KeyValueList,
  LinkTile,
  List,
  ListGroup,
  ListItem,
  Meter,
  Prose,
  RelativeTime,
  SafeRouteLink,
  StatGrid,
  StatTile,
  StatusBadge,
  VisuallyHidden,
  type ColumnDef,
  type DataTableProps,
  type HealthPillProps,
  type KeyValueItem,
  type KeyValueListProps,
  type MeterProps,
  type StatTileProps,
  type StatusBadgeProps,
} from "@/ui";
