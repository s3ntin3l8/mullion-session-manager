# Project briefing, skills, and reviewer subagents

Three related features let a project carry its own agent-facing tooling —
standing operating instructions, a project-specific skill, and a reviewer
subagent — into every session Mullion spawns against it, in every agent CLI
Mullion hosts (Claude Code, Codex, opencode, agy). None of this is specific
to Mullion's own repo: it's the general mechanism that makes "apply Mullion's
tooling to any other repo" actually work, whether that repo has ever heard of
Mullion or not.

This is the feature currently otherwise undocumented outside source comments
— this page is the missing doc the `hook-adapters/mullion-bundle.ts` and
`project-briefing.ts`/`project-tooling.ts` headers point at.

## AGENTS.md leads

Issue #942 made `AGENTS.md` a project's single source of truth for standing
operating instructions. There is no read-side "committed briefing" mechanism
in `project-briefing.ts` at all anymore (it was removed by #942, along with
the old `AGENTS.md` → `CLAUDE.md` → `.agents/briefing.md` fallback chain); a
project that wants standing instructions for agents just writes them into
`AGENTS.md` like it would for a human contributor.

**Not every CLI reads `AGENTS.md` natively.** Codex, opencode, and agy do —
Mullion never parses it, extracts a region, or re-injects a copy of its
content for those three. **Claude Code does not**: its own memory docs are
explicit — "Claude Code reads `CLAUDE.md`, not `AGENTS.md`" — confirmed
empirically (a session with both files present at a repo root loads only
`CLAUDE.md`). That's why `CLAUDE.md` is scaffolded as a one-line
`@AGENTS.md` **import**, not a prose pointer: a prose "read AGENTS.md" line
relies on the agent choosing to open the file (the exact failure this repo's
own `hooks.ts` documents for a different injection path), while `@AGENTS.md`
is expanded by Claude Code into the session's auto-loaded context at launch
— see "Scaffolding it into the repo instead" below.

`AGENTS.override.md` is the one file that can still silently shadow
`AGENTS.md` (Codex reads it _instead of_ `AGENTS.md` when it exists —
`src/services/agent-rules.ts`'s precedence table); the scaffold no longer
offers it as an option, though an existing, hand-authored one is left
untouched. `scripts/check-briefing-sync.mjs` (wired into `make lint`/
pre-commit for this repo) fails loud if `CLAUDE.md`, `GEMINI.md`, or
`AGENTS.override.md` ever re-acquires a content-bearing copy of the old
`<!-- mullion:briefing:start/end -->` region.

There is no `GEMINI.md` in this repo: agy reads project-scope `AGENTS.md`
natively (verified empirically — `agy` in this repo, run with
`--new-project` to register it and answer a repo-specific question, cited
`AGENTS.md` as its source), so a `GEMINI.md` pointer to the same file would
be redundant. For the same reason, the scaffold (below) no longer offers a
`GEMINI.md` mirror option at all
([issue #978](https://github.com/s3ntin3l8/mullion-session-manager/issues/978));
an existing, hand-authored `GEMINI.md` in a target repo is left untouched,
same as `AGENTS.override.md` above.

## The pinned note

A project can additionally set a short, **always-additive** note from the
UI (see below) — never a competing alternate to `AGENTS.md`, never a file,
never anything with precedence rules. When set, it's pushed on top of
whatever `AGENTS.md` already told the agent, at the start of every session;
when unset, nothing extra is pushed. The resolved note is clamped to 512
bytes (`MAX_BRIEFING_BYTES`) and written to a per-session copy
(`<sessionsDir>/<id>.briefing.md`) at spawn time, which every hook
adapter's own injection mechanism reads from — a live model turn, not a
file an agent has to go looking for (see [`agent-hooks.md`](agent-hooks.md)
for the per-CLI injection channel).

## Authoring it from the UI instead

The **Mullion Briefing** panel (Command Palette → "Mullion Briefing:
\<project\>", or a project-scoped dockview panel) lets you author a pinned
note, a skill, and a reviewer subagent per project, stored as one row in the
`project_tooling` table (`src/services/project-tooling.ts`), with **no repo
write**:

- **Pinned note** — a short, plain-text note, capped at 512 bytes
  (`MAX_PROJECT_BRIEFING_FIELD_BYTES`) — deliberately small: this is a
  live "pay attention to this" note, not a document. Deleting the row (not
  the same as saving an empty string — see `deleteProjectBriefing`'s own
  doc comment) simply stops the note from being pushed at all; there is no
  file to "fall back" to.
- **Skill** — a project-specific Claude Code/opencode skill (raw
  `SKILL.md` content: YAML frontmatter with `name`/`description`, then a
  Markdown body).
- **Reviewer agent** — a project-specific reviewer subagent, in the same
  frontmatter shape Claude Code's own subagent files use
  (`name`/`description`/`tools`/`model`, then the review-instructions body
  — `.claude/agents/mullion-reviewer.md` in this repo is the worked
  example the UI's starter template is derived from).

Each of the three fields is independent — clearing one leaves the other two
on the same row untouched. All three are resolved on the **primary** (where
the DB lives) at session-spawn time and threaded through the spawn request
body itself, the same channel `seedPrompt` already used — this matters on
multi-host: an **agent**-role process has no DB of its own, so anything
resolved from it would otherwise silently resolve to nothing on a
remote-hosted project.

## Authoring it from the CLI / MCP

For automation, the same per-project row is reachable from the CLI and MCP
servers without going through the UI. Both surfaces default to reading
(equivalent to the panel's initial fetch); passing one of `--briefing`,
`--skill`, or `--reviewer` switches each to an upsert, and any subset of
the three is independent — the same "clear one, leave the others" guarantee
the UI gives.

CLI:

```sh
# Read (all three fields + whether the row exists)
mullion project tooling <projectId>

# Write: any of --briefing / --skill / --reviewer, each takes a path
# or "-" for stdin. Only one flag may read from stdin per invocation.
mullion project tooling <projectId> \
  --briefing ./briefing.md \
  --skill ./SKILL.md \
  --reviewer ./reviewer.md
```

MCP tools (full scope only — these are operator-side, not available at
session scope, same posture `list_projects` already takes):

- `get_project_tooling(projectId)` — returns
  `{briefing?, skill?, reviewerAgent?}`, each a string or `null` (the same
  shape the REST `GET /api/projects/:id/tooling` returns — `null` is the
  ordinary "not authored yet" case per field, not a missing row).
- `set_project_tooling(projectId, briefing?, skill?, reviewerAgent?)` —
  upserts whichever fields are passed; the top-level `ok` is `false` if
  any individual field's upsert failed. The MCP tool surfaces that as a
  generic tool error — per-field diagnostics (which field rejected and
  why) are not exposed through this tool. If a partial-failure caller
  needs that detail, use the CLI: `mullion project tooling <id>
--briefing ... --skill ...` prints the full reply including each
  per-field result.

Both are thin wrappers over the matching control-socket ops — see
[`socket-api.md`](socket-api.md)'s `projects.get_tooling`/`projects.set_tooling`
entries.

## How the skill and reviewer actually reach a session

Delivery is per-CLI, since none of the four agents share a config format or
an ephemeral-overlay mechanism:

|                   | Claude Code                                       | opencode                                   | codex                | agy                  |
| ----------------- | ------------------------------------------------- | ------------------------------------------ | -------------------- | -------------------- |
| Project skill     | composed into a per-session `--plugin-dir` bundle | `skills.paths` config key, ephemeral       | no ephemeral overlay | no ephemeral overlay |
| Reviewer subagent | same composed bundle, `agents/<name>.md`          | translated, `<CONFIG_DIR>/agent/<name>.md` | none                 | none                 |

- **Claude Code**: `hook-adapters/mullion-bundle.ts`'s
  `composeClaudeSessionBundle` materializes a per-session plugin directory —
  the shipped bundle skills (see `agent-guide.md`) plus, when set,
  the project's own skill under `skills/<frontmatter-name>/SKILL.md` and
  reviewer under `agents/<frontmatter-name>.md` — and points `--plugin-dir`
  at it instead of the static shipped bundle. If this install hasn't shipped
  a bundle at all, a minimal manifest is synthesized so the project's own
  content still gets through.
- **opencode**: the project skill rides the same `skills.paths` config key
  (set via `OPENCODE_CONFIG_CONTENT`) the shipped bundle already uses, just
  pointed at an extra, session-scoped directory. The reviewer subagent is
  **translated**, not passed through verbatim — opencode's own
  `agent/<name>.md` config schema hard-rejects Claude Code's
  `tools:`/`model:` frontmatter fields at config-load time (verified
  empirically: a bare `tools: Read, Grep, ...` string throws
  `Configuration is invalid ... Expected object | undefined`, and the
  session never starts at all) — `deriveOpenCodeReviewerAgentFile` strips
  it down to `description`/`mode: subagent` plus the body before writing it.
- **codex and agy**: neither has an ephemeral per-project overlay — their
  own project-scope skill discovery is a fixed, workspace-relative
  `.agents/skills/<name>/SKILL.md` path in the repo itself, and neither has
  any subagent concept at all. There's no way to deliver a project skill to
  either without writing into the project's own repo — see the next
  section — and no way to deliver a reviewer subagent to either at all.

The Mullion Briefing panel shows codex/agy as "requires repo setup" for the
skill field for exactly this reason.

## Scaffolding it into the repo instead

For codex/agy (which need a real repo write regardless), or for any team
that would rather commit its Mullion tooling and share it via git than
author it per-project in Mullion's own UI, the **Scaffold Mullion**
panel (Command Palette → "Scaffold Mullion: \<project\>") turns the same
three artifacts into a real, reviewable pull request:

1. **Preview** computes the target file set — a scaffolded `AGENTS.md`
   briefing region (created fresh, or upserted in place if the file
   already has one), a **`CLAUDE.md` `@AGENTS.md` import** (unconditional,
   same reasoning as `AGENTS.md` itself — without it, a Claude Code session
   in the target repo would never see `AGENTS.md`'s content at all), a
   starter `.claude/skills/<slug>/SKILL.md`, a starter
   `.claude/agents/<slug>-reviewer.md`, and a `.agents/skills/<slug>` mirror
   for codex's/agy's own project-scope discovery — writes it into a scratch
   worktree under `.mullion-worktrees/`, and shows the diff. One more entry
   is opt-in: a short pointer paragraph upserted into `CONTRIBUTING.md`
   (created fresh if the project doesn't have one yet) pointing at
   `AGENTS.md`'s Workflow Conventions section, since that file's own
   process-rules section otherwise drifts from `AGENTS.md` the same way
   `CLAUDE.md` used to. **Never clobbers content that's already there**:
   only the `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` marked regions are
   designed for repeated safe upserts (that's the whole point of the marker
   delimiters, and each pointer/import touches nothing outside its own
   marked region) — including a target repo that already has its own
   `CLAUDE.md`/`AGENTS.md` content with real overlap: the import is
   appended, so the agent then loads both in full, and the preview diff is
   what lets a reviewer catch and drop that if it's unwanted before
   merging; the skill, reviewer, and an optional starter `.crs/dock.json`
   (see [`dock.md`](dock.md)) are each "create once, never overwrite" — a
   re-scaffold over a repo that already committed or hand-edited them
   leaves that content alone.
2. **Apply** commits the previewed worktree and either opens a pull
   request (reusing Task Master's own promote path — push the branch,
   `createPullRequest`, with the same 422-then-recover-the-existing-PR
   handling a re-applied promote already needs) or, if no GitHub
   remote/token is configured, leaves it as a local branch you push
   yourself.

The scaffold does not emit a `check-briefing-sync.mjs`-equivalent guard
script into the target repo at all — `scripts/check-briefing-sync.mjs` (the
script that guards `CLAUDE.md`/`GEMINI.md`/`AGENTS.override.md` against
re-acquiring a content-bearing briefing region — see "AGENTS.md leads"
above) is specific to this repo's own `make lint`/pre-commit wiring, and
`scaffoldableRelPaths` never reads/writes a target repo's own
`package.json` either way, so a copied-in script would be unwired there
regardless. A team that wants the same guard in its own repo can copy
`scripts/check-briefing-sync.mjs` and wire it into its own lint/pre-commit
setup by hand.

The `.agents/skills/<slug>` mirror defaults to a **plain file copy** of the
skill content, not a symlink — a symlink is a review-hostile diff, breaks on
a Windows checkout without `core.symlinks`, and trips some CI file scanners.
Mullion's own repo symlinks itself deliberately; imposing that choice on
someone else's repo is a different decision, so it's offered as an explicit
opt-in in the Scaffold panel instead.

Scaffolding is currently **local-host projects only** — there's no primitive
yet for writing arbitrary file content onto a _remote_-hosted project's
filesystem (`host-git.ts` only has status/base-ref/push/repo-ref today); a
remote-hosted project's scaffold request gets a clear `501`, not a silent
no-op. Tracked in
[issue #895](https://github.com/s3ntin3l8/mullion-session-manager/issues/895).

## Settings

Two independent toggles under **Settings → Sessions** (default **on** for
both):

- **Inject project briefing** — gates the pointer/injection only; the
  per-session file is always written regardless, so turning this off
  doesn't affect the file's own existence, just whether an agent's own
  SessionStart channel is told to look at it.
- **Inject Mullion tooling bundle** — gates the whole `--plugin-dir`/
  `skills.paths` delivery mechanism for both the shipped bundle skills
  and any project skill/reviewer subagent. Unlike the briefing
  toggle, there's no separate per-skill toggle to reconcile this with — a
  plugin-sourced Claude Code skill is invisible to Mullion's own Skills
  Manager, so this one setting really does govern the whole thing.

See also **Inject agent guide** (`docs/agent-guide.md`'s own injection,
independent of both settings above) and `docs/configuration.md` for every
`@fastify/env`-validated setting — these three toggles are DB-backed runtime
Settings, not environment variables, so they don't appear in that table.

**Per-project overrides (issue #884):** the agent-guide and project-briefing
toggles — but not the tooling-bundle one, which gates a materially bigger
mechanism (managed host-level installs for codex/agy, not just a
SessionStart text injection) — can also be set per project, from the
project's own settings panel (`ProjectBriefingPanel.tsx`'s "Session
injection for this project" row). `null` (the default) inherits the global
setting above; an explicit true/false overrides it for every session under
that project. Resolved once, on the primary, at session-creation time — a
toggle flip (global or per-project) takes effect on the session's _next_
spawn, not retroactively for one already running.
