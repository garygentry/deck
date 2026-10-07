# Agent Instructions — deck

## Project Purpose

A generic, config-driven hub engine — the single human entry point to a home-lab estate: launch portal, inventory beside reality, drift, and monitoring overview.

## Getting Started

This project was scaffolded by forge-bootstrap. To continue development:

1. Review `forge.config.json` for the project configuration.
2. Run the forge pipeline (forge-1-prd → forge-0-epic → forge-3-specs → forge-4-backlog) to plan and implement features.
3. Use `forge-5-loop` to drive autonomous implementation.

## Conventions

- Follow the patterns established in the existing codebase.
- Keep `forge.config.json` up to date with any changes to stack or commands.

## Web UI conventions (apps/web)

See `docs/architecture/ui.md` for the full picture. The rules that matter most:

- Build screens from the `@/ui` library (`import { … } from "@/ui"`). Don't write one-off markup
  for things a pattern covers (tables, lists, cards, trees, filters, status, empty/loading/error).
- Status is a **tone** (`ok`/`warn`/`danger`/`info`/`pending`/`neutral`) mapped with
  `defineStatusMap`, always shown with an icon and text. Never pick colours directly.
- Style with Tailwind token classes only: no hex/`rgb()`/`oklch()` literals, and `style={…}`
  only for dynamic geometry. Icons come from `<Icon name>` with names from `ui/lib/icons.ts`.
- A page root and every pattern root carry `data-slot="…"`. There is one `h1` per page
  (`PageHeader`), and keyboard list navigation goes through `useListNavigation`.
- Test the a11y contract with React Testing Library role queries. Visual baselines are CI-only:
  refresh them with the `ci` workflow's `update_visuals` dispatch, never from a local run.
- `test/ui-guardrails.test.ts` enforces the mechanical rules; keep it green instead of
  allowlisting around it.

## Specs are pre-implementation

- Documents under `specs/` (PRDs, tech specs, numbered implementation specs) establish the backlog. They are **not** kept in sync with the code as it evolves.
- Do not flag or "fix" divergence between a finalized spec and the implementation — code is the source of truth for behavior.
- It's fine for `specs/` artifacts and `backlog.json` to reference specs for provenance, but implementation artifacts (source code, generated skills/agents, configs, docs) must not reference spec files, which may be archived or deleted after a feature ships.

## Tooling feedback (feature-forge / rauf)

This project is driven by the feature-forge pipeline and the rauf loop. Help improve those tools by capturing friction as you hit it — papercuts included, not just outright bugs.

- **When to flag:** any forge/rauf command, skill, agent, or prompt that is confusing, buggy, missing a capability, forces a workaround, or produces a surprising result.
- **Where to file** — route by which tool the friction is with:
  - feature-forge (pipeline stages, forge skills/agents): https://github.com/garygentry/feature-forge/issues
  - rauf (the autonomous loop runner, `rauf` CLI): https://github.com/garygentry/rauf/issues
- **How:** capture it while fresh — *what you ran / what you expected / what actually happened / a fix idea* — then propose a titled issue and file it with `gh issue create` **on the human's go-ahead, not silently.**
- **In an autonomous rauf iteration:** do **not** open issues mid-loop. Note the friction in `progress.md` for the human to triage later.

<!-- rauf:agents:start -->
## Autonomous Loop (Rauf)

This repository uses **rauf**, an autonomous coding loop. When you are running as a
rauf loop iteration, follow these operational rules. They are host-agnostic — they
apply whichever coding agent (Claude, Codex, Gemini, …) drives the iteration.

### Reading Your Task
1. Read `.rauf/RAUF.md` for detailed per-iteration instructions
2. Read the backlog (`.rauf/backlog.json`) — find the current `in_progress` item
3. The item's `acceptanceCriteria` define "done" for this iteration

### Working
4. Implement the changes described in the item's description
5. Follow acceptance criteria precisely — each one must pass
6. Run the verification command before considering work complete

### Completing
7. If all acceptance criteria pass: output `RAUF_DONE` as your final line
8. If blocked (missing dependency, unclear requirement): output `RAUF_BLOCKED:<reason>`
9. If human input needed (API key, design decision): output `RAUF_NEEDS_HUMAN:<reason>`
10. Do NOT commit or stage — the iteration agent never commits or stages; the loop runner owns the commit. Leave your changes in the working tree.

> Output the signal on a line by itself, as your final line — that's the safest
> habit. The runner scans backwards from the end and uses the **last** signal
> line, so trailing text after it (a commit message, a summary) does **not** break
> detection.

### Rules
- ONE item per iteration — do not work on multiple items
- Do not modify `backlog.json` — the loop runner manages status
- Do not modify `state.json` — the loop runner manages state
- Read `progress.md` for accumulated project learnings
- Append new learnings to `progress.md` if you discover important patterns

### Delegation
- If a backlog item carries `agentDelegation` and your host agent provides a
  subagent/delegation mechanism, use it to parallelize the independent subtasks;
  if it does not, complete the subtasks inline in the main session.
- You (the main agent) own the `RAUF_*` exit signal — delegated subtasks do not emit it.

### Model Selection
The runner picks the model by precedence (highest wins):
`item.model` > `--model` / options > project default > provider default.
(`rauf loop run --no-model` ignores `item.model` for one run — useful for running
a backlog whose items carry Claude-only tier aliases under a non-Claude `--agent`.)
<!-- rauf:agents:end -->
