# Mullion Roadmap — Central Command for AI-Driven Development

**Status:** Draft
**Last updated:** 2026-07-22
**Vision:** Mullion orchestrates the entire AI-driven development workflow. Describe a task, Mullion spawns the right agent(s), monitors progress, notifies when input is needed, presents diffs for review, and cycles through approval/resubmit — all from one dashboard, replacing the traditional IDE.

---

## Architecture Decisions (Cross-Cutting)

These decisions apply across multiple phases and are established here to avoid re-litigating them later.

| Decision            | Choice                                                                               | Rationale                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notification model  | In-memory event ring buffer per session, consumed by frontend                        | PTY output is already streaming; adding a DB write per event creates write amplification at no benefit for the primary use case (real-time display). DB persistence added later if needed for history/replay. |
| Agent communication | Two-channel: PTY-parsed (OSC/BEL, works today) + env-injected structured hooks (new) | Every agent works via Channel 1. Channel 2 adds rich metadata (progress, file changes, review gates) for agents that support hooks — no agent modification required for basic functionality.                  |
| Browser backend     | Playwright Chromium on host, streaming frames via WebSocket                          | Full CDP access for DOM snapshotting, clicking, filling, JS evaluation. Heavier than a pure iframe but the only way agents can truly _control_ a browser.                                                     |
| API surface         | HTTP REST (existing) + Unix socket supplement                                        | Socket is an alternative transport for a subset of operations, not a separate API. Low-latency PTY I/O and local CLI integration.                                                                             |
| Subagent detection  | Preferred: hook-based fork/join signals. Fallback: process-tree polling via `/proc`. | Hooks are clean and explicit. Process-tree polling is a no-agent-change-needed fallback. Both emit events into the same notification model.                                                                   |
| Event persistence   | In-memory ring buffer for live feed (Phase 1); optional DB for history (Phase 4)     | Timeline and history clients need queryable event storage. Configurable retention, off by default — no regression for Phase 1's in-memory model.                                                              |

---

## Phase 1: Richer Notifications

**Goal:** Replace the current `attention: boolean` + `activity: "working" | "idle"` with a full notification event system — structured, multi-channel, and extensible.

### Features

| #   | Feature                                                                                                                                                     | Effort | Depends On |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 1.1 | Notification event model (backend) — `PtyManager` emits structured events (`kind`, `timestamp`, `payload`) consumed by subscribers                          | M      | —          |
| 1.2 | Per-session status line in sidebar — last event text visible inline                                                                                         | S      | 1.1        |
| 1.3 | Session tab notification badges — count + type icon on workspace tabs                                                                                       | S      | 1.1        |
| 1.4 | Notification panel — slide-out sidebar/overlay listing recent events grouped by workspace                                                                   | L      | 1.1        |
| 1.5 | Desktop notifications via Browser Notification API — fire when tab is unfocused                                                                             | S      | 1.1        |
| 1.6 | Attention-clear heuristics — refine the current `ATTENTION_CLEAR_WINDOW_MS` logic to avoid false positives from rapid BEL/OSC sequences during heavy output | S      | 1.1        |
| 1.7 | Sidebar session row redesign — surface worktree/branch/PR info per session inline, alongside the notification status line from 1.2                          | L      | 1.1, 1.2   |
| 1.8 | Kanban board view — sessions grouped into columns (Running, Needs Attention, Exited) with drag-to-reorder and column counts                                 | M      | 1.1        |

### Design Notes

- Events are in-memory only (ring buffer per session, ~100 events). No DB persistence in Phase 1.
- The `kind` enum starts with `attention`, `status_change`, `title_change` and is extended in later phases.
- The frontend notification panel is a new component, not embedded in the existing sidebar. Accessible via a bell icon in the toolbar (existing) but opens a dedicated panel.
- The sidebar redesign (1.7) is the Phase 1 frontend flagship — the notification status line (1.2) and git/worktree/PR info make the session row the primary information surface. Backend work includes per-worktree git status polling, per-branch PR filtering, and branch/worktree enumeration endpoints (`git-refs`).
- Kanban (1.8) is a pure frontend view with no new backend work. Session state transitions from the event model drive card movement between columns. Exists alongside the list view; user toggles between them.

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
- Worktree hook investigation: the hook protocol (2.2) should define optional `worktree` messages (`{"kind":"worktree","action":"create|switch","branch":"..."}`) so agents can signal worktree intent without Mullion managing worktrees itself. This exploration determines whether worktree tracking graduates to a Phase 5 feature or remains passive sidebar instrumentation (1.7).

---

## Phase 3: Controllable Browser

**Goal:** An in-app browser pane that agents can script — navigate, snapshot the DOM, click elements, fill forms, evaluate JavaScript — alongside terminal panes in the dockview layout.

### Features

| #   | Feature                                                                                                                                        | Effort | Depends On |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 3.1 | Playwright browser manager (backend) — pool of Chromium processes, lifecycle management                                                        | L      | —          |
| 3.2 | WebSocket frame streaming — browser frames streamed from Playwright to frontend via WebSocket                                                  | M      | 3.1        |
| 3.3 | `BrowserPane` dockview component — iframe-based panel with URL bar, back/forward, reload controls                                              | M      | 3.2        |
| 3.4 | Session-to-browser binding — associate a browser pane with a session, agents target their session's browser                                    | S      | 3.3, 3.1   |
| 3.5 | Agent browser automation API — `POST /api/sessions/:id/browser` with actions: `navigate`, `snapshot`, `click`, `fill`, `eval`, `screenshot`    | L      | 3.3, 3.1   |
| 3.6 | Cookie/session import — import cookies from the user's real browser (Chrome/Firefox profiles) so agent-controlled browser starts authenticated | M      | 3.5        |

### Design Notes

- Playwright launches a Chromium instance per project (or per workspace, configurable). The instance persists across pane open/close — closing the pane doesn't kill the browser.
- Frame streaming: Playwright's CDP screenshots are pushed via WebSocket to the frontend at ~5fps (configurable). The iframe renders these frames. User interactions (clicks in the iframe) are proxied back through the WebSocket to Playwright.
- The agent automation API is the bridge between the agent's chat context and the browser. When an agent says "I'll open the preview", it sends a `navigate` action via Mullion's API, and the browser pane updates.
- Combined with Phase 2 hooks: an agent could emit `{"kind":"browser_request","action":"navigate","url":"http://localhost:5173"}` via the hook socket, and Mullion opens the URL in the project's browser pane.

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

### Design Notes

- Every socket operation has an HTTP equivalent. The socket is not a separate API — it's an alternative transport.
- Auth via filesystem permissions (`0600`) + optional embedded token from the parent process's environment.
- Message framing matches the existing WebSocket terminal protocol (JSON header with length prefix) so client code can be shared.
- The CLI client is the primary consumer (`mullion exec`, `mullion ps`, `mullion logs`).
- Event storage for history (4.7) is opt-in with configurable retention (default: off, matching Phase 1's in-memory model). When enabled, events are written to the existing SQLite DB in a new `session_events` table. The live event ring buffer (Phase 1) continues to operate independently regardless of persistence settings.

---

## Phase 5: Subagent / Fork Awareness

**Goal:** Detect when an agent spawns subprocesses (teammates, parallel tasks, subagents) and visualize them as distinct sessions with parent-child relationships.

### Features

| #   | Feature                                                                                                                                | Effort | Depends On |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| 5.1 | Hook-based fork/join signals — agents emit `{"kind":"fork","childPid":1234}` and `{"kind":"join","childPid":1234}` via the hook socket | S      | 2.2        |
| 5.2 | Process-tree polling fallback — `/proc`-based detection of child processes under a session's PID (no agent hooks needed)               | M      | —          |
| 5.3 | Subagent session model — forked subagents get `Session` objects in `PtyManager`, linked to parent                                      | M      | 5.1, 5.2   |
| 5.4 | Automatic subagent layout — dockview auto-arranges child sessions alongside parent (grid layout)                                       | M      | 5.3        |
| 5.5 | Hierarchical sidebar view — sidebar toggle between flat (all independent) and hierarchical (parent/child grouped)                      | M      | 5.3, 1.4   |
| 5.6 | Individual subagent control — kill, monitor, review each subagent independently from the parent                                        | S      | 5.3        |

### Design Notes

- Subagents detected via hooks are preferred (explicit, reliable). Process-tree polling is a fallback for agents that don't emit hooks.
- Subagent sessions share the parent's project and working directory but get their own `Session` object, PTY, and dtach persistence.
- Layout strategy for multiple subagents: dockview's `addGroup` with automatic arrangement. The parent session retains its original position; children spread to fill available space.
- Closing a subagent pane kills only that subagent. Closing the parent offers a choice: kill all children, detach children as independent sessions, or prompt per-child.

---

## Long-Term: Review Gate (Post-Phase 5)

**Goal:** Full Task → Agent → Review loop — describe a task, Mullion spawns the agent with context, agent pauses at review points, Mullion presents diffs for approval, user approves or sends back, cycle continues.

### Status

Not yet scoped into phases. The foundation is being laid across multiple phases:

- Phase 1: Notification events provide the delivery channel for review requests
- Phase 2: Hook signals provide the structured review-gate protocol
- Phase 3: Browser pane lets agents show previews during the review
- Phase 5: Subagent awareness lets review gates span multi-agent runs

The review gate itself (diff presentation, approval/resubmit cycle, context accumulation) is the final integration of these pieces into a workflow — and is a candidate for Phase 6 once the foundation is proven.

---

## Dependency Graph

```
Phase 1 (Notifications)
  ├── 1.8 (Kanban) — session state transitions from event model
  ├── Phase 2 (Hooks) — uses notification event model for hook message delivery
  │     ├── 2.8 (Timeline) — draws from file changes (2.6) + review gates (2.7)
  │     ├── Phase 3 (Browser) — hook system triggers browser actions
  │     ├── Phase 4 (Socket API) — notification events streamed over socket
  │     └── Phase 5 (Subagents) — hook system provides fork/join signals
  │
  └── Phase 4 (Socket API) — notification events streamed over socket
        ├── 4.7 (History) — persistent event storage, CLI queryable
        └── Phase 5 (Subagents) — subagent events streamed over socket

Review Gate = Phase 1 + Phase 2 + Phase 3 + Phase 5 integrated
```

Each phase is independently shippable. Later phases consume events produced by earlier ones but don't block them.

---

## Sequencing Rationale

Notifications first because:

1. It improves the existing UX immediately — no new agent integration needed
2. It creates the event event model that every subsequent phase consumes
3. It's the smallest scope with the highest visibility impact

Hooks second because:

1. They feed richer data into the Phase 1 event model
2. They unlock the review gate (the core of the vision)
3. They're additive to the existing PTY-parsed channel — no regression risk

Browser third because:

1. It's the largest-scope phase and benefits most from having hooks in place
2. The hook system lets agents trigger browser actions without code changes
3. The frame-streaming infrastructure is independent of the notification model

Socket API fourth because:

1. The socket surface is defined by the features already built (notifications, hooks, browser)
2. It's primarily a transport/ergonomics improvement over existing REST endpoints
3. The CLI client unlocks scripting workflows

Subagents last because:

1. It depends on the hook protocol (Phase 2) for the clean implementation path
2. It's the most speculative — process-tree polling may need tuning against real agent behavior
3. The visualization decisions benefit from settled notification UI patterns (Phase 1)

---

## Pre-Existing Issues Mapped to Roadmap

These open issues from before the roadmap was established map directly into specific phases. They've been updated with milestone + phase label assignments to reflect their place in the timeline.

### Phase 1

| Issue                                                                                                                    | How it fits                                                                                                                      | Status                         |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [#98](https://github.com/s3ntin3l8/mullion-session-manager/issues/98) — Visual highlights for panels needing interaction | Core frontend design for attention-state visualization. Feeds into 1.1 (event model) and 1.4 (notification panel).               | Milestone + `phase-1` assigned |
| [#97](https://github.com/s3ntin3l8/mullion-session-manager/issues/97) — TUI activity detection false positives           | Root cause analysis and remaining fixes (1/2/4) map to 1.6 (attention-clear heuristics). Fix 3 (lastUserInputAt) already merged. | Closed — superseded by 1.6     |
| [#95](https://github.com/s3ntin3l8/mullion-session-manager/issues/95) — Mobile PWA push notifications                    | Uses Push API rather than Phase 1's browser Notification API. Parallel track — needs service worker infrastructure (#87) first.  | Kept open, unassigned          |
| [#211](https://github.com/s3ntin3l8/mullion-session-manager/issues/211) — Kanban board view (1.8)                        | Pure frontend alternative to list view, driven by event model state transitions.                                                 | Milestone + `phase-1` assigned |

### Phase 2

| Issue                                                                                            | How it fits                                                                                                           | Status                         |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [#212](https://github.com/s3ntin3l8/mullion-session-manager/issues/212) — Session timeline (2.8) | Per-session detail panel fed by hook-sourced file changes and review gates. Complements the notification panel (1.4). | Milestone + `phase-2` assigned |

### Phase 3

| Issue                                                                                                           | How it fits                                                                                                                    | Status                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| [#110](https://github.com/s3ntin3l8/mullion-session-manager/issues/110) — Browser panel not persisted in layout | Must be fixed before or alongside 3.3 (BrowserPane component). Without layout persistence, browser panes don't survive reload. | Milestone + `phase-3` assigned |

### Phase 4

| Issue                                                                                                             | How it fits                                                                                                                                   | Status                         |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [#134](https://github.com/s3ntin3l8/mullion-session-manager/issues/134) — mullion CLI, MCP server, auto-detection | CLI component maps directly to 4.6 (CLI client). MCP server extends the socket/API concept. Auto-detection is a Phase 2-adjacent enhancement. | Milestone + `phase-4` assigned |
| [#213](https://github.com/s3ntin3l8/mullion-session-manager/issues/213) — Unified session history (4.7)           | Persistent event storage, search/filter, CLI queryable via `mullion logs`. Opt-in with configurable retention.                                | Milestone + `phase-4` assigned |

### Cross-Cutting / Standalone

| Issue                                                                                                        | How it fits                                                                                                               | Status                |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| [#157](https://github.com/s3ntin3l8/mullion-session-manager/issues/157) — Secure Agent Lifecycle & Discovery | Multi-host auth and HMAC-signed requests. Relevant when multi-host becomes a priority but not blocking any current phase. | Kept open, unassigned |
| [#102](https://github.com/s3ntin3l8/mullion-session-manager/issues/102) — GitHub CI/CD per PR                | Standalone feature. Requires existing GitHub integration to mature first (#60 research).                                  | Kept open, unassigned |
| [#60](https://github.com/s3ntin3l8/mullion-session-manager/issues/60) — GitHub App investigation             | Research task for webhooks vs. polling. Not blocking.                                                                     | Kept open, unassigned |

### Prod Bugs (fix regardless of roadmap timing)

| Issue                                                                                                                     | Priority |
| ------------------------------------------------------------------------------------------------------------------------- | -------- |
| [#162](https://github.com/s3ntin3l8/mullion-session-manager/issues/162) — Worktree staleness on long-open windows         | Medium   |
| [#122](https://github.com/s3ntin3l8/mullion-session-manager/issues/122) — Ctrl+V image paste broken on Linux/Windows      | Low      |
| [#121](https://github.com/s3ntin3l8/mullion-session-manager/issues/121) — Floating peek panels: no close, no drag-drop    | Low      |
| [#107](https://github.com/s3ntin3l8/mullion-session-manager/issues/107) — Claude Code TUI display: prompt lines disappear | Low      |
| [#94](https://github.com/s3ntin3l8/mullion-session-manager/issues/94) — Scrollbar thumb size/position off                 | Low      |
| [#91](https://github.com/s3ntin3l8/mullion-session-manager/issues/91) — Terminal pane visual border/theming               | Low      |
| [#85](https://github.com/s3ntin3l8/mullion-session-manager/issues/85) — Mobile UI loads desktop split view                | Low      |
