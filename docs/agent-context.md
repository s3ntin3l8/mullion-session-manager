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

> Filename note (issue #1215): this file was renamed from
> `project-briefing.md` to `agent-context.md`, a broader name covering both
> the pinned note below (which still legitimately carries the "briefing"
> name — see "The pinned note") and the scaffold's own delivery paths (which
> don't; see "Two independent opt-outs" under "Workflow conventions" below).
> The rename is about the _filename_, not about renaming the pinned-note
> feature itself.

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
untouched. `scripts/check-scaffold-region-sync.mjs` (wired into `make lint`/
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

**For skill/reviewer specifically, prefer Scaffold Mullion instead**
(issue #1082(b)) — since #956 shipped agent-assisted scaffold-content
generation (a real agent turn analyzing the actual codebase), free-text
authoring here produces lower-quality, generic content by comparison, and
the ProjectBriefingPanel UI itself now leads with a "use Scaffold Mullion"
recommendation on those two fields. These two fields remain fully
functional and are not deprecated — a manual override still has real uses
(a repo Scaffold Mullion can't reach, or content the generated version
doesn't quite get right) — they're just no longer the first thing to reach
for. See "Scaffolding it into the repo instead" below.

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

|                   | Claude Code                                       | opencode                                   | codex                                                       | agy                                                       |
| ----------------- | ------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------- |
| Project skill     | composed into a per-session `--plugin-dir` bundle | `skills.paths` config key, ephemeral       | committed scaffold mirror only, never live                  | committed scaffold mirror only, never live                |
| Reviewer subagent | same composed bundle, `agents/<name>.md`          | translated, `<CONFIG_DIR>/agent/<name>.md` | committed scaffold mirror, conditional (issue #943 — below) | none — no committed path exists for it (permanent, #1083) |

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
  `.agents/skills/<name>/SKILL.md` path in the repo itself. Codex has no
  static per-agent config file at all (`bundle-sync.ts`'s own comment, spike
  #946); a live spike (issue #943, 2026-09-09) confirmed what it has
  instead: `spawn_agent` carries no skill-name argument of its own — the
  _calling_ model composes a free-text reference to a skill by name/path in
  its delegation prompt, and the sub-agent it spawns resolves and follows
  that skill on its own. agy _does_ have a static agent file — a single flat
  `<name>.md` file under its host-global agents directory
  (`resolveAgyGlobalAgentsDir()`, spike #950) — but that path only ever
  carries Mullion's own shipped bundle agent (`bundle-sync.ts`'s
  `AGENT_TARGETS`), never a project-specific one; nothing routes a project's
  own reviewer content there today, and #943's 2026-09-05 spike confirmed
  agy has no project-scope agent discovery path either, with or without
  `--add-dir`. There's no way to deliver a project skill to either without
  writing into the project's own repo — see the next section.
  **The absence of a _live_ DB delivery channel is a permanent, structural
  gap, not a "not implemented yet" one**
  ([issue #1083](https://github.com/s3ntin3l8/mullion-session-manager/issues/1083)):
  agy has no documented env var to relocate its config directory at all
  (unlike Codex's `CODEX_HOME`, itself an all-or-nothing relocation, not a
  surgical one — see `codex.ts`'s own comment), and the only writable
  target for agy content, its host-global directory, is shared across
  every project on the host — writing one project's live DB content there
  would leak it into every other repo a session on that host opens agy in.
  So for **skill** content specifically, the scaffold's committed
  `.agents/skills/<slug>/SKILL.md` mirror (see "Scaffolding it into the
  repo instead" below) is the _only_ path that ever reaches codex or agy —
  editing the `project_tooling.skill` DB row after scaffolding changes
  nothing those two CLIs actually see until the scaffold is re-run (or,
  once a diff-aware refresh path lands, until someone explicitly triggers
  one). For **reviewer** content, codex and agy now diverge: codex gains a
  committed path — the scaffold also emits a translated copy of the
  reviewer at `.agents/skills/<slug>-reviewer/SKILL.md` (two-field SKILL.md
  frontmatter; issue #943), which `spawn_agent` delegation can discover the
  same way it discovers the project skill **for reviewer content with flat
  (single-line) frontmatter whose `description` carries the delegation
  clause** — a preserved reviewer with a block-scalar (`|`/`>`) description
  emits no mirror at all (see `deriveCodexReviewerSkillContent`'s own
  comment in `mullion-scaffold.ts`), and a freshly generated reviewer whose
  description drops the clause fails the generation gate before it ever
  reaches the scaffold (see `parseGeneratedOutput`'s clause check in
  `scaffold-generate.ts`) — a preserved, hand-edited reviewer has no
  equivalent gate, so its mirror can still land undiscoverable if a human
  edit removes the clause. agy
  gets none: the project-scope agent-discovery gap above rules out both the
  live DB channel and any committed scaffold path for agy specifically, and
  #943 dropped agy reviewer delivery as won't-implement rather than leaving
  it open — there is no known agy mechanism this could target. Either way,
  the Mullion Briefing panel's reviewer field itself stays inert for both
  CLIs — it's the _live_ DB channel, and neither CLI has one; only a
  scaffold re-run reaches codex's committed mirror. This whole bullet is
  deliberately scoped as documentation only: no further code change to
  `agy.ts`/`mullion-bundle.ts` is implied here, and the live-channel gap is
  only worth revisiting if agy ever gains a real per-session config channel.

The Mullion Briefing panel shows codex/agy as "requires repo setup" for the
skill field for exactly this reason.

## Scaffolding it into the repo instead

For codex/agy (which need a real repo write regardless), or for any team
that would rather commit its Mullion tooling and share it via git than
author it per-project in Mullion's own UI, the **Scaffold Mullion**
panel (Command Palette → "Scaffold Mullion: \<project\>") turns the same
three artifacts into a real, reviewable pull request:

1. **Preview** computes the target file set — a scaffolded `AGENTS.md`
   scaffold region (created fresh, or upserted in place if the file
   already has one), a **`CLAUDE.md` `@AGENTS.md` import** (unconditional,
   same reasoning as `AGENTS.md` itself — without it, a Claude Code session
   in the target repo would never see `AGENTS.md`'s content at all), a
   starter `.claude/skills/<slug>/SKILL.md`, a starter
   `.claude/agents/<slug>-reviewer.md`, a `.agents/skills/<slug>` mirror for
   codex's/agy's own project-scope skill discovery, and (issue #943) a
   `.agents/skills/<slug>-reviewer/SKILL.md` mirror of the reviewer,
   translated into SKILL.md's two-field frontmatter shape, for codex's own
   `spawn_agent` delegation to discover — writes it into a scratch worktree
   under `.mullion-worktrees/`, and shows the diff. If the target repo
   already has its own `AGENTS.override.md`, the preview surfaces a warning
   rather than silently proceeding: codex reads that file **instead of**
   `AGENTS.md` entirely, so the Workflow Conventions section this scaffold
   is about to commit into `AGENTS.md` would never reach codex sessions on
   that project — the scaffold never writes to `AGENTS.override.md` itself,
   this is disclosure only, so a human can add the conventions there by
   hand if codex needs to see them. One more entry is opt-in: a short
   pointer paragraph upserted into `CONTRIBUTING.md`
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
   leaves that content alone. Every freshly-written skill/reviewer file
   also carries a one-line `<!-- mullion:scaffold:<slug> -->` stamp right
   after its frontmatter (issue #1123) — a different marker family from
   `mullion:pointer:`/`mullion:briefing:` above (the second literal frozen
   at the wire-format level — see `SCAFFOLD_REGION_START`'s own doc comment
   in `mullion-scaffold.ts`), since it identifies a
   whole FILE as Mullion's own scaffold output rather than delimiting a
   region within one. It's what lets `createSessionRecord`'s
   committed-scaffold gate (see "How the skill and reviewer actually reach
   a session" above) tell "this repo's own scaffold wrote this file" apart
   from an unrelated skill/reviewer pair that merely happens to sit at the
   same path — falling back to presence alone (any file at that path,
   stamped or not) only when no stamped candidate is found, since a repo
   scaffolded before this stamp existed never gains one retroactively on
   its own.
2. **Apply** commits the previewed worktree and either opens a pull
   request (reusing Task Master's own promote path — push the branch,
   `createPullRequest`, with the same 422-then-recover-the-existing-PR
   handling a re-applied promote already needs) or, if no GitHub
   remote/token is configured, leaves it as a local branch you push
   yourself.

The scaffold does not emit a `check-scaffold-region-sync.mjs`-equivalent
guard script into the target repo at all — `scripts/check-scaffold-region-sync.mjs`
(the script that guards `CLAUDE.md`/`GEMINI.md`/`AGENTS.override.md`
against re-acquiring a content-bearing scaffold region — see "AGENTS.md
leads" above) is specific to this repo's own `make lint`/pre-commit
wiring, and `scaffoldableRelPaths` never reads/writes a target repo's own
`package.json` either way, so a copied-in script would be unwired there
regardless. A team that wants the same guard in its own repo can copy
`scripts/check-scaffold-region-sync.mjs` and wire it into its own lint/pre-commit
setup by hand.

The `.agents/skills/<slug>` mirror defaults to a **plain file copy** of the
skill content, not a symlink — a symlink is a review-hostile diff, breaks on
a Windows checkout without `core.symlinks`, and trips some CI file scanners.
Mullion's own repo symlinks itself deliberately; imposing that choice on
someone else's repo is a different decision, so it's offered as an explicit
opt-in in the Scaffold panel instead.

**Preview, apply, AND generate all work for both local and remote-hosted
projects.** Preview/apply (issue #895): `host-git.ts` gained
`resolveHostFileDiff`/`commitHostWipChanges`, and a new sibling
`host-files.ts` gained `readHostFiles`/`writeHostFiles` — the same
`(app, hostId, cwd, ...)` local-vs-remote dispatch shape as `host-git.ts`'s
existing status/base-ref/push/repo-ref primitives, routed to a remote host's
own filesystem via new `/internal/read-files`, `/internal/write-files`, and
`/internal/git-commit-wip` routes (mirroring the existing `/internal/git-push`
precedent). Worktree creation/removal/branch-deletion were already
host-dispatched via `SessionBackend` (issues #271/#484); #895 is what makes
the rest of this route's own read/write/diff/commit steps catch up to that.

`POST /api/projects/:id/setup/generate` (real agent-generated content)
needed a separate fix on top of #895 (issue #1101): unlike preview/apply, it
spawns a real agent CLI turn (`scaffold-generate.ts`'s
`generateScaffoldContent`), which used to always run on whichever host the
PRIMARY happens to be, not the project's own host — #895's
read/write/diff/commit primitives didn't cover that. `generateScaffoldContent`
now dispatches per host: for a local project it runs the sandboxed
create-scratch-worktree/spawn/teardown sequence
(`runGenerationTurnInScratchWorktree`) directly, in-process; for a
remote-hosted project it calls the same function via a new
`POST /internal/run-generation-turn` route (`RemoteHostClient.
resolveRunGenerationTurn`), which runs on the AGENT's own filesystem instead
— the identical sandboxing (`wrapWithSandbox`/`isSandboxCapable`) applies
either way, since both paths call the same underlying implementation. The
route always replies `200` with a discriminated `outcome` field
(`"ok" | "unsupported-agent" | "worktree-error" | "spawn-error"`) for an
application-level failure, rather than an HTTP status, so the primary can
reconstruct the exact same `UnsupportedGenerationAgentError`/
`GenerationWorktreeError`/`GenerationSpawnError` it would have thrown
locally.

## Workflow conventions (issue #937)

A fourth, related but structurally different feature: an install-wide "how
we work" policy (branch-vs-direct-commit, merge strategy, review process,
post-merge cleanup, ...), injected into every session's starting context
the same way the pinned note above is, unless a project has opted out.
Unlike the pinned note/skill/reviewer above, this is **not** a
`project_tooling` row and has **no per-project text** — a project that
wants to diverge from the install-wide convention already has `AGENTS.md`
for that (see "AGENTS.md leads" above), so a second, parallel per-project
text field would only duplicate what the file already does well. The only
per-project knob is a boolean: inject the global text, or don't.

- **The global text** lives at `settings.sessions.workflowConventionsText`
  (`src/services/settings.ts`), authored in **Settings → Sessions**. Empty
  by default — a fresh install has no opinion yet — and an empty value is
  its own independent "nothing to inject" gate, not just an uninteresting
  default.
- **Kickstarting and re-running it** uses a structured multiple-choice
  wizard ("Generate with wizard" in that same Settings row), not an agent
  turn and not a blank text box: workflow conventions are a small, finite
  set of well-known policy choices (`src/services/workflow-conventions.ts`'s
  `WORKFLOW_CONVENTION_QUESTIONS` — includes a `worktrees` question, whether
  to work in a dedicated git worktree per branch), a genuinely different
  shape of problem from the pinned note/skill/reviewer above, which need a
  human (or an agent, for #956's project-specific generation) because they
  require actual prose about a specific project. `buildWorkflowConventionsText`
  deterministically assembles the selected options' prose fragments — no
  agent, no network. The wizard's answers persist
  (`settings.sessions.workflowConventionAnswers`), so re-opening it after
  the first run starts on a review step of what's already answered instead
  of from scratch, and it detects when the stored text has since been
  hand-edited away from what those answers would generate — derived by
  comparing `buildWorkflowConventionsText(storedAnswers)` against the
  stored text, not a separate tracked flag — and warns before an apply
  would overwrite that edit. Applying still **overwrites** the text field
  in full; it's a "regenerate from these answers" action, not an ongoing
  synced mode.
- **The per-project toggle** is `projects.injectWorkflowConventions`
  (nullable boolean, `schema.ts`) — same shape as the two per-project
  overrides below: `null`/`true` = inject the global text, `false` =
  don't (this project's own `AGENTS.md` is authoritative instead). Set
  from the same "Session injection for this project" row the agent-guide/
  project-briefing toggles live in (`ProjectBriefingPanel.tsx`).
- **Delivery** rides the identical `[seed, tier-0, workflow-conventions,
pinned note]` `additionalContext` ordering `hooks.ts` composes for
  Claude Code/Codex/agy (see `agent-hooks.md`), and opencode's own
  `instructions[]` channel for the fourth CLI — see that adapter's own
  comment for why file presence alone (no separate ctx boolean) already
  encodes both the toggle and the "non-empty global text" gate.
- **The scaffold reads the same text, not a separate copy.** "Scaffolding
  it into the repo instead" above commits a `## Workflow Conventions`
  section into the target `AGENTS.md`, resolved from this exact global text
  (respecting the project's own `injectWorkflowConventions` opt-out) —
  `mullion-scaffold.ts`'s `workflowConventionsSection`. When the text is
  empty (a fresh install with no opinion authored yet, or a project that
  opted out before ever being scaffolded), it falls back to
  `buildWorkflowConventionsText(SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS)` — a
  fixed answer set covering 6 of `WORKFLOW_CONVENTION_QUESTIONS`'s 11
  questions (the other 5, including `worktrees`, are deliberately left
  unanswered — see that constant's own doc comment for why) — rather than
  committing nothing, so a freshly scaffolded repo still gets a reasonable
  starter instead of a blank section.
- **Staying in sync** — `projects.conventionsHash` stamps, at apply time,
  the hash of exactly what was committed; `GET /api/projects` compares it
  against what the _current_ global text (or defaults) would produce right
  now and surfaces `conventionsDrifted` when they no longer match, with a
  banner in Scaffold Mullion's own panel prompting a re-scaffold. Three
  states only: never scaffolded (`null` hash), up to date, or drifted — an
  opted-out project is never considered drifted, since by definition its
  committed text is no longer tracking the install-wide one.
- **Two independent opt-outs, not one (issue #1208).** It's tempting to
  read `injectWorkflowConventions` as covering "the committed `AGENTS.md`
  already has this text, stop injecting it too" — PR #1206 shipped exactly
  that as a post-apply checkbox, and Hermes review caught it as a data-loss
  bug before merge: that flag also gates text _resolution_ (the bullet
  above), so flipping it after a real scaffold made the drift check
  permanently false-positive and made its own "re-run Preview and Apply"
  banner silently overwrite the just-committed real text with the generic
  defaults on the next apply. The two questions are genuinely different and
  need genuinely different columns:
  - `injectWorkflowConventions === false` — **"my `AGENTS.md` is
    authoritative instead."** Feeds `resolveWorkflowConventionsText` /
    `resolveScaffoldWorkflowConventionsText`, which resolve to `""` (→ the
    scaffold defaults) for this project; `conventionsDrifted` is
    unconditionally `false`; a re-scaffold writes the generic defaults, not
    this install's real text.
  - `suppressConventionsInjectionAfterScaffold === true` — **"stop
    double-delivering, keep tracking."** Touches only
    `session-lifecycle.ts`'s per-session injection gate — it appears in
    neither resolver nor in the `conventionsDrifted` computation. Drift
    tracking keeps working exactly as before: if the install's global text
    later changes, this project still shows `conventionsDrifted: true`,
    and a re-scaffold still commits the real, current text. Deliberately
    **not** offered right after a successful apply — Hermes review caught
    that both apply modes land the scaffold on a scratch worktree branch
    (`git worktree add -b`, never `project.cwd`), so immediately after
    apply the project's real, checked-out `AGENTS.md` does not carry the
    text yet (PR mode's own notice says "before merging"); offering the
    toggle at that moment would let a user suppress injection for text that
    hasn't actually landed anywhere yet, silently delivering it neither way
    until the scaffold branch/PR is merged by hand. Instead it's toggleable
    only from the "Session injection for this project" row in
    `ProjectBriefingPanel.tsx` the other three toggles live in — a standing
    control the user reaches for once they know the merge has actually
    happened, not a one-time offer tied to the apply moment. That row also
    only renders while `injectWorkflowConventions` isn't `false` (opting out
    the other way makes this toggle meaningless); opting out clears this
    column back to `null` in the same PATCH, so a later re-enable of
    `injectWorkflowConventions` can't silently re-arm a suppression the user
    set before opting out and had no way to see while the row was hidden —
    Hermes review, round 2.

## Settings

Three independent toggles under **Settings → Sessions** (default **on** for
all three, except workflow conventions' own text default of ""):

- **Inject project briefing** — gates the pointer/injection only; the
  per-session file is always written regardless, so turning this off
  doesn't affect the file's own existence, just whether an agent's own
  SessionStart channel is told to look at it.
- **Inject Mullion tooling bundle** — gates the whole `--plugin-dir`/
  `skills.paths` delivery mechanism for both the shipped bundle skills
  and any project skill/reviewer subagent, and — since issue #941 — the
  boot-time host-local sync that installs the shipped bundle skills into
  each CLI's own global skill directory (see
  [`agent-guide.md`](agent-guide.md#where-your-skills-actually-come-from)).
  Unlike the briefing toggle, there's no separate per-skill toggle to
  reconcile this with — a plugin-sourced Claude Code skill is invisible to
  Mullion's own Skills Manager, so this one setting really does govern the
  whole thing.
- **Workflow conventions** (issue #937, above) — a free-text field, not a
  boolean toggle: injection is gated on that text being non-empty (and the
  per-project toggle not being explicitly off), not on a separate on/off
  switch of its own.

See also **Inject agent guide** (`docs/agent-guide.md`'s own injection,
independent of every setting above) and `docs/configuration.md` for every
`@fastify/env`-validated setting — these are DB-backed runtime Settings,
not environment variables, so they don't appear in that table.

**Per-project overrides (issue #884, extended by #937):** the agent-guide,
project-briefing, and workflow-conventions toggles — but not the
tooling-bundle one (issue #933 asked for it and its closing comment records
why not: codex/agy's managed installs write into one shared skill root per
CLI per host, not a root per project, so a per-project value has nothing
project-scoped to vary, and since #1079 a per-project OFF would delete that
host-global content for every other project on the host too) — can also be
set per project, from the project's own settings panel
(`ProjectBriefingPanel.tsx`'s "Session injection for this project" row).
`null` (the default) inherits `true` for all three (there is no separate
global BOOLEAN setting for workflow conventions to inherit from — the
global tier there is the text itself); an explicit true/false overrides it
for every session under that project. Resolved once, on the primary, at
session-creation time — a toggle flip (global or per-project) takes effect
on the session's _next_ spawn, not retroactively for one already running.
