import type {
  ClaudeUsage,
  CodexHistory,
  CodexUsage,
  LlmUsageResponse,
  UsageBar,
  UsageSourceStatus,
} from "@deck/server/llm-usage";
import { useState, type FunctionComponent, type JSX } from "react";
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  EmptyState,
  ErrorState,
  Icon,
  KeyValueList,
  List,
  ListItem,
  LoadingState,
  Meter,
  PageHeader,
  RelativeTime,
  Section,
  StatGrid,
  StatTile,
  StatusBadge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useNow,
  usePageHeadingId,
} from "@/ui";

import {
  BAR_SOURCE_NAMES,
  POLL_MODE_UI,
  SEVERITY_UI,
  SOURCE_NAMES,
  SOURCE_STATE_UI,
  formatResetIn,
  formatTokens,
  toIso,
} from "./status.js";
import { useLlmUsage, usageStore, type UsageStore } from "./store.js";

const PAGE_TITLE = "LLM usage";
const HISTORY_DAYS = 14;

export interface LlmUsagePageProps {
  /** Injected in tests; production uses the shared store. */
  store?: UsageStore;
  /** Fixed clock for tests and snapshots; production ticks. */
  now?: number;
}

/**
 * `/usage`: Claude Code and Codex plan limits as meters, with the Codex usage history,
 * local transcript token counts and per-source diagnostics. Every number shows where it
 * came from and how old it is, because the sources refresh on very different clocks.
 */
export const LlmUsagePage: FunctionComponent<LlmUsagePageProps> = ({ store = usageStore, now: fixedNow }) => {
  const view = useLlmUsage(store);
  const ticking = useNow(15_000, fixedNow === undefined);
  const now = fixedNow ?? ticking + (view.status === "ready" ? view.clockOffsetMs : 0);
  const headingId = usePageHeadingId(PAGE_TITLE);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    setRefreshing(true);
    void store.refresh().finally(() => setRefreshing(false));
  };
  const enabled = view.status === "ready" && view.data.enabled;

  return (
    <section data-slot="llm-usage-page" aria-labelledby={headingId} className="flex flex-col gap-8">
      <PageHeader
        title={PAGE_TITLE}
        description="Plan limits for Claude Code and Codex, and where each number comes from."
        actions={enabled ? (
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            <Icon name="refresh-cw" size={14} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        ) : undefined}
      />
      <PageBody view={view} now={now} onRetry={() => void store.reload()} />
    </section>
  );
};

function PageBody({ view, now, onRetry }: { view: ReturnType<typeof useLlmUsage>; now: number; onRetry: () => void }) {
  if (view.status === "loading") return <LoadingState label="Loading LLM usage" />;
  if (view.status === "error") {
    return <ErrorState title="LLM usage is unavailable" message={view.message} onRetry={onRetry} />;
  }
  const { data, error } = view;
  if (!data.enabled) {
    return (
      <EmptyState
        icon="gauge"
        title="LLM usage is not configured"
        description="Add a modules.llm-usage section to the estate config to track Claude Code and Codex plan limits."
      />
    );
  }
  return (
    <>
      {error !== null ? (
        <Callout tone="warn" title="Showing the last good reading" role="status">
          The latest refresh failed ({error}).
        </Callout>
      ) : null}
      {data.claude ? <ClaudeSection claude={data.claude} now={now} /> : null}
      {data.codex ? <CodexSection codex={data.codex} now={now} /> : null}
      <DiagnosticsSection data={data} now={now} />
    </>
  );
}

function PlanBadge({ plan }: { plan: string | null }) {
  return plan ? <Badge variant="secondary">Plan: {plan}</Badge> : null;
}

function UsageMeters({ bars, sources, now }: { bars: UsageBar[]; sources: UsageSourceStatus[]; now: number }) {
  if (bars.length === 0) {
    const notApplicable = sources.some((s) => s.state === "not-applicable");
    // Name the first source that explains the gap (e.g. "sign-in needed"), if any.
    const blocker = sources.find((s) => (s.state === "not-configured" || s.state === "error") && s.detail !== null);
    return (
      <EmptyState
        compact
        icon="hourglass"
        title={notApplicable ? "Plan limits do not apply" : "No usage reported yet"}
        description={notApplicable
          ? "This account is not on a plan with usage limits (for example, an API key)."
          : blocker
            ? `${SOURCE_NAMES[blocker.id]}: ${blocker.detail}. See Diagnostics for each source.`
            : "Numbers appear after the first successful poll or push. See Diagnostics for each source."}
      />
    );
  }
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {bars.map((bar) => {
        const severity = SEVERITY_UI[bar.severity];
        const percent = Math.round(bar.percent);
        return (
          <Meter
            key={bar.key}
            label={bar.label}
            value={bar.percent}
            tone={severity.tone}
            icon={severity.icon}
            valueText={`${percent}%`}
            srValueText={`${percent}% used, ${severity.label.toLowerCase()}`}
            meta={(
              <>
                {bar.resetsAt !== null ? `Resets ${formatResetIn(bar.resetsAt, now)} · ` : null}
                {bar.reached ? "Limit reached · " : null}
                {`via ${BAR_SOURCE_NAMES[bar.src]}, `}
                <RelativeTime value={toIso(bar.observedAt)} now={now} />
              </>
            )}
          />
        );
      })}
    </div>
  );
}

function ClaudeSection({ claude, now }: { claude: ClaudeUsage; now: number }) {
  const t = claude.transcripts;
  return (
    <Section id="claude" title="Claude Code" variant="card" actions={<PlanBadge plan={claude.plan} />}>
      <UsageMeters bars={claude.bars} sources={claude.sources} now={now} />
      {t ? (
        <Section
          id="claude-transcripts"
          level={3}
          title="Local transcripts"
          description={`Token counts from ${t.files} transcript files; consumption, not quota.`}
        >
          <StatGrid>
            <StatTile label="Output tokens (5h)" value={formatTokens(t.window5h.output)} subLabel={`${t.window5h.messages} messages`} />
            <StatTile label="Output tokens (7d)" value={formatTokens(t.window7d.output)} subLabel={`${t.window7d.messages} messages`} />
            <StatTile label="Input tokens (7d)" value={formatTokens(t.window7d.input)} />
            <StatTile label="Cache reads (7d)" value={formatTokens(t.window7d.cacheRead)} />
          </StatGrid>
        </Section>
      ) : null}
    </Section>
  );
}

function CodexSection({ codex, now }: { codex: CodexUsage; now: number }) {
  return (
    <Section
      id="codex"
      title="Codex"
      variant="card"
      actions={(
        <span className="flex flex-wrap gap-2">
          <PlanBadge plan={codex.plan} />
          {codex.resetCredits !== null ? <Badge variant="outline">Reset credits: {codex.resetCredits}</Badge> : null}
        </span>
      )}
    >
      <UsageMeters bars={codex.bars} sources={codex.sources} now={now} />
      {codex.history ? <CodexHistorySection history={codex.history} /> : null}
    </Section>
  );
}

function CodexHistorySection({ history }: { history: CodexHistory }) {
  const days = history.days.slice(-HISTORY_DAYS).reverse();
  const stat = (value: number | null, format: (n: number) => string = formatTokens) =>
    value === null ? "—" : format(value);
  return (
    <Section id="codex-history" level={3} title="Usage history">
      <StatGrid>
        <StatTile label="Lifetime tokens" value={stat(history.lifetimeTokens)} />
        <StatTile label="Peak day" value={stat(history.peakDailyTokens)} />
        <StatTile label="Current streak" value={stat(history.currentStreakDays, (n) => `${n}d`)} />
        <StatTile label="Longest streak" value={stat(history.longestStreakDays, (n) => `${n}d`)} />
      </StatGrid>
      {days.length > 0 ? (
        <Table>
          <TableCaption>Tokens per day, most recent first (last {days.length} days)</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Day</TableHead>
              <TableHead scope="col" className="text-right">Tokens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((day) => (
              <TableRow key={day.date}>
                <TableCell>{day.date}</TableCell>
                <TableCell className="text-right tabular-nums">{day.tokens.toLocaleString("en")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </Section>
  );
}

function SourceList({ sources, now }: { sources: UsageSourceStatus[]; now: number }): JSX.Element {
  return (
    <List variant="divided">
      {sources.map((source) => (
        <ListItem
          key={source.id}
          title={SOURCE_NAMES[source.id]}
          description={source.detail ?? undefined}
          meta={source.observedAt !== null ? <RelativeTime value={toIso(source.observedAt)} now={now} /> : undefined}
          actions={<StatusBadge {...SOURCE_STATE_UI[source.state]} size="sm" />}
        />
      ))}
    </List>
  );
}

function DiagnosticsSection({ data, now }: { data: LlmUsageResponse; now: number }) {
  const sources = [...(data.claude?.sources ?? []), ...(data.codex?.sources ?? [])];
  const attention = sources.filter((s) => s.state === "error" || s.state === "stale").length;
  const mode = POLL_MODE_UI[data.poll.mode];
  return (
    <Section id="diagnostics" title="Diagnostics">
      <Disclosure label="Sources and polling" count={attention > 0 ? attention : undefined}>
        <div className="flex flex-col gap-4">
          <KeyValueList
            items={[
              { label: "Upstream polling", value: <StatusBadge {...mode} size="sm" /> },
              {
                label: "Next poll",
                value: data.poll.nextPollAt === null
                  ? "Paused until someone views usage"
                  : formatResetIn(data.poll.nextPollAt, now).replace("reset due", "due now"),
              },
              { label: "Consecutive errors", value: String(data.poll.consecutiveErrors) },
              { label: "Thresholds", value: `warn at ${data.thresholds.warn}%, danger at ${data.thresholds.danger}%` },
            ]}
          />
          {data.claude ? (
            <Section level={3} title="Claude Code sources">
              <SourceList sources={data.claude.sources} now={now} />
            </Section>
          ) : null}
          {data.codex ? (
            <Section level={3} title="Codex sources">
              <SourceList sources={data.codex.sources} now={now} />
            </Section>
          ) : null}
        </div>
      </Disclosure>
    </Section>
  );
}
