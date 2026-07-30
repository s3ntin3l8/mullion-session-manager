# Mullion Roadmap — Central Command for AI-Driven Development

**Status:** Active
**Last updated:** 2026-07-30
**Vision:** Mullion orchestrates the entire AI-driven development workflow. Describe a task, Mullion spawns the right agent(s), monitors progress, notifies when input is needed, presents diffs for review, and cycles through approval/resubmit — all from one dashboard, replacing the traditional IDE.

---

## Architecture Decisions (Cross-Cutting)

These decisions apply across multiple phases and are established here to avoid re-litigating them later.

| Decision            | Choice                                                                                                                                                                                                                                                                                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notification model  | In-memory event ring buffer per session, consumed by frontend                                                                                                                                                                                                                                                                                   | PTY output is already streaming; adding a DB write per event creates write amplification at no benefit for the primary use case (real-time display). DB persistence added later if needed for history/replay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Agent communication | Two-channel: PTY-parsed (OSC/BEL, works today) + env-injected structured hooks (new)                                                                                                                                                                                                                                                            | Every agent works via Channel 1. Channel 2 adds rich metadata (progress, file changes, review gates) for agents that support hooks — no agent modification required for basic functionality.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Browser backend     | Playwright Chromium on host, streaming CDP screenshot frames to a `<canvas>`/`<img>` via WebSocket                                                                                                                                                                                                                                              | Full CDP access for DOM snapshotting, clicking, filling, JS evaluation — the existing `BrowserPanel.tsx` (see Phase 3 design notes) is iframe-based and can't do this; this is a genuinely new rendering path, not an extension of it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| API surface         | HTTP REST (existing) + Unix socket supplement                                                                                                                                                                                                                                                                                                   | Socket is an alternative transport for a subset of operations, not a separate API. Low-latency PTY I/O and local CLI integration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Subagent detection  | Hook-derived identity, layered onto the existing `subagentCount`. Full identity (agentId/agentType) from Claude Code's `SubagentStart`/`SubagentStop`; OpenCode's own `session.subagent` event contributes to the count only, with no identity (a real gap for that adapter, not a bug — see Phase 5's Design Notes). No process-tree fallback. | Claude Code subagents run in-process — there is no PID, no child process, and nothing for `/proc` to enumerate; a fallback for a mechanism that doesn't exist isn't a fallback. A separate, genuine session-lineage primitive (`parentSessionId`) covers the case where a child really is its own process — see Phase 5's Design Notes for the two-track split.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Event persistence   | In-memory ring buffer for live feed (Phase 1); optional DB for history (Phase 4)                                                                                                                                                                                                                                                                | Timeline and history clients need queryable event storage. Configurable retention, off by default — no regression for Phase 1's in-memory model. **Gap:** sessions survive redeploys (dtach/systemd) but events don't — a pending 2.7 review gate is lost on restart even though the session it belongs to isn't. Worth pulling minimal persistence forward for gating events specifically; see Phase 2 design notes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Task source         | GitHub issues with configurable label, polled at interval (no webhooks), as the **ingestion source** for autonomous Task Master tasks                                                                                                                                                                                                           | GitHub is the existing integration (issues, PRs, CI — see #102/#221/#222). Polling avoids public-endpoint requirement for webhooks. Scoped narrowly to _where autonomous tasks come from_ — it does not say what backs the interactive task board (see the Task backend row below and the Task Model & Task Board section). This decision covers _task_ polling only — #221's proposed webhooks are scoped to per-PR CI status, a different endpoint, and don't reopen this decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Security & trust    | Hook socket requires a per-session token, not just filesystem perms; inbound hook messages are untrusted input                                                                                                                                                                                                                                  | An env-injected socket path is inherited by every child process a session spawns, so any subcommand could forge a `review_gate` or `file_change` event without a token. Same env-leak class that corrupted the repo 3× via leaked `GIT_*` vars (#205) — `buildSessionEnv()`/`git-env.ts` already scrub session env deliberately; the hook channel must not reopen that hole. Applies transitively to Phase 3 (browser cookie import needs scoping/allowlisting — real credential exfil risk if an agent drives the browser to an attacker URL) and Phase 6 (autonomous GitHub-write agents need per-task token scope, a cost/time budget, and a kill-switch beyond the single global `MULLION_TASK_MASTER_ENABLED` flag).                                                                                                                                                                                                                                                                             |
| Worktree ownership  | Mullion manages worktrees only for Task-Master-spawned sessions and opt-in isolated interactive sessions, created at work-start time from `origin/<default>`; un-isolated interactive sessions stay observe-only                                                                                                                                | Mullion already shipped and removed general worktree management once (PR #152 → #197, resolving #162): creating a worktree eagerly at session-insert time, pinned to HEAD, went stale on idle sessions and session reuse. That failure mode only bites _eager_ creation — coupling creation to the moment work actually starts (task claim, or an explicit "isolate this session" action) avoids it. Every `git` call this produces must route through `git-env.ts`'s `gitEnv()` (#205's fix) to avoid reopening the env-leak corruption class. See Phase 2.5/Phase 6 design notes for the mechanism.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Task backend        | A **Mullion-local task entity is the hub**; GitHub is a synced durable projection (issue-of-record), not the interactive task board's backend                                                                                                                                                                                                   | A task has three tiers of state and only one fits in a GitHub issue: durable/shareable fields (title, spec, status, assignee, PR link — an issue can hold these), runtime/local-only fields (worktree path, live session id, agent phase — an issue has **no field for these at all**), and render/ordering state (column position, drag order — must be local for latency; GitHub Projects v2's ordering API is worth re-checking at implementation time, though it isn't what forces this decision). Discriminating test: can a task exist before/without a GitHub issue? Chat-to-task drafts, backlog grooming, and a "ready" column an agent picks up all say yes — once yes, GitHub-as-sole-backend is settled as insufficient. `horang-labs/tessera` (unrelated project, no lineage, AGPL-3.0 — pattern cited, not code) does exactly this split: its own local task store, GitHub/git only as the code layer. See the Task Model & Task Board section below for the full reconciliation model. |

---

## Task Model & Task Board

The roadmap's original framing was **session management**: the sidebar, windows, and 1.8's
Kanban all render _sessions_ (a PTY, possibly attached to work that becomes a PR — or doesn't).
The vision this section addresses is the natural next step — **task management**: tracking a
unit of work through planning → implementation → review → done, with a Kanban board where
task cards move backlog → ready (→ picked up by an agent), each card carrying its
worktree/branch and eventually its PR. This section answers "is GitHub the right backend for
that board" and specifies the model. It doesn't add a new numbered phase — it's an
architecture articulation that 1.8, 2.5.x, and 6.5 all draw on.

**Session board vs. task board — these are different surfaces.** 1.8 (Phase 1) is a _session_
board: columns are Running / Needs Attention / Exited, cards are sessions, state comes from
the local event model — already local, no GitHub involved. What's being scoped here is a new
_task_ board: columns are backlog → ready → in progress → review → done, cards are tasks (a
task may have zero, one, or several sessions across its lifetime), and a drag into "ready" is
the interactive trigger for agent pickup. The Task backend architecture-decision row above
answers what backs this new surface.

**Three tiers of task state — only one fits in a GitHub issue:**

| Tier                 | Examples                                                                            | In a GitHub issue?                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable / shareable  | title, spec, workflow status, assignee, linked PR                                   | Yes                                                                                                                                            |
| Runtime / local-only | worktree path, live session id, agent phase (planning/impl/review), live diff stats | **No home at all** — no issue field represents any of this                                                                                     |
| Render / ordering    | column position, drag order, backlog-vs-ready staging                               | Must be local for latency; Projects v2's ordering API is worth a fresh check at implementation time, though it isn't what forces this decision |

The runtime tier is decisive: a meaningful fraction of what makes a task a _task_ in this
product — the worktree it owns, the session running in it, the agent's current phase — simply
cannot be represented as issue fields. **Discriminating test:** can a task exist before or
without a GitHub issue? Chat-to-task drafts (research first, "start work" second), backlog
grooming, and a "ready" column an agent picks up all answer yes. Once the answer is yes,
GitHub-as-sole-backend is settled as insufficient, and the split below is forced.

**Reconciliation model — local is the hub, GitHub is a synced edge:**

- The **Mullion-local task entity** (SQLite/Drizzle, alongside the existing session model) is
  the source of truth for the board: it owns workflow status, column order, and all runtime
  state, and it's what the board actually renders — instant drag, no round-trip, works even if
  GitHub is unreachable.
- **GitHub holds the durable issue subset.** Two things feed the local hub: Task-Master-ingested
  issues (the existing "Task source" decision above — GitHub-labeled issues, polled) and
  manually-created or chat-promoted tasks (created locally first, no issue required).
- **Write path:** optimistic local write → async push of durable fields to GitHub (title, spec,
  status, assignee). **Read-back:** issue close / PR merge / label change syncs the durable
  fields back into the local row.
- **Conflict rule:** local owns order and runtime state unconditionally (GitHub has no
  representation to conflict with). For the durable subset, the GitHub issue is authoritative
  for what it closes (e.g. issue-closed → task done); the local row is authoritative for
  everything in between.
- This resolves the three-way tension the earlier draft left implicit —
  **Task-Master-ingested issues / Mullion-local tasks / GitHub** — into a hierarchy: local is
  the hub, the other two are edges that sync into and out of it.

**Where the task-board UI lands:** it's an evolution of 1.8 (the session board pattern) and
Phase 6's 6.5 Tasks panel — 6.5 is currently scoped as "a list grouped by status"; this reframes
it as the Kanban render of local task entities, with drag-to-"ready" as the agent-pickup
trigger (see the 6.5 design note below). Both remain Phase 1 / Phase 6 features respectively —
this section only supplies the backend model they share.

Comparison-informed throughout (`horang-labs/tessera`, unrelated project, no lineage,
AGPL-3.0 — pattern cited, not code): its own local task store plus `workflowStatus` field,
with git/GitHub used only as the code layer, is exactly this split already shipped elsewhere.

---

## Phase 1: Richer Notifications

**Goal:** Replace the current `attention: boolean` + `activity: "working" | "idle"` with a full notification event system — structured, multi-channel, and extensible.

### Features

| #   | Feature                                                                                                                                                                     | Effort | Depends On |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 1.1 | Notification event model (backend) — `PtyManager` emits structured events (`kind`, `timestamp`, `payload`) consumed by subscribers                                          | M      | —          |
| 1.2 | Per-session status line in sidebar — last event text visible inline                                                                                                         | S      | 1.1        |
| 1.3 | Session tab notification badges — count + type icon on workspace tabs                                                                                                       | S      | 1.1        |
| 1.4 | Notification panel — slide-out sidebar/overlay listing recent events grouped by workspace                                                                                   | L      | 1.1        |
| 1.5 | Desktop notifications via Browser Notification API — fire when tab is unfocused                                                                                             | S      | 1.1        |
| 1.6 | Attention-clear heuristics — refine the current `ATTENTION_CLEAR_WINDOW_MS` logic to avoid false positives from rapid BEL/OSC sequences during heavy output                 | S      | 1.1        |
| 1.7 | Sidebar session row redesign — surface worktree/branch/PR info and live diff stats (files changed, +/-) per session inline, alongside the notification status line from 1.2 | L      | 1.1, 1.2   |
| 1.8 | Kanban board view — sessions grouped into columns (Running, Needs Attention, Exited) with drag-to-reorder and column counts                                                 | M      | 1.1        |

### Design Notes

- Events are in-memory only (ring buffer per session, ~100 events). No DB persistence in Phase 1.
- 1.1 is smaller than it looks: session status today (`pty-manager.ts`'s `SessionInfo`) already carries `attention`, `activity`, `attentionAt`, `lastActivityAt`, and `lastTitle` as poll-derived fields — 1.1 formalizes these into a pushed event stream, it isn't starting from a bare boolean.
- The `kind` enum starts with `attention`, `status_change`, `title_change` and is extended in later phases.
- The frontend notification panel is a new component, not embedded in the existing sidebar. Accessible via a bell icon in the toolbar (existing) but opens a dedicated panel.
- The sidebar redesign (1.7) is the Phase 1 frontend flagship — the notification status line (1.2) and git/worktree/PR info make the session row the primary information surface. Backend work includes per-worktree git status polling, per-branch PR filtering, branch/worktree enumeration endpoints (`git-refs`), and live diff stats (files changed, +/- line counts) computed per session and pushed as they change — not just static branch/PR labels. Diff stats are a comparison-informed addition (an unrelated project with a similar worktree-per-task model, `horang-labs/tessera`, surfaces exactly this in its list/Kanban views; no lineage between the projects, just a useful pattern). 1.7 is deliberately **read-only observation** — it displays worktrees regardless of who created them (agent, user, or Mullion), it doesn't create any. This is the stable baseline for interactive sessions Mullion doesn't isolate (see the Worktree ownership row above); it's unaffected by the isolated-worktree mechanism added in Phase 2.5/6.
- Kanban (1.8) is a pure frontend view with no new backend work. Session state transitions from the event model drive card movement between columns. Exists alongside the list view; user toggles between them. This is a **session** board (Running/Needs Attention/Exited, local-only). It's a distinct surface from the **task** board specified in the Task Model & Task Board section above (backlog→ready→done, backed by the local task entity) — 1.8 doesn't become that board; 6.5 does.

---

## Phase 2: Agent Hook System

**Goal:** Create a structured communication channel from agents to Mullion via environment-injected hooks — delivering rich metadata that PTY parsing alone cannot extract.

### Features

| #   | Feature                                                                                                                                             | Effort | Depends On    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| 2.1 | `MULLION_HOOK_SOCKET` env injection at session spawn time                                                                                           | M      | —             |
| 2.2 | Hook JSON protocol definition + server-side validation                                                                                              | S      | 2.1           |
| 2.3 | Claude Code hook integration — wire `MULLION_HOOK_SOCKET` into Claude Code's existing hook system                                                   | S      | 2.2           |
| 2.4 | OpenCode hook integration — same for OpenCode's hook system                                                                                         | S      | 2.2           |
| 2.5 | Hook messages routed into the notification event model (Phase 1.1)                                                                                  | S      | 1.1, 2.2      |
| 2.6 | File change events — agent reports modified files via hook, Mullion surfaces them in the sidebar                                                    | M      | 2.5           |
| 2.7 | Minimal review gate — agent emits a `review_gate` event, Mullion shows a pending-review indicator, user can approve/deny via the notification panel | M      | 2.5, 1.4      |
| 2.8 | Session timeline — chronological per-session detail panel showing agent output, file changes, branch switches, review gates, and attention state    | L      | 2.6, 2.7, 1.1 |

### Design Notes

- No filesystem modifications (no dotfile writes, no agent config changes). Everything is environment injection at spawn time.
- Agents that don't support hooks continue to work perfectly via PTY-parsed channel (Phase 1 covers those).
- Hook messages are JSON over a Unix socket (`MULLION_HOOK_SOCKET`) — the agent writes one JSON object per line. Mullion's socket listener is lightweight (single-threaded read loop, non-blocking).
- The review gate is the first step toward the long-term Task → Agent → Review loop vision.
- The session timeline (2.8) is the per-session detail view, complementing the notification panel (1.4) which is the condensed cross-session feed. Clicking a session opens its timeline.
- Worktree hook investigation — **resolved.** The hook protocol (2.2) defines an optional `worktree` message (`{"kind":"worktree","action":"create|switch","branch":"..."}`), but purely as a **telemetry** signal — the agent tells Mullion which worktree it's now in, for the sidebar (1.7) to display. It is explicitly **not** the creation mechanism: creation is Mullion-side (Phase 2.5/6, or the interactive toggle below), driven by orchestration (launch flag / pre-created `cwd`), not by a hook round-trip. See the Worktree ownership architecture-decision row.
- Interactive worktree isolation (forcing without per-prompt instruction) — investigated as a follow-on to the above, since the same "how do agents end up in a worktree" question applies to sessions a human opens directly, not just Task Master. Ranked most → least deterministic:
  1. **Launch-in-worktree at spawn (recommended default).** Mullion controls and replays the session's launch command (an opaque blob per `sessions.command`), so it can inject Claude Code's native `--worktree <name>` flag at spawn time — Claude Code then creates `.claude/worktrees/<name>` on branch `worktree-<name>` and runs there natively, with zero prompting and no Mullion-side git code. The CLI has no setting to default every session into a worktree; injecting the flag is exactly that missing default. For agents without an equivalent flag (Codex, opencode), Mullion pre-creates the worktree itself (the same primitive Phase 2.5/6 use) and sets the session's `cwd` — agent-agnostic. Surfaced as an opt-in "isolate this session" toggle at session creation.
  2. **Promote an existing session (mid-conversation "start work" action).** Equally deterministic, triggered later: a session starts unisolated (plain research/exploration, no worktree), and an explicit action creates a worktree and opens a **new** session in it, with the prior conversation's context forwarded as the seed prompt — not a live cwd relocation of the running session (already ruled out: Claude Code hooks can't relocate a running session's cwd). This is comparison-informed (`horang-labs/tessera`'s "chat-to-task" flow, unrelated project, no lineage): traced its actual code and its own "start work" entry point (`useWorktreeSession`) works exactly this way — create worktree → create task record → **new** session with that `cwd`, not a live handoff of the running one; a separate, narrower session-fork feature exists there but is Codex-only and preserves the _source's_ existing worktree rather than creating one, so it isn't this mechanism either. Unifies with option 1: both end in "a session running with `cwd` set to a freshly created worktree," just triggered at different moments (launch vs. mid-conversation).
  3. **`PreToolUse` gating hook (Claude Code-only, harder fallback).** A hook on `Edit|Write|Bash` reads the hook payload's `cwd`, returns `permissionDecision:"deny"` + a reason when it's the main checkout, and the agent — seeing the reason — can self-relocate via its own worktree tooling. Hard-blocks mutations outside a worktree, but the hook cannot relocate the session itself (relies on the agent to comply), and Mullion must write it into `.claude/settings.json`/`~/.claude/settings.json` — the same settings-injection dependency flagged in the 2.3/2.4 spike note below, and in tension with the "no agent config changes" note.
  4. **Soft nudges** (`SessionStart` `additionalContext`, CLAUDE.md instructions, an auto-invocable skill) — advisory only, the agent may ignore them, which is exactly the failure mode options 1–2 avoid. Useful as a complement, not a substitute.
- 2.3/2.4 are spikes, not confirmed-S work: Claude Code hooks are registered via `settings.json` (`PreToolUse`/`Stop`/`Notification`/…), not via environment variables — env-injecting `MULLION_HOOK_SOCKET` alone won't make Claude Code call it. 2.3 likely needs Mullion to write (and clean up) a hook config, which contradicts the "no agent config changes" note above; that contradiction needs resolving before scoping. 2.4 needs the same verification against OpenCode's actual hook surface before its effort estimate is trustworthy. Codex is a plausible third target alongside Claude Code and OpenCode — worth a scoping pass of its own before committing effort estimates (not yet scoped here).
- Native structured protocols as an alternative channel — worth a spike, not a rewrite of the Agent communication decision above. Comparison-informed (`horang-labs/tessera`, unrelated project, no lineage): it normalizes each CLI's own machine-readable protocol (Claude Code `stream-json`, Codex `app-server` JSON-RPC, OpenCode ACP JSON-RPC) behind a provider-adapter layer, as an opt-in per-session mode fixed at creation — sidestepping the settings.json-injection problem above entirely, since a structured-output invocation needs no hook config. The real trade-off: that mode isn't the interactive PTY the user watches — it's a different, non-terminal session type. For a terminal-first product this is a bigger identity question than adding hooks alongside the existing terminal, not a drop-in replacement for Channel 2. Worth its own investigation before any commitment.
- Review-gate persistence: a `review_gate` event (2.7) is a pending user decision, not just a log line — unlike the rest of the Phase 1 event model, losing it on a server restart is a regression (the session it gates survives redeploys; the gate itself currently wouldn't). Consider a minimal persisted table for open gates only, ahead of Phase 4's general event history (4.7).

---

## Phase 2.5: Task Master — Thin Slice

**Goal:** Prove the core task→agent→review→PR loop end-to-end, behind the same flag as the full Task Master, before investing in Browser/Socket/Subagents. Pulled forward from Phase 6 specifically to de-risk the rest of the roadmap: if the loop doesn't feel right, better to learn that now than after three more phases.

**Gate:** `MULLION_TASK_MASTER_ENABLED=false` (default off) — the same flag Phase 6 uses. Turning it on gets you this slice; Phase 6 hardens it further behind the same switch, no new flag needed.

### Features

| #     | Feature                                                                                                                                                                                                                                     | Effort | Depends On |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 2.5.1 | Task watcher (minimal) — background poller for issues with the task label (default `mullion-task`); every task requires manual claim, no auto-claim branch yet                                                                              | S      | —          |
| 2.5.2 | Agent spawner (minimal) — creates a session with the issue title + body as the initial prompt, tagged with the source issue for cross-reference; spawns into an isolated worktree branched from `origin/<default>`, never the live checkout | S/M    | 2.5.1      |
| 2.5.3 | Manual claim (minimal) — a claim action wired into existing UI (sidebar/dock), not a new dockview panel; invokes 2.5.2's spawner directly                                                                                                   | S      | 2.5.2      |
| 2.5.4 | Review & manual PR — no new code: review the agent's work in the existing session/git/GitHub panels, open the PR by hand                                                                                                                    | XS     | 2.5.3      |

### Design Notes

- Deliberately excludes the machinery Phase 6 adds later: no task state machine or `/api/tasks` REST surface (6.2), no GitHub label/comment sync automation (6.4), no dedicated Tasks panel (6.5), no automated Task → PR promotion (6.7). Those remain in Phase 6 as the hardening pass once the slice has validated the concept.
- Does **not** depend on Phase 2's review gate (2.7) or hook socket (2.1) — task-prompt injection here is a plain environment variable at spawn time, same mechanism the roadmap already uses elsewhere before hooks exist. This is what makes pulling it forward possible: it only needs Phase 1/2 to be _stable_, not for 2.7 specifically to have shipped.
- Issues #214, #216, #219 (previously Phase 6's 6.1/6.3/6.6) are retargeted into this slice as 2.5.1/2.5.2/2.5.3, moved to this milestone, and trimmed of their Phase-6-only dependencies (state machine, hook socket, Tasks panel). The 6.1/6.3/6.6 numbers are retired in Phase 6; the corresponding hardening work is folded into 6.2 (state machine formalizes 2.5.1's polling) and 6.5 (Tasks panel replaces 2.5.3's ad hoc claim UI).
- Worktree isolation in 2.5.2 is deliberately minimal — create-and-set-`cwd` only, no reconciler, no `pruneOrphans`, no remote-host proxy; those are Phase 6's 6.8. Even the thin slice's single spawned agent must not mutate the user's live checkout. Three things this must get right, learned from the earlier worktree-mode attempt (PR #152 → removed by #197, resolving #162):
  1. **Branch from `origin/<default>` for the autonomous case; offer a real picker for the interactive case, not one hardcoded rule.** `project.cwd` can be on any branch the user happens to have checked out; branching off it unconditionally (as #152 did) silently gives the agent the wrong base — for Task Master (no human present to decide) `origin/<default>` stays the right default. But comparison-informed refinement (`horang-labs/tessera`, unrelated project, no lineage): its worktree creation offers a validated base-ref picker (local + remote branches, defaulting to current) rather than forcing one answer — worth mirroring for the interactive promote/isolate paths (Phase 2's options 1–2 above), where a human is present and may want to branch off their current work instead of `origin/<default>`.
  2. **Removal waits for 2.5.4's manual PR**, not session death — #152 removed on session-death + clean-worktree, which is too early here: the worktree must survive through human review.
  3. **This is not full staleness protection** — task-claim-time creation avoids the _idle-before-work_ staleness #162 identified. It doesn't stop a long-running task's branch from diverging from `main` while the agent works; that's ordinary branch divergence, resolved by merge/rebase like any other branch, not a bug to fix here.

---

## Phase 3: Controllable Browser

**Goal:** An in-app browser pane that agents can script — navigate, snapshot the DOM, click elements, fill forms, evaluate JavaScript — alongside terminal panes in the dockview layout. **Primary motivation:** let agents verify their own work (load a page, click through a flow, confirm a UI change) against a browser Mullion controls, instead of depending on the user's local machine and its browser to do that verification.

### Features

| #   | Feature                                                                                                                                        | Effort | Depends On |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 3.1 | Playwright browser manager (backend) — pool of Chromium processes, lifecycle management                                                        | L      | —          |
| 3.2 | WebSocket frame streaming — browser frames streamed from Playwright to frontend via WebSocket                                                  | M      | 3.1        |
| 3.3 | `BrowserPane` dockview component — CDP-frame-rendering panel with URL bar, back/forward, reload controls                                       | M      | 3.2        |
| 3.4 | Session-to-browser binding — associate a browser pane with a session, agents target their session's browser                                    | S      | 3.3, 3.1   |
| 3.5 | Agent browser automation API — `POST /api/sessions/:id/browser` with actions: `navigate`, `snapshot`, `click`, `fill`, `eval`, `screenshot`    | L      | 3.3, 3.1   |
| 3.6 | Cookie/session import — import cookies from the user's real browser (Chrome/Firefox profiles) so agent-controlled browser starts authenticated | M      | 3.5        |

### Design Notes

- Not greenfield: `frontend/src/BrowserPanel.tsx` already ships as an iframe-based preview pane, backed by a server-side proxy (`preview-host.ts`, `preview-registry.ts`, `http-proxy.ts`) for both the project's dev server and external URLs. Phase 3 is "add a CDP-controllable pane," not "add a browser pane" — decide whether `BrowserPanel` is replaced, or kept as the lightweight (non-agent-controlled) preview mode alongside the new `BrowserPane`.
- Issue #110 ("Browser panel not persisted in layout") is filed against the existing `BrowserPanel` and is a stated prerequisite for 3.3 — see the Phase 3 row in Pre-Existing Issues below.
- Playwright launches a Chromium instance per project (or per workspace, configurable). The instance persists across pane open/close — closing the pane doesn't kill the browser.
- Frame streaming: Playwright's CDP screenshots are pushed via WebSocket to the frontend at ~5fps (configurable) and rendered to a `<canvas>`/`<img>` — **not an iframe**; CDP screenshot frames are images, not DOM, so there's nothing for an iframe to host. User interactions (clicks on the canvas) are proxied back through the WebSocket to Playwright.
- The agent automation API is the bridge between the agent's chat context and the browser. When an agent says "I'll open the preview", it sends a `navigate` action via Mullion's API, and the browser pane updates.
- Combined with Phase 2 hooks: an agent could emit `{"kind":"browser_request","action":"navigate","url":"http://localhost:5173"}` via the hook socket, and Mullion opens the URL in the project's browser pane.

---

## Phase 3 Follow-ups — Browser Completion

**Goal:** Round out the browser feature split: Playwright for agent automation (3.7), iframe
for human preview (3.8), plus targeted follow-ups for the highest-impact remaining gaps.

### Features

| #    | Feature                                                                                                                                                                                                 | Effort | Depends On | Issue                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------------------------------------------------------------- |
| 3.7  | Agent automation API, MCP tools & console access — browser MCP tool + missing REST actions (press, type, select, check, wait, dialog, hover, scroll, get, console, errors) + MullionClient HTTP methods | L      | 3.5        | [#379](https://github.com/s3ntin3l8/mullion-session-manager/issues/379) |
| 3.8  | Iframe browser reliability & UX clarity — layout persistence (fixes #110), dev server status indicator, "Preview" vs "Agent Browser" labeling, cookie upload for remote setups, follow-agent URL sync   | M      | —          | [#380](https://github.com/s3ntin3l8/mullion-session-manager/issues/380) |
| 3.9  | Console & error access — folded into 3.7                                                                                                                                                                | —      | —          | —                                                                       |
| 3.10 | Browser download management — `download` action capturing files triggered by agent interaction                                                                                                          | S      | 3.7        | [#381](https://github.com/s3ntin3l8/mullion-session-manager/issues/381) |
| 3.11 | Frame/iframe support — `frame` action entering/exiting iframe contexts                                                                                                                                  | M      | 3.7        | [#382](https://github.com/s3ntin3l8/mullion-session-manager/issues/382) |
| 3.12 | Preview-host auth — short-lived token appended to iframe URL, validated by preview-proxy.ts (closes the gap noted in auth.ts:51-53)                                                                     | M      | 3.8        | [#383](https://github.com/s3ntin3l8/mullion-session-manager/issues/383) |

### Design Notes

- 3.7 is the core of this follow-up phase — the MCP browser tool gives Claude Code native
  browser control through the existing `mullion` MCP server (`src/mcp/server.mjs`), without
  needing REST knowledge, session IDs, or a CLI. The missing REST actions (press, type,
  select, wait, dialog, console especially) close the gap between "can look at a page" and
  "can do real work on a page" — submitting forms, handling JS dialogs, waiting for SPAs.
  Console/errors are folded into 3.7 (not a separate issue) because without them the agent
  is blind to JS failures that cause interaction failures.

- 3.7 and 3.8 make the browser split explicit: Playwright is the agent's tool (MCP + REST,
  headless Chromium, screenshot-based debug pane), the iframe is the human's tool (real
  DOM, HMR, native interaction). The iframe is NOT being made controllable — that role
  belongs to Playwright. The Playwright pane is NOT the primary viewing surface — the
  iframe is. 3.8's "Follow agent" toggle bridges them: when enabled, agent navigation in
  Playwright updates the iframe URL so the human sees what the agent is working on.

- 3.10–3.12 are deferred to sub-issues. Download management and frame support are the
  highest-priority remaining gaps after 3.7. Preview-host auth closes the known gap in
  `auth.ts:51-53` — without it, preview iframes bypass Mullion's auth gate entirely.

- 3.7's `MullionClient` HTTP methods and MCP browser tool follow the exact same pattern
  Phase 4's [#134](https://github.com/s3ntin3l8/mullion-session-manager/issues/134)
  establishes for session/dock/preview management. When #134 ships the full `mullion` CLI,
  browser actions become available as `mullion browser navigate`, etc. — zero new backend
  work, just a CLI wrapper around the REST endpoints 3.7 completes. The Socket API's 4.5
  (browser actions over socket) builds on 3.7 directly.

- Additional agent-browser parity items (multi-tab, cookie runtime API, storage API,
  network interception, highlight, annotated screenshots, state save/load, dblclick, focus,
  drag, upload, scroll-into-view) remain as future enhancements — not blocking the core
  agent loop, not tracked as separate issues yet.

---

## Phase 4: Socket API

**Goal:** A local Unix socket for low-latency, programmatic control of Mullion — supplementing the existing HTTP REST API.

### Features

| #   | Feature                                                                                                 | Effort | Depends On |
| --- | ------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 4.1 | Unix socket transport — single socket at `$MULLION_SOCKET_PATH`, JSON message framing                   | M      | —          |
| 4.2 | PTY I/O over socket — subscribe to session output, write keystrokes                                     | M      | 4.1        |
| 4.3 | Session lifecycle over socket — create, kill, list, inspect sessions                                    | S      | 4.1        |
| 4.4 | Session status / notification events over socket — subscribe to real-time events from Phase 1           | S      | 4.1, 1.1   |
| 4.5 | Browser actions over socket — trigger navigate/snapshot/click on browser panes                          | S      | 4.1, 3.5   |
| 4.6 | CLI client — `mullion exec <command>` opens session, streams output to stdout, forwards stdin           | M      | 4.2, 4.3   |
| 4.7 | Unified session history — persistent event storage with search/filter; CLI queryable via `mullion logs` | L      | 4.1        |

**Status:** 4.1–4.6 shipped (#396, #398, #399, #400, #401, #402, #403 — see
[`docs/socket-api.md`](socket-api.md) and [`docs/cli.md`](cli.md)). The MCP
session/project/preview tools (#134's CLI/MCP half) followed in #406. 4.7 is
the one remaining Phase 4 item (tracked by #213), not yet started.

### Design Notes

- Every socket operation has an HTTP equivalent. The socket is not a separate API — it's an alternative transport.
- Auth via filesystem permissions (`0600`) + optional embedded token from the parent process's environment.
- Framing is newline-delimited JSON (NDJSON), one message per line — **not** a length-prefixed header as originally described here. As shipped (#185), `/ws/terminal` (the terminal WebSocket route this sentence originally claimed shared framing with) has no length prefix at all: WS itself supplies message framing, using raw binary frames for PTY bytes plus JSON text frames for control. There was nothing to actually share; see `docs/socket-api.md`'s wire-protocol section for the real (NDJSON) framing this socket uses instead.
- The CLI client is the primary consumer (`mullion exec`, `mullion ps`, `mullion logs`).
- Event storage for history (4.7) is opt-in with configurable retention (default: off, matching Phase 1's in-memory model). When enabled, events are written to the existing SQLite DB in a new `session_events` table. The live event ring buffer (Phase 1) continues to operate independently regardless of persistence settings.

---

## Phase 5: Subagent / Fork Awareness

**Goal:** Give subagents (Claude Code's `Task`-tool teammates) real identity in
the UI, and let an agent spawn a genuine child session with its own terminal.
These are two different mechanisms, not one — see the Design Notes below for
why this phase splits into two tracks.

**Status (rewritten — this section originally assumed subagents are OS
subprocesses with PIDs; they are not, see Design Notes):** the aggregate half
of subagent awareness — a running `subagentCount` derived from Claude
Code's/OpenCode's own `SubagentStart`/`SubagentStop` hooks — already shipped
(#320, #321) as part of Phase 2's hook work, ahead of this phase. What's left
is per-subagent identity (Track A) and a real session-lineage primitive
(Track B).

### Features

| #    | Feature                                                                                                                                                                                                                                                                           | Track | Effort | Depends On                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ---------------------------------------- |
| 5.1  | Agent-attribution envelope — hook messages optionally carry `agentId`/`agentType` (from Claude Code's `agent_id`/`agent_type`, present on every hook fired inside a subagent), letting file changes/tool failures attribute to the subagent that caused them, not just the parent | A     | S      | 2.2                                      |
| 5.3a | Subagent registry — an `agentId`-keyed, in-memory map per `Session` (name, start/end time, summary, file changes) built from 5.1's envelope; purely additive to the existing `subagentCount`, never a replacement for it                                                          | A     | M      | 5.1                                      |
| 5.5a | Subagent rows in the sidebar/timeline — a collapsible per-subagent list under the parent session row, and timeline grouping by subagent                                                                                                                                           | A     | M      | 5.3a, 1.4                                |
| 5.3b | `parentSessionId` session lineage — a nullable self-referential FK on `sessions`, and a narrow, session-scoped socket op letting a running agent spawn a real child session (own PTY, own dtach socket) in the same project                                                       | B     | M      | 4.1                                      |
| 5.4  | Child-panel layout — dockview opens a new child session's panel positioned next to its parent (reference-panel placement, not a new `addGroup` layout engine)                                                                                                                     | B     | M      | 5.3b                                     |
| 5.5b | Hierarchical sidebar view — toggle between flat (today's view) and hierarchical (children nested under parent), with an explicit orphan rule for a parent that's been filtered out (killed, hidden, wrong project)                                                                | B     | M      | 5.3b, 1.4                                |
| 5.6  | Individual child-session control — kill/rename/detach a child session independently; cascade choice (`detach` default, or `kill`) when the parent is closed. Subagents (Track A) get monitor/review only — there is no cancellation surface to kill or restart one                | A+B   | S      | 5.3a (Track A half), 5.3b (Track B half) |

_(5.2, "process-tree polling fallback," is retired outright — see Design
Notes. 5.3's original "subagent session model" is split into 5.3a/5.3b above
since it conflated two different mechanisms. 5.1's number is reused, not
retired like 5.2's: the original `{"kind":"fork",...}` design this number
named is gone, but "5.1" itself now names the real, different mechanism —
the agent-attribution envelope — rather than being retired alongside 5.2.)_

### Design Notes

- **Subagents are not OS subprocesses.** Claude Code's `Task` tool runs
  subagents in-process; its `SubagentStart`/`SubagentStop` hooks carry
  `session_id`/`agent_id`/`agent_type`/`last_assistant_message` — no PID, no
  child process, nothing for `/proc` to enumerate or a `childPid` to name. The
  original 5.1 (`{"kind":"fork","childPid":...}`) and 5.2 (`/proc` polling)
  both assumed a mechanism that doesn't exist for the one agent that actually
  ships a subagent feature today; both are retired. The `fork`/`join` hook
  kinds that were added speculatively ahead of this phase were deleted rather
  than kept as unreachable reserved kinds — the protocol already accepts and
  stores any unrecognized `kind` verbatim, so nothing is lost by removing
  dead, never-emitted types; re-add on demand if a future agent genuinely
  forks OS processes.
- **Track A (subagent observability)** is therefore hook-derived and
  observe-only: no PTY, no DB row, no kill handle, just identity and activity
  layered onto the `subagentCount` Phase 2 already ships. `subagentCount`
  itself stays the authoritative, independently-maintained counter — the
  identity registry is additive, since not every adapter can supply an
  `agentId` (OpenCode's `session.subagent` event carries none) and a
  pre-upgrade `.state.json` restores a bare count with no registry at all.
- **Track B (session lineage)** is what 5.3's "child gets a `Session` object
  with PTY + dtach" genuinely required all along, just for the case that
  actually has one: an agent (or a user) explicitly starting a **new session**
  that happens to be linked to its parent — not a `Task`-tool subagent. This
  needs a real DB column and a real spawn path, and is scoped independently
  of Track A.
- A **cgroup-based process inventory** (every session's dtach master runs in
  its own transient systemd scope, `crs-session-<id>.scope`, whose
  `cgroup.procs` lists the real process set under it) was investigated as a
  genuine `/proc`-adjacent mechanism and would surface real subprocesses
  (MCP servers, backgrounded shell jobs, nested CLIs) — but that is not
  subagent detection, it's a different, orthogonal feature. Tracked
  separately in the Icebox, not built as part of this phase.
- Layout for a spawned child session: dockview reference-panel placement next
  to the parent (the mechanism already used for split-launch), not a new
  `addGroup`-based automatic-arrangement engine — `addGroup` isn't used
  anywhere in the frontend today and reference-panel placement gets the same
  "parent keeps its position, child fills available space" result without new
  API surface.
- Closing a subagent (Track A) has no effect to have — there's no pane, no
  process. Closing a child session (Track B)'s pane only detaches the panel;
  killing it offers the same cascade choice as any session with children:
  `detach` (default) leaves children running as independent top-level
  sessions, `kill` cascades.
- 5.6 bundles both tracks' control surfaces into one issue/row for tracking
  convenience, but the two halves are independently shippable: the Track A
  half (subagent monitor/review) needs only 5.3a and could ship before 5.3b
  exists at all; the Track B half (child-session kill/rename/detach/cascade)
  needs only 5.3b. Neither half is gated on the other.

---

## Phase 6: Task Master — Full

**Goal:** Harden the Phase 2.5 thin slice into the full autonomous loop: a real task state machine, GitHub issue state sync, a dedicated Tasks panel, and automated Task → PR promotion. Phase 2.5 proves the concept works; Phase 6 makes it production-grade and auto-claimable.

**Gate:** `MULLION_TASK_MASTER_ENABLED=false` (default off). When disabled, the task watcher is inert and no dashboard UI changes appear.

### Features

| #   | Feature                                                                                                                                                                                                                                           | Effort | Depends On                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------- |
| 6.2 | Task state machine + REST API — `GET /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks/:id/claim`; states: Pending → Claimed → In Progress → Reviewing → Done / Failed                                                                          | M      | 2.5.1 (thin-slice watcher, being replaced), 6.9 |
| 6.4 | GitHub issue state sync — auto-update labels (`mullion-claimed`, `mullion-done`), add progress comments, assign task to the agent's identity                                                                                                      | S      | 2.5.1                                           |
| 6.5 | Tasks panel (frontend) — dockview panel rendering tasks across all projects as the task board (Kanban by status, drag-to-"ready" for agent pickup — see Task Model & Task Board); each card shows title, status badge, linked session, agent name | L      | 6.2, 6.9                                        |
| 6.7 | Task → PR promotion — on user approval, create a PR from the agent's branch, add `mullion-done` label, close the issue; on rejection, return to In Progress                                                                                       | M      | 6.2, 2.7 (review gate)                          |
| 6.8 | Worktree lifecycle — hardens 2.5.2's minimal create-and-set-`cwd` into full management: cleanup reconciler tied to task/PR lifecycle (not session death), boot-time `pruneOrphans`, remote-host proxy support                                     | M      | 2.5.2 (thin-slice worktree step), 6.7           |
| 6.9 | Local task entity — extends the `tasks` table (6.2) to allow an optional GitHub issue link (chat-created/backlog tasks have none); defines the sync/conflict rules between the local row and a linked issue                                       | M      | —                                               |

_(6.1, 6.3, 6.6 retired — hardened into 2.5.1/2.5.2/2.5.3 and pulled forward into Phase 2.5.)_

### Design Notes

- Builds on Phase 2.5 (Thin Slice) rather than starting from scratch: the watcher, spawner, and claim mechanism already exist in minimal form (2.5.1/2.5.2/2.5.3). Phase 6 no longer has its own 6.1/6.3/6.6 — that hardening work is folded into 6.2 (state machine, formalizing the watcher) and 6.5 (Tasks panel, replacing the ad hoc claim UI).
- Tasks follow the split model in Task Model & Task Board (above the Phase 1 section): the **Mullion-local task row is authoritative** for workflow status, order, and runtime state, and is what 6.5's Tasks panel renders; the **GitHub issue is authoritative for the durable subset it closes** (title/spec/assignee/PR link), synced in both directions. This replaces the earlier "GitHub issue is the sole source of truth" framing — that framing only ever fit Task-Master-ingested tasks, not manually-created or chat-promoted ones. 6.9 is the tracked issue for this data-model work — foundational for 6.2 (which already assumed a `tasks` table) and 6.5 (which renders it).
- Task context injection: issue title becomes the instruction, body becomes the spec/context. Passed as initial prompt via `MULLION_HOOK_SOCKET` (Phase 2) or environment variable at session spawn.
- The `Manual: true` field in the issue body bypasses auto-claim — the task sits in Pending until a user clicks "Claim" in the dashboard.
- Phase 6 ties together the entire roadmap: notifications (Phase 1) for task state changes, hooks (Phase 2) for agent progress, the review gate (2.7) for approval, the timeline (2.8) for task detail, the socket API (Phase 4) for CLI task commands, and subagents (Phase 5) for complex multi-file tasks.
- Worktree lifecycle (6.8) resurrects the design of the removed `src/services/git-worktree.ts` (PR #152, recoverable from commit `7588085`: branch-per-session `-b`, remove-only-if-clean, never `--force`, `.git/info/exclude`, boot-time `pruneOrphans`, remote-host proxy) — but creation moves from PR #152's session-insert time to task-claim time (2.5.2), and removal moves from session-death to after 6.7's Task → PR promotion. That's the fix for #162, the reason it was removed in the first place: eager, unreconciled creation went stale on idle sessions and session reuse; task-claim-time creation doesn't have that idle window. Every `git` call routes through `git-env.ts`'s `gitEnv()` to stay outside the #205 env-leak corruption class. The agent otherwise controls its own working directory once launched into the worktree; Mullion doesn't manage anything past create/cleanup. Telemetry-only `worktree` hook messages (Phase 2 design note) keep the sidebar's observation accurate for interactive, non-isolated sessions.
- Cleanup safety, an alternative worth weighing: the "remove-only-if-clean, never `--force`" rule above is a single go/no-go check at merge time. Comparison-informed (`horang-labs/tessera`, unrelated project, no lineage): its cleanup does the opposite — `git worktree remove --force` unconditionally — but gates deletion on a two-phase model instead (explicit archive action → lock against any session still referencing it → an opt-in, confirmable, day-based retention timer before actual deletion). That trades a single clean/dirty check for a grace/undo window, which may be more forgiving in practice (e.g. "one more commit needed" after merge). Worth reconsidering for 6.8's exact design rather than committing to either rule now.
- Polling only, matching the existing GitHub integration pattern. Webhook support is a future enhancement.
- Non-GitHub backends are out of scope for Phase 6.

---

## Phase 7: Secure Multi-Host Lifecycle

**Goal:** Harden the multi-host mechanism already shipped (#26/#27) — agent-initiated
registration and rotating session credentials in place of long-lived manually-copied static
tokens, HMAC-signed requests, heartbeat/health visibility, graceful deregistration, and
per-agent config visibility. Multi-host already works today via static bearer tokens; this
phase is infrastructure hardening for scale, not a blocker for any product phase, and is the
natural enabler for the team-scale orchestration the Long-Term section below gestures at.

### Features

| #   | Feature                                                                                                                                       | Effort | Depends On                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------- |
| 7.1 | Agent-initiated registration & rotating session credentials — bootstrap-token exchange, `session_id`/`session_secret` with TTL + auto-renewal | L      | —                         |
| 7.2 | Heartbeat & agent health status — primary polls each agent's `/health`, colored dot in Settings' Hosts list                                   | S      | —                         |
| 7.3 | Graceful agent deregistration on shutdown — `SIGTERM` → `POST /internal/deregister`, immediate offline marking                                | M      | 7.1 (blocked by)          |
| 7.4 | Per-agent effective-config visibility — pull-based authenticated config endpoint, works for static-token hosts too                            | S      | —                         |
| 7.5 | HMAC-signed primary→agent requests — signs every request from a registered session                                                            | L      | 7.1 (blocked by)          |
| 7.6 | Connection-time SSRF pinning for agent connections — custom undici dispatcher pinning resolved IPs                                            | M      | — (Icebox, not scheduled) |

### Design Notes

- **Dual-mode auth is the hard constraint across 7.1/7.3/7.5.** Existing manually-registered
  hosts must keep working on static Bearer, unchanged — every new auth mode is additive in
  `internal.ts`'s `onRequest` hook, never a replacement. This is why 7.1 doesn't touch the
  existing Hosts CRUD flow (`src/routes/hosts.ts`) at all; it adds a second, parallel path.
- **Why 7.3 and 7.5 are blocked by 7.1 while 7.2 and 7.4 aren't:** 7.2 (heartbeat) is
  primary-initiated against the agent's already-unauthenticated `/health` route — no new agent
  capability needed. 7.4 (config visibility) is deliberately pull-based rather than
  push-at-registration (a deliberate deviation from #157's original wording, mirroring #222's
  precedent of favoring the simpler independent design over an issue's literal mechanism) — it
  works against any host today. 7.3 (deregistration) and 7.5 (HMAC) both require the agent to
  make an _authenticated outbound call_, or to hold a _per-session secret_ — capabilities only
  7.1's registration flow establishes.
- **7.5 is the highest-risk issue in the phase** — it changes the auth path for every
  primary→agent request from a registered session. Auth is attached in 6+ distinct places in
  `remote-host-client.ts`, not one central spot; 3 are WS upgrades (`openAttach`,
  `openEventsStream`, `openPreviewWs`) where only the `ws` package's client (not the browser
  `WebSocket`) can carry a custom header, and the signature can only cover the upgrade request
  itself. Needs adversarial review and an extended `test/integration/multi-host.test.ts` pass
  before merge — this replaces working auth for the registered-host path.
- **7.6 (SSRF pinning) stays in the roadmap project's Icebox, not Phase 7** — named in #157's
  original motivation and genuinely still absent (`url-guard.ts`'s `isAllowedHttpUrl` is
  IP-literal-only, validated once at registration time, no DNS-rebinding protection), but
  orthogonal complexity (a custom undici dispatcher) deliberately kept deferred rather than
  phased in alongside the rest.
- Parent tracking issue #157 carries the full original design doc; 7.1–7.6 are linked to it as
  native GitHub sub-issues, with 7.3/7.5 marked "blocked by" 7.1 via GitHub's issue-dependencies
  feature (distinct from the sub-issue parent/child relationship).

---

## Long-Term: Post-Phase 6

Once the Task Master is operational, the remaining frontier is **team-scale orchestration**:

- Multi-user task queues — multiple developers submitting and reviewing tasks
- Task dependencies — a task blocks on another's completion
- Scheduled/recurring tasks — e.g. "run dependency update every Monday"
- Non-GitHub backends — GitLab, Bitbucket, Jira, Linear

These are not yet scoped into phases.

---

## Dependency Graph

```
Phase 1 (Notifications)
  ├── 1.8 (Kanban) — session state transitions from event model
  ├── Phase 2 (Hooks) — uses notification event model for hook message delivery
  │     ├── 2.8 (Timeline) — draws from file changes (2.6) + review gates (2.7)
  │     ├── Phase 2.5 (Task Master — Thin Slice) — needs Phase 1/2 stable, NOT the hook
  │     │     socket or review gate specifically (spawn-time env var, not hooks)
  │     │     └── Phase 6 (Task Master — Full) — hardens the thin slice: state machine,
  │     │           GitHub sync, Tasks panel, automated promotion (needs review gate 2.7)
  │     ├── Phase 3 (Browser) — hook system triggers browser actions
  │     │     └── Phase 3 Follow-ups (3.7–3.12) — MCP tools + complete automation API,
  │     │           iframe UX, download/frame/auth follow-ups
  │     ├── Phase 4 (Socket API) — notification events streamed over socket
  │     └── Phase 5 (Subagents) — Track A's agent-attribution envelope rides the hook protocol
  └── Phase 4 (Socket API) — notification events streamed over socket
        ├── 4.5 (Browser over socket) — builds on 3.7's completed REST API
        ├── 4.7 (History) — persistent event storage, CLI queryable
        └── Phase 5 (Subagents) — Track B's spawn_child op is a socket op (needs 4.1)

Phase 2.5 (Thin Slice) requires: GitHub integration + Phase 1 + Phase 2 (stable, not specific features)
Phase 6 (Full) requires: Phase 2.5 (Thin Slice) + 2.7 (review gate)
Phase 6 benefits from but does NOT require: Phase 3 (Browser), Phase 5 (Subagents) — see Sequencing Rationale

Phase 7 (Secure Multi-Host) — structurally independent, no arrows in from Phases 1–6; hardens
  a mechanism (#26/#27) that already works today. Prerequisite framing for Long-Term's
  team-scale/multi-host orchestration bullets, not for any numbered phase above.
```

Each phase is independently shippable. Later phases consume events produced by earlier ones but don't block them.

---

## Sequencing Rationale

Notifications first because:

1. It improves the existing UX immediately — no new agent integration needed
2. It creates the event model that every subsequent phase consumes
3. It's the smallest scope with the highest visibility impact

Hooks second because:

1. They feed richer data into the Phase 1 event model
2. They unlock the review gate (the core of the vision)
3. They're additive to the existing PTY-parsed channel — no regression risk

Task Master (Thin Slice) pulled forward to right after Hooks because:

1. It's the payoff the whole roadmap is building toward — proving it early, cheaply, validates every phase that follows before they're built
2. It only needs Phase 1/2 to be _stable_, not any specific Phase 2 feature (no hook socket, no review gate) — so it doesn't actually wait on anything Browser/Socket/Subagents would otherwise gate it behind
3. It ships behind the same flag as the full Task Master (Phase 6), so it's a no-regression, opt-in addition
4. If the core loop doesn't feel right, that's cheap to learn now and expensive to learn after three more phases of infrastructure investment

Browser third because:

1. Agents need to verify their own work — load a page, click through a flow, confirm a UI change — against a browser Mullion controls, not the user's local machine's browser; this is what actually closes the verification gap in the agent loop
2. It's the largest-scope phase and benefits most from having hooks in place
3. The hook system lets agents trigger browser actions without code changes
4. The frame-streaming infrastructure is independent of the notification model

Socket API fourth because:

1. The socket surface is defined by the features already built (notifications, hooks, browser)
2. It's primarily a transport/ergonomics improvement over existing REST endpoints
3. The CLI client unlocks scripting workflows

Subagents last because:

1. It depends on the hook protocol (Phase 2) for Track A's agent-attribution envelope, and the socket API (Phase 4) for Track B's session-spawn op
2. Track A's scope only became clear once Phase 2's real hook payloads (`agent_id`/`agent_type`, no PID) were verified against Claude Code — building it earlier would have designed against the wrong (OS-subprocess) mechanism
3. The visualization decisions benefit from settled notification UI patterns (Phase 1)

Task Master (Full) last because:

1. The core loop already shipped early as the Phase 2.5 Thin Slice — Phase 6 is the hardening pass (state machine, GitHub sync, dedicated panel, automated promotion), not the first proof of the concept
2. It integrates every preceding phase — it's the workflow that makes them useful together
3. It depends on hooks (Phase 2) for agent progress reporting and the review gate (2.7) for automated approval
4. It's gated by the same flag as the Thin Slice, so it can ship as soon as it's ready without waiting for Phases 3-5

Secure Multi-Host last because:

1. The mechanism it hardens already works today (#26/#27) — this is infrastructure hardening for scale, not a blocker for any product phase
2. It's a priority call, not a technical dependency: nothing in Phases 1–6 needs it, and it needs nothing from them
3. It's the natural point to invest in trust/scale infrastructure once the core single-instance product is stable, ahead of the team-scale orchestration Long-Term gestures at

---

## Pre-Existing Issues Mapped to Roadmap

These open issues from before the roadmap was established map directly into specific phases. They've been updated with milestone + phase label assignments to reflect their place in the timeline.

### Phase 1

| Issue                                                                                                                    | How it fits                                                                                                                      | Status                     |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| [#98](https://github.com/s3ntin3l8/mullion-session-manager/issues/98) — Visual highlights for panels needing interaction | Core frontend design for attention-state visualization. Feeds into 1.1 (event model) and 1.4 (notification panel).               | Closed — completed         |
| [#97](https://github.com/s3ntin3l8/mullion-session-manager/issues/97) — TUI activity detection false positives           | Root cause analysis and remaining fixes (1/2/4) map to 1.6 (attention-clear heuristics). Fix 3 (lastUserInputAt) already merged. | Closed — superseded by 1.6 |
| [#95](https://github.com/s3ntin3l8/mullion-session-manager/issues/95) — Mobile PWA push notifications                    | Uses Push API rather than Phase 1's browser Notification API. Parallel track — needs service worker infrastructure (#87) first.  | Kept open, unassigned      |
| [#211](https://github.com/s3ntin3l8/mullion-session-manager/issues/211) — Kanban board view (1.8)                        | Pure frontend alternative to list view, driven by event model state transitions.                                                 | Closed — completed         |

### Phase 2

| Issue                                                                                            | How it fits                                                                                                           | Status             |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------ |
| [#212](https://github.com/s3ntin3l8/mullion-session-manager/issues/212) — Session timeline (2.8) | Per-session detail panel fed by hook-sourced file changes and review gates. Complements the notification panel (1.4). | Closed — completed |

### Phase 2.5 (Task Master — Thin Slice)

Pulled forward from Phase 6 — see the Phase 2.5 section above and the Sequencing Rationale for why.

| Issue                                                                                                                            | How it fits                                                                                                                                                                                                               | Status             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| [#214](https://github.com/s3ntin3l8/mullion-session-manager/issues/214) — 2.5.1: Task watcher service (minimal, thin slice)      | Retargeted from Phase 6's 6.1. Trimmed of the state-machine dependency for the thin slice.                                                                                                                                | Closed — completed |
| [#216](https://github.com/s3ntin3l8/mullion-session-manager/issues/216) — 2.5.2: Agent spawner (minimal, thin slice)             | Retargeted from Phase 6's 6.3. Trimmed of the hook-socket dependency; uses a plain env var. Spawns into an isolated worktree branched from `origin/<default>` (see Worktree ownership decision + Phase 2.5 design notes). | Closed — completed |
| [#219](https://github.com/s3ntin3l8/mullion-session-manager/issues/219) — 2.5.3: Manual claim (minimal, thin slice)              | Retargeted from Phase 6's 6.6. Trimmed of the Tasks-panel dependency; wired into existing UI.                                                                                                                             | Closed — completed |
| [#224](https://github.com/s3ntin3l8/mullion-session-manager/issues/224) — 2.5.4: Review & manual PR via existing UI (thin slice) | New. No code — validates the loop using existing session/git/GitHub panels.                                                                                                                                               | Closed — completed |

### Phase 3

| Issue                                                                                                           | How it fits                                                                                                                    | Status                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| [#110](https://github.com/s3ntin3l8/mullion-session-manager/issues/110) — Browser panel not persisted in layout | Must be fixed before or alongside 3.3 (BrowserPane component). Without layout persistence, browser panes don't survive reload. | Milestone + `phase-3` assigned |

### Phase 3 Follow-ups

| Issue                                                                                                                           | How it fits                                                                                                                                                                            | Status                         |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [#379](https://github.com/s3ntin3l8/mullion-session-manager/issues/379) — 3.7: Agent automation API, MCP tools & console access | Core of the follow-up phase. Completes the REST API (press, type, select, wait, dialog, hover, scroll, get, console, errors) and adds a browser MCP tool for Claude Code.              | Milestone + `phase-3` assigned |
| [#380](https://github.com/s3ntin3l8/mullion-session-manager/issues/380) — 3.8: Iframe browser reliability & UX clarity          | Strengthens the iframe as the primary human preview tool: layout persistence (fixes #110), dev server status, "Preview" vs "Agent Browser" labeling, cookie upload, follow-agent sync. | Milestone + `phase-3` assigned |
| [#381](https://github.com/s3ntin3l8/mullion-session-manager/issues/381) — 3.10: Browser download management                     | Sub-issue of #379. Captures files triggered by agent interaction (CSV exports, PDFs, reports).                                                                                         | Milestone + `phase-3` assigned |
| [#382](https://github.com/s3ntin3l8/mullion-session-manager/issues/382) — 3.11: Frame/iframe support                            | Sub-issue of #379. Enters/exits iframe contexts so agents can interact with embedded content (payment forms, chat widgets).                                                            | Milestone + `phase-3` assigned |
| [#383](https://github.com/s3ntin3l8/mullion-session-manager/issues/383) — 3.12: Preview-host auth token                         | Sub-issue of #380. Closes the gap in auth.ts:51-53 with a short-lived token validated by preview-proxy.ts.                                                                             | Milestone + `phase-3` assigned |

### Phase 4

| Issue                                                                                                             | How it fits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| [#134](https://github.com/s3ntin3l8/mullion-session-manager/issues/134) — mullion CLI, MCP server, auto-detection | CLI component maps directly to 4.6 (CLI client, closed by #190/#402, packaged in #403). MCP server extends the socket/API concept with session/project/preview tools over the control socket (`src/mcp/tools.mjs`, shipped in #406). Auto-detection ([#404](https://github.com/s3ntin3l8/mullion-session-manager/issues/404)) and the agent-skill doc ([#405](https://github.com/s3ntin3l8/mullion-session-manager/issues/405)) split out as separate follow-ups, orthogonal to the socket work. | Closed — CLI + MCP tools shipped; #404/#405 tracked separately |
| [#213](https://github.com/s3ntin3l8/mullion-session-manager/issues/213) — Unified session history (4.7)           | Persistent event storage, search/filter, CLI queryable via `mullion logs`. Opt-in with configurable retention.                                                                                                                                                                                                                                                                                                                                                                                   | Milestone + `phase-4` assigned — not started                   |

### Phase 6

| Issue                                                                                                         | How it fits                                                                                                                                                                       | Status                         |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [#215](https://github.com/s3ntin3l8/mullion-session-manager/issues/215) — Task state machine + REST API (6.2) | Task lifecycle: Pending → Claimed → In Progress → Reviewing → Done/Failed. REST endpoints for claim/approve/reject. Formalizes 2.5.1's minimal watcher.                           | Milestone + `phase-6` assigned |
| [#217](https://github.com/s3ntin3l8/mullion-session-manager/issues/217) — GitHub issue state sync (6.4)       | Updates labels, comments, assignee on the GitHub issue as task progresses.                                                                                                        | Milestone + `phase-6` assigned |
| [#218](https://github.com/s3ntin3l8/mullion-session-manager/issues/218) — Tasks panel frontend (6.5)          | Dockview panel rendering the task board (Kanban by status; see Task Model & Task Board). Detail view with embedded timeline and action buttons. Replaces 2.5.3's ad hoc claim UI. | Milestone + `phase-6` assigned |
| [#220](https://github.com/s3ntin3l8/mullion-session-manager/issues/220) — Task → PR promotion (6.7)           | On approval, create PR from agent's branch, close issue with `mullion-done` label. On rejection, return to In Progress. Automates 2.5.4's manual step.                            | Milestone + `phase-6` assigned |
| [#233](https://github.com/s3ntin3l8/mullion-session-manager/issues/233) — Local task entity (6.9)             | New. Data-model/reconciliation-rule foundation for #215 (6.2) and #218 (6.5) — see Task Model & Task Board above the Phase 1 section.                                             | Milestone + `phase-6` assigned |

_(6.1, 6.3, 6.6 — see #214/#216/#219, retargeted into Phase 2.5 above. 6.8 (worktree lifecycle) is new — no pre-existing issue; it resurrects PR #152's removed `git-worktree.ts`, recoverable from commit `7588085`. See #162, referenced in Cross-Cutting/Standalone below. 6.9 (local task entity) is new — issue #233.)_

### Phase 7

| Issue                                                                                                                                      | How it fits                                                                                                                                                                    | Status                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [#157](https://github.com/s3ntin3l8/mullion-session-manager/issues/157) — Phase 7: Secure Agent Lifecycle & Discovery                      | Parent tracking issue, retitled to match the milestone. Carries the full original design doc; 7.1–7.6 below are linked to it as native GitHub sub-issues.                      | Milestone + `phase-7` assigned                             |
| [#245](https://github.com/s3ntin3l8/mullion-session-manager/issues/245) — 7.1: Agent-initiated registration & rotating session credentials | The hinge issue — bootstrap-token exchange, `session_id`/`session_secret` with TTL + auto-renewal. Additive alongside the existing static-Bearer path.                         | Milestone + `phase-7` assigned                             |
| [#246](https://github.com/s3ntin3l8/mullion-session-manager/issues/246) — 7.2: Heartbeat & agent health status                             | Primary polls each agent's existing `/health`; colored dot in Settings' Hosts list. Independent of 7.1.                                                                        | Milestone + `phase-7` assigned                             |
| [#248](https://github.com/s3ntin3l8/mullion-session-manager/issues/248) — 7.3: Graceful agent deregistration on shutdown                   | `SIGTERM` → `POST /internal/deregister` using 7.1's session credential. Blocked by #245 (7.1) via GitHub's issue-dependencies feature.                                         | Milestone + `phase-7` assigned; blocked by #245            |
| [#247](https://github.com/s3ntin3l8/mullion-session-manager/issues/247) — 7.4: Per-agent effective-config visibility                       | Pull-based authenticated config endpoint — works for static-token hosts too, independent of 7.1.                                                                               | Milestone + `phase-7` assigned                             |
| [#249](https://github.com/s3ntin3l8/mullion-session-manager/issues/249) — 7.5: HMAC-signed primary→agent requests                          | Signs every request from a registered session; static-bearer hosts unaffected. Blocked by #245 (7.1). Highest-risk issue in the phase — needs adversarial review before merge. | Milestone + `phase-7` assigned; blocked by #245            |
| [#250](https://github.com/s3ntin3l8/mullion-session-manager/issues/250) — 7.6: Connection-time SSRF pinning for agent connections          | Named in #157's original motivation, genuinely still absent. Deliberately kept in the backlog — orthogonal complexity, not phased in.                                          | No milestone/`phase-7` label — Icebox on the project board |

### Cross-Cutting / Standalone

| Issue                                                                                                                                                                 | How it fits                                                                                                                                                                                                                                                                                                                                                                                                    | Status                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| [#102](https://github.com/s3ntin3l8/mullion-session-manager/issues/102) — Per-PR CI/CD status — Phase 1: traffic light + expandable details                           | Standalone GitHub-integration enhancement (existing `github.ts` REST client already fetches issues/PRs/CI — this extends it to per-PR runs with a server-side poller). Implemented in [PR #223](https://github.com/s3ntin3l8/mullion-session-manager/pull/223). Relevant to Task Master as a readiness signal for 6.7 (Task → PR promotion) and the review gate (2.7), though not a hard dependency of either. | Closed — completed (#223, #244)         |
| [#221](https://github.com/s3ntin3l8/mullion-session-manager/issues/221) — Per-PR CI/CD status — Phase 2: webhooks, job-level detail, inline logs                      | Follow-up to #102. Webhooks here are scoped to CI-status push delivery only — see the Task-source architecture decision above, which is unaffected. Implemented in [PR #384](https://github.com/s3ntin3l8/mullion-session-manager/pull/384).                                                                                                                                                                   | Closed — completed (#384)               |
| [#222](https://github.com/s3ntin3l8/mullion-session-manager/issues/222) — Per-PR CI/CD status — Phase 1 follow-up: remote-hosted project support                      | Follow-up to #102; #102's Phase 1 skipped remote-hosted projects (no local `.git/config` to resolve owner/repo from). Shared the "GitHub repo reference for remote-hosted projects" gap with the existing `/github` endpoint (#27). Implemented in [PR #244](https://github.com/s3ntin3l8/mullion-session-manager/pull/244).                                                                                   | Closed — completed (#244)               |
| [#60](https://github.com/s3ntin3l8/mullion-session-manager/issues/60) — GitHub App investigation                                                                      | Research task for webhooks vs. polling generally. Not blocking; #221 is a narrower, already-scoped instance of the same question for CI status specifically — implemented in [PR #384](https://github.com/s3ntin3l8/mullion-session-manager/pull/384) using PAT-registered webhooks + adaptive polling, not a GitHub App.                                                                                      | Reference only; resolved by #384        |
| [#162](https://github.com/s3ntin3l8/mullion-session-manager/issues/162) — Worktree staleness: PR #152 worktree mode goes stale on long-open windows and session reuse | Resolved by removing worktree management entirely (PR #197). Re-addressed here, differently: 2.5.2 + 6.8 reintroduce worktree creation coupled to task-claim time instead of session-insert time, avoiding the idle-window staleness this issue identified. Not reopened as the old eager model — see the Worktree ownership decision above.                                                                   | Closed (#197); referenced, not reopened |

### Prod Bugs (fix regardless of roadmap timing)

| Issue                                                                                                                     | Priority |
| ------------------------------------------------------------------------------------------------------------------------- | -------- |
| [#122](https://github.com/s3ntin3l8/mullion-session-manager/issues/122) — Ctrl+V image paste broken on Linux/Windows      | Low      |
| [#121](https://github.com/s3ntin3l8/mullion-session-manager/issues/121) — Floating peek panels: no close, no drag-drop    | Low      |
| [#107](https://github.com/s3ntin3l8/mullion-session-manager/issues/107) — Claude Code TUI display: prompt lines disappear | Low      |
| [#94](https://github.com/s3ntin3l8/mullion-session-manager/issues/94) — Scrollbar thumb size/position off                 | Low      |
| [#91](https://github.com/s3ntin3l8/mullion-session-manager/issues/91) — Terminal pane visual border/theming               | Low      |
| [#85](https://github.com/s3ntin3l8/mullion-session-manager/issues/85) — Mobile UI loads desktop split view                | Low      |
