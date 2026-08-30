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

## The committed briefing region

A project can carry standing instructions for agents in a marker-delimited
region of its own `AGENTS.md` or `CLAUDE.md` (or a dedicated,
marker-free `.agents/briefing.md`):

```markdown
<!-- mullion:briefing:start -->

Run `npm test` before committing. Never touch `generated/`.
<!-- mullion:briefing:end -->
```

`resolveProjectBriefing` (`src/services/project-briefing.ts`) tries
`AGENTS.md`, then `CLAUDE.md`, then `.agents/briefing.md`, first match wins —
`AGENTS.md`/`CLAUDE.md` both require the marker pair (an ordinary,
unmarked instructions file is never dumped whole into a session's context);
`.agents/briefing.md` needs no marker at all, since a dedicated file is
already an explicit opt-in. The resolved body is clamped to 4 KiB
(`MAX_BRIEFING_BYTES`) and written to a per-session copy
(`<sessionsDir>/<id>.briefing.md`) at spawn time, which every hook
adapter's own injection mechanism reads from — a live model turn, not a
file an agent has to go looking for (see
[`agent-hooks.md`](agent-hooks.md) for the per-CLI injection channel and
`agent-guide.md`'s own "Live end-to-end verification" section for a
real-session confirmation across all four CLIs).

`GEMINI.md` is deliberately **not** one of the read candidates above —
agy is the one CLI here that also loads project files _natively_,
independent of anything Mullion injects, and it reads `GEMINI.md` for
that. Keeping `GEMINI.md`'s own `mullion:briefing` region byte-identical
to `AGENTS.md`'s (`scripts/check-briefing-sync.mjs`, wired into `make
lint`/pre-commit for this repo) means agy's native read and Mullion's own
injection never show it two different sets of instructions, even if
Mullion's injection were ever disabled. `AGENTS.override.md` (Codex's own
override file, when a project uses one) gets the identical treatment for
the same reason.

## Authoring it from the UI instead

A project's briefing doesn't have to be a committed file at all — the
**Mullion Briefing** panel (Command Palette → "Mullion Briefing: \<project\>",
or a project-scoped dockview panel) lets you author a briefing, a skill, and
a reviewer subagent per project, stored as one row in the `project_tooling`
table (`src/services/project-tooling.ts`), with **no repo write**:

- **Briefing** — a plain-text operating-instructions block, capped at 8 KiB.
  Precedence: once a row exists, it wins over the committed region above —
  it's the more recently and deliberately authored artifact. Deleting the
  row (not the same as saving an empty string — see
  `deleteProjectBriefing`'s own doc comment) falls back to the committed
  region again, if any.
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

## How the skill and reviewer actually reach a session

Delivery is per-CLI, since none of the four agents share a config format or
an ephemeral-overlay mechanism:

|                   | Claude Code                                       | opencode                                   | codex                | agy                  |
| ----------------- | ------------------------------------------------- | ------------------------------------------ | -------------------- | -------------------- |
| Project skill     | composed into a per-session `--plugin-dir` bundle | `skills.paths` config key, ephemeral       | no ephemeral overlay | no ephemeral overlay |
| Reviewer subagent | same composed bundle, `agents/<name>.md`          | translated, `<CONFIG_DIR>/agent/<name>.md` | none                 | none                 |

- **Claude Code**: `hook-adapters/mullion-bundle.ts`'s
  `composeClaudeSessionBundle` materializes a per-session plugin directory —
  the shipped `mullion-host` skill (see `agent-guide.md`) plus, when set,
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
   already has one), a starter `.claude/skills/<slug>/SKILL.md`, a starter
   `.claude/agents/<slug>-reviewer.md`, and a `.agents/skills/<slug>` mirror
   for codex's/agy's own project-scope discovery — writes it into a scratch
   worktree under `.mullion-worktrees/`, and shows the diff. **Never
   clobbers content that's already there**: only the briefing region is
   designed for repeated safe upserts (that's the whole point of the
   marker delimiters); the skill, reviewer, and an optional starter
   `.crs/dock.json` (see [`dock.md`](dock.md)) are each "create once,
   never overwrite" — a re-scaffold over a repo that already committed or
   hand-edited them leaves that content alone.
2. **Apply** commits the previewed worktree and either opens a pull
   request (reusing Task Master's own promote path — push the branch,
   `createPullRequest`, with the same 422-then-recover-the-existing-PR
   handling a re-applied promote already needs) or, if no GitHub
   remote/token is configured, leaves it as a local branch you push
   yourself.

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
  `skills.paths` delivery mechanism for both the shipped `mullion-host`
  skill and any project skill/reviewer subagent. Unlike the briefing
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
