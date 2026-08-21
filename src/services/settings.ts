import { eq } from "drizzle-orm";
import { settings as settingsTable } from "../db/schema.js";
import type { getDb } from "../db/client.js";
// Theme/CursorStyle/SidebarDensity/SoundName (AppSettings's leaf unions)
// now physically live in src/shared/types.ts (hand-mirrored 1:1 on the
// frontend — see frontend/src/api.ts's own re-export). Re-exported below so
// every existing backend importer of this module keeps working unchanged.
// AppSettings itself stays declared here — see shared/types.ts's own doc
// comment for why (its notificationMatrix field is a real, deliberate
// backend/frontend type divergence, not cosmetic drift).
import type {
  Theme,
  CursorStyle,
  SidebarDensity,
  SoundName,
  LayoutMode,
  TabletPaneCap,
} from "../shared/types.js";

export type { Theme, CursorStyle, SidebarDensity, SoundName, LayoutMode, TabletPaneCap };

// Shared shape + defaults for the server-persisted Settings blob (the
// Settings modal's "Everything wired now" rework). One JSON blob, same
// "backend stores/replays an opaque value" philosophy as
// `workspaces.layout` / `sessions.command` — this service is the only place
// that actually understands its structure; src/routes/settings.ts,
// src/routes/projects.ts, src/routes/sessions.ts,
// src/services/session-lifecycle.ts, and src/plugins/pty.ts all read it
// through `getStoredSettings` below rather than each re-implementing
// "read the singleton row and merge over defaults."
//
// Deliberately a single flat-ish object rather than one DB column per pref:
// new settings get added here (and to DEFAULT_SETTINGS) without a schema
// migration, and `mergeSettings` deep-merges a stored (possibly older,
// missing-keys) blob over these defaults so a fresh key introduced by a
// later release always resolves instead of coming back `undefined`.

export interface AppSettings {
  theme: Theme;
  terminal: {
    fontFamily: string;
    fontSize: number;
    // Inner inset (px) between the dockview panel edge and the rendered
    // terminal content, applied on all four sides — see frontend/src/api.ts's
    // matching field for the full rationale (issue #91).
    padding: number;
    colorScheme: string;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    scrollback: number;
    copyOnSelect: boolean;
    pasteOnRightClick: boolean;
    // Honors OSC 52 clipboard-write requests from the foreground program
    // (Claude Code / opencode both copy this way — xterm.js core has no
    // built-in OSC 52 handler, so without this the escape sequence is
    // silently dropped and the CLI's own "copied" toast is a lie). Default
    // on to match expected copy behavior; off lets a security-conscious user
    // deny any PTY-run program the ability to silently overwrite their
    // system clipboard (a paste-swap vector). OSC 52 *read* queries are
    // never answered regardless of this setting — see TerminalPane.tsx.
    clipboardWrite: boolean;
    reconnect: {
      enabled: boolean;
      maxAttempts: number;
    };
    keyCapture: {
      ctrlR: boolean;
      ctrlL: boolean;
      ctrlK: boolean;
    };
    // Opt-in clipboard chords (issue #67 follow-up). Unlike keyCapture above
    // — which takes a key AWAY from the browser and gives it to the terminal
    // — these take a key away from the TERMINAL program: Ctrl+V collides with
    // vim's Visual Block mode and readline's quoted-insert (both raw 0x16),
    // and Ctrl+C is SIGINT. Both default off; the always-on baseline
    // (Ctrl+Insert/Shift+Insert/Cmd+C/Cmd+V) already covers copy/paste
    // without this tradeoff — see TerminalPane.tsx's attachKeyConflictHandler.
    clipboardKeys: {
      ctrlV: boolean;
      ctrlC: boolean;
    };
  };
  sidebarDensity: SidebarDensity;
  // Tablet tier plan, PR 4 — "auto" resolves from live window width
  // (frontend); see shared/types.ts's own doc comment on LayoutMode for the
  // full rationale. tabletPaneCap only takes effect once the resolved tier
  // is "tablet" — a lower cap keeps each column comfortably clear of PR 2's
  // TerminalPane font-shrink threshold, a higher one trades that off for
  // more visible panes; see AppearanceSection.tsx's Settings copy.
  layoutMode: LayoutMode;
  tabletPaneCap: TabletPaneCap;
  // Editable project-scan roots (Settings -> Projects & discovery). Empty
  // array = "use the PROJECTS_ROOTS env var" (see routes/projects.ts) —
  // this lets a fresh deploy keep working from its env config until someone
  // actually edits roots from the UI, at which point the DB value wins.
  projectRoots: string[];
  launchers: {
    defaultShell: string;
    defaultAgent: string;
    hiddenAgents: string[];
    skipPermissionsAgents: string[];
  };
  notifications: {
    channels: {
      browser: boolean;
      sound: boolean;
      // #95 — web push delivery (push-delivery.ts), gated the same way
      // browser/sound already are: per-status via notificationMatrix.notify
      // below, this toggle is the channel-level on/off on top of that.
      push: boolean;
    };
    soundName: SoundName;
    idleThresholdSeconds: number;
    // #98/#168 (frontend PR) — auto-bring-into-focus on an attention
    // transition, read by frontend/src/App.tsx only; this backend never
    // acts on it. Added here (rather than left frontend-only) because
    // deepMerge below only ever merges keys this interface already knows
    // about — a field missing from here would silently fail to persist
    // across a PATCH /api/settings + reload round-trip, defeating the
    // point of a Settings toggle. Mechanical mirror of frontend/src/api.ts's
    // matching field; see that file for the default-off rationale. Combined
    // with `notificationMatrix`'s own `autoFocus` column (both must be true
    // for a given status to auto-focus) — see App.tsx.
    autoFocusOnAttention: boolean;
    /** Per-status notification matrix. Rows = status keys, columns =
     * notify/sound/autoFocus. Seeded from DEFAULT_SETTINGS on first read;
     * deepMerge preserves user overrides. Replaces the old flat
     * attentionAlerts/exitedAlerts/finishedAlerts toggles (issue #318) — see
     * frontend/src/sessionStatus.ts's STATUS_PRESENTATION.defaultNotify for
     * the per-status rationale these defaults mirror (e.g. `finished`
     * defaults to notify:false since a turn completing is by far the
     * highest-frequency notifiable event in the system). */
    notificationMatrix: Record<string, { notify: boolean; sound: boolean; autoFocus: boolean }>;
  };
  dock: {
    /** Default for per-control worktreeRefresh when the control itself
     * doesn't specify one. When true, a worktree created for a dock monitor
     * is periodically synced to the branch's latest commit. */
    defaultWorktreeRefresh: boolean;
    /** Issue #404 — whether a plain (non-dock) session's detected dev
     * server (src/services/dev-server-detect.ts's parseDevServerPort, run
     * periodically by src/plugins/pty.ts's dedicated timer — see
     * PtyManager.sweepDevServerDetection) surfaces as a "dev_server_detected"
     * notification the user can accept or dismiss. "ask" (default) shows
     * the notification; "off" disables the background scan entirely for
     * every plain session. Deliberately NOT a three-way "ask"/"off"/"always"
     * enum: an "always" value that silently rewrites a project's
     * devServerUrl from PTY output with no human confirmation would be
     * genuinely surprising, unlike surfacing it as a notification — the
     * exact same inline detection already exists today as a one-time
     * prefill suggestion in frontend/src/CreateProjectModal.tsx ("Detected
     * dev server on port N — use it?"), so this is not novel behavior. */
    autoDetectDevServer: "ask" | "off";
    /** Issue #73 — whether GET /api/projects/:id/dock merges in
     * auto-discovered Docker Compose services (docker-service-detect.ts)
     * alongside dock.json's configured controls. Default true: this is a
     * visibility kill-switch, not the safety gate — a discovered control
     * still never auto-starts (same as any other dock control), so leaving
     * it on by default doesn't change the dock's "never starts a monitor
     * without a click" invariant. */
    dockerServices: boolean;
  };
  sessions: {
    // Tokens: {agent} {project} {n} — expanded client-side at launch time
    // (see frontend/src/CommandPalette.tsx).
    namePattern: string;
    confirmBeforeKill: boolean;
    hideEndedSessions: boolean;
    // #9 — a task-owned session (worker/review/rebase) is hidden from the
    // sidebar by default, same as any other decluttering toggle here; a
    // "killed" one is already filtered out unconditionally regardless of
    // this setting (see Sidebar.tsx's own filter — that's a status check
    // that runs first, not this preference). Off by default so the sidebar
    // stays focused on sessions a human is more likely to want to glance at
    // or attach to directly.
    showTaskSessions: boolean;
    reconcileIntervalSeconds: number;
    // Rich statuses — a session's `errorState` (api_error/tool_failure) is
    // otherwise cleared only by the next progress/turn_start hook, a genuine
    // keystroke (see write()'s doc comment in pty-manager.ts), a respawn, or
    // the session dying (see session-status.ts's precedence comment). This
    // is the narrow TTL backstop from that plan: swept alongside the
    // existing exited-session reconciliation, on the same interval, so an
    // error whose resolving hook never fires doesn't stick forever. Issue
    // #320 extends this same TTL to the blocked latches (permissionState,
    // planState, gateState, promoteState, elicitationState) — swept by the
    // same timer via sweepStaleStates(). The busy latches (compactState,
    // subagentCount) use staleBusySeconds below instead: a long compaction
    // or a long-running subagent is legitimate, ongoing work, not evidence
    // something silently failed, so it needs a longer backstop than an
    // unresolved error/permission prompt does.
    staleErrorSeconds: number;
    // Same backstop as staleErrorSeconds, but for compactState/subagentCount
    // (issue #320 follow-up) — kept separate and longer-default so a
    // genuinely long compaction or subagent run isn't degraded out from
    // under a still-busy session just because it ran past the much shorter
    // error/permission TTL.
    staleBusySeconds: number;
    // How often the background git-fetcher runs for autoFetch-enabled projects
    // (src/plugins/git-fetcher.ts). 0 disables auto-fetch entirely.
    gitAutoFetchIntervalSeconds: number;
    // Issue #213 (roadmap 4.7) — opt-in persistence of notification events
    // (src/plugins/event-store.ts) to the new `session_events` table. Default
    // off, matching Phase 1's in-memory-only event model (docs/roadmap.md).
    // Covers every enrolled host, not just this process's own — toggling
    // this also opens/closes remote-event-subscriber.ts's per-host
    // subscriptions (see event-store.ts's own doc comment).
    eventPersistence: boolean;
    // Age (in days) past which persisted session_events rows are swept by
    // src/plugins/event-store.ts's retention sweep. 0 = unlimited/no sweep,
    // same "0 disables" convention as gitAutoFetchIntervalSeconds above.
    eventRetentionDays: number;
    // Issue #213's own body asked for "max events per session, max age, or
    // unlimited" — only max-age (above) shipped in the original PR (#421).
    // This is the missing count-based bound: per session, the sweep keeps
    // only the newest N session_events rows and deletes the rest. 0 =
    // unlimited/no sweep, same convention as eventRetentionDays. Orphaned
    // rows (sessionId: null, onDelete: "set null") have no session to count
    // against and are excluded from this sweep — eventRetentionDays is the
    // only thing that bounds them.
    eventRetentionPerSession: number;
    // Issue #405 — gates ONLY the SessionStart auto-inject pointer to the
    // per-session agent guide copy (src/plugins/hooks.ts); it never gates
    // whether that per-session file itself gets written
    // (Session.bootstrapMaster() -> writeSessionAgentGuide(), always
    // unconditional — see agent-guide.ts). Default true: a few lines of
    // pointer text is cheap, and the whole point of the feature is
    // discovery. Affects all four agents, just via two different
    // mechanisms: forwarder-core.mjs's formatSessionStartOutput produces a
    // real hookSpecificOutput/injectSteps reply for claude-code, codex, and
    // agy (opencode's forwarder invocation hits its `default:` case and
    // drops the reply); opencode instead reads this same setting via
    // ctx.injectAgentGuide in hook-adapters/opencode.ts's prepareLaunch,
    // which points its `instructions` config at the per-session copy
    // (issue #437c) — the guide's full text, not a pointer sentence.
    injectAgentGuide: boolean;
    // agent-briefing follow-up to #405 — gates the SessionStart injection of
    // a PROJECT's own briefing (a marked region in its AGENTS.md/CLAUDE.md,
    // written per-session by writeSessionBriefing — see
    // project-briefing.ts), independently of injectAgentGuide above. Kept
    // as its own key rather than folded into injectAgentGuide: that key's
    // meaning is already shipped and test-asserted narrow ("gates the
    // pointer to Mullion's own per-session GUIDE copy" — see this field's
    // own test coverage), so reusing it would silently let muting Mullion's
    // doc also mute a project's operating instructions. Same
    // unconditional-write / gate-only-the-injection contract as
    // injectAgentGuide: the per-session copy is always written at spawn
    // time regardless of this setting.
    injectProjectBriefing: boolean;
    // Phase 5 (Track B, issue #193 5.3b) — hard cap on how many LIVE
    // (status "active") children a single session may have spawned via the
    // sessions.spawn_child control-socket op. Enforced in
    // createSessionRecord (services/session-lifecycle.ts), not just at the socket
    // layer, so a direct full-scope sessions.create call carrying a
    // parentSessionId is bound by the same limit. The control socket is
    // deliberately exempt from the app-wide rate limiter (see
    // plugins/security.ts's CONTROL_SOCKET_ADDR allowList) so a `mullion
    // ps` poll loop never 429s — which means there is no ambient backstop
    // on how many sessions a compromised or looping agent's inherited
    // token could spawn. This is that backstop.
    maxChildSessionsPerParent: number;
    // Phase 5 (Track B, issue #194 5.4) — whether a spawned child session's
    // dockview panel opens automatically, positioned next to its parent's
    // (frontend/src/App.tsx, frontend/src/panelUtils.ts's
    // childPanelPosition). Default false: opening a panel with no user
    // gesture behind it is the first backend-state-driven panel add in this
    // codebase (every existing such effect only setActive()s or closes an
    // already-open panel) — opt-in until proven unsurprising. The child
    // still appears in the sidebar unconditionally regardless of this flag;
    // this only gates whether its PANEL auto-opens.
    autoOpenChildPanels: boolean;
  };
  // Phase 6 Task Master (6.2/#215) — the runtime kill-switch the roadmap's
  // Security & trust row asks for, distinct from MULLION_TASK_MASTER_ENABLED
  // (an env var that needs a process restart to flip). Checked fresh by the
  // auto-claim pass every sweep, so pausing takes effect immediately.
  //
  // Follow-up (Settings UI for the safety envelope): enabled/maxConcurrent/
  // budgetMinutes/progressCommentMinutes let the dashboard override the
  // matching MULLION_TASK_* env vars at runtime, without a restart. Each of
  // the four uses a same-typed sentinel to mean "no override, use the env
  // default" — see resolveTaskMasterConfig (src/services/task-config.ts) for
  // the one place that understands them. Sentinels exist because deepMerge
  // (below) drops any patch leaf whose type differs from its DEFAULT_SETTINGS
  // counterpart, so a `number | null` field would be permanently unsettable
  // once set to null; and because PATCH /api/settings always persists the
  // *full* merged blob, so "is this key present in the stored JSON" can never
  // distinguish "user set it" from "still defaulted." `-1` for the numbers,
  // `"inherit"` for enabled (a boolean can't carry three states). Never
  // exposed to the user — the Settings UI always shows/writes an effective
  // value and offers a single "reset to environment defaults" action that
  // writes the sentinels back.
  //
  // MULLION_TASK_LABEL and MULLION_TASK_POLL_INTERVAL are deliberately NOT
  // included here — see the plan's "Cut from scope" section. The label is
  // effectively deploy identity (changing it mid-flight orphans already-
  // labeled GitHub issues with no migration path); the poll interval is a
  // rate-limit tradeoff nobody tunes from a browser, and making it live
  // would require timer-lifecycle churn (a reconfigure decorator) that isn't
  // worth it for the value.
  taskMaster: {
    autoClaimPaused: boolean;
    enabled: "inherit" | "on" | "off";
    maxConcurrent: number;
    budgetMinutes: number;
    progressCommentMinutes: number;
    // #741 — Task Master's own install-wide worker-agent default, split out
    // of settings.launchers.defaultAgent (which only drives the terminal
    // launcher) so terminal and Task Master agent defaults are independent.
    // The lowest tier of resolveAgentCommand's precedence (src/services/
    // task-agent-resolve.ts). Independent, NOT a coupled fallback.
    defaultAgent: string;
    // #741 — Task Master's install-wide review-agent default. Previously the
    // review agent had no global fallback tier at all (opt-in per
    // project/task only); this is the new lowest tier of
    // resolveReviewAgentCommand. "none"/empty means "no review agent, human
    // reviews directly" — today's behavior, unchanged.
    defaultReviewAgent: string;
    // Whether an unattended task spawn (claim/auto-claim/retry/review agent)
    // should pass skipPermissions through to the agent's own flag (e.g.
    // `--dangerously-skip-permissions`) — see getSkipPermissionFlag in
    // pty-manager.ts for the per-agent mapping. Distinct from
    // `launchers.skipPermissionsAgents` above, which only drives the
    // frontend's CommandPalette manual-launch UI and never reaches the
    // claim/retry/review spawns. Same "inherit"-sentinel shape as `enabled`
    // above — a boolean can't carry three states, and this needs the same
    // "no override, use the env default" reading MULLION_TASK_SKIP_PERMISSIONS
    // provides.
    skipPermissions: "inherit" | "on" | "off";
    // #738 follow-up — how long the review-agent spawn (task-reconciler.ts's
    // processPendingReviewSpawns) waits for CI to reach a terminal state on
    // the task's PR head before spawning anyway. Also waits on `null` (no
    // runs registered yet) and on the lookup itself throwing (a transient
    // blip, or GitHub not yet consistent on the brand-new PR) — Hermes
    // review, PR #742 — not just `"in_progress"`: the very first lookup
    // happens within moments of the push that created the head commit,
    // before GitHub has necessarily registered the Actions run or even
    // become fully consistent on the PR, so any of those is indistinguishable
    // from "this repo has no CI at all" without waiting. Plain number, NOT one of
    // the "inherit"-sentinel fields above: those exist only for fields with
    // an env-var counterpart (MULLION_TASK_*), and this one has none — a
    // repo with Actions disabled or no workflows needs `0` (spawn
    // immediately, never wait) to be reachable without env-var surgery.
    reviewCiWaitMinutes: number;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  terminal: {
    fontFamily: "Geist Mono",
    fontSize: 14,
    padding: 4,
    colorScheme: "default",
    cursorStyle: "block",
    cursorBlink: true,
    // Raised from 1000 (issue #83) — at typical line widths 1000 lines was
    // already roughly as tight a limit as the old 256KiB server-side ring
    // buffer, so the two were both starving real scrollback history. Keep
    // this roughly proportionate to SCROLLBACK_MAX_BYTES in
    // scrollback-buffer.ts if either changes.
    scrollback: 5000,
    copyOnSelect: true,
    pasteOnRightClick: false,
    clipboardWrite: true,
    reconnect: {
      enabled: true,
      maxAttempts: 8,
    },
    keyCapture: {
      ctrlR: true,
      ctrlL: true,
      ctrlK: false,
    },
    clipboardKeys: {
      ctrlV: false,
      ctrlC: false,
    },
  },
  sidebarDensity: "comfortable",
  layoutMode: "auto",
  tabletPaneCap: 2,
  projectRoots: [],
  launchers: {
    defaultShell: "zsh",
    defaultAgent: "claude",
    hiddenAgents: [],
    skipPermissionsAgents: [],
  },
  notifications: {
    channels: {
      browser: true,
      sound: false,
      push: false,
    },
    soundName: "ping",
    idleThresholdSeconds: 30,
    autoFocusOnAttention: false,
    notificationMatrix: {
      exited: { notify: false, sound: false, autoFocus: false },
      api_error: { notify: true, sound: false, autoFocus: false },
      tool_failure: { notify: true, sound: false, autoFocus: false },
      awaiting_permission: { notify: true, sound: false, autoFocus: false },
      awaiting_plan: { notify: true, sound: false, autoFocus: false },
      awaiting_review_gate: { notify: true, sound: false, autoFocus: false },
      awaiting_promote: { notify: true, sound: false, autoFocus: false },
      awaiting_elicitation: { notify: true, sound: false, autoFocus: false },
      // Was missing entirely — SessionStatus has included awaiting_question
      // since the `question` tool shipped, but this matrix (and the
      // Settings UI's own statusGroups) never got a matching entry, so no
      // channel (browser/sound/push) could ever be enabled for it. Fixed
      // here as the minimal, safe piece; Settings.tsx's own statusGroups
      // list is a separate, pre-existing gap left for a follow-up (out of
      // scope for this push-delivery PR).
      awaiting_question: { notify: true, sound: false, autoFocus: false },
      finished: { notify: false, sound: false, autoFocus: false },
      needs_input: { notify: true, sound: false, autoFocus: false },
      compacting: { notify: false, sound: false, autoFocus: false },
      subagent: { notify: false, sound: false, autoFocus: false },
      background: { notify: false, sound: false, autoFocus: false },
      working: { notify: false, sound: false, autoFocus: false },
      idle: { notify: false, sound: false, autoFocus: false },
    },
  },
  dock: {
    defaultWorktreeRefresh: false,
    autoDetectDevServer: "ask",
    dockerServices: true,
  },
  sessions: {
    namePattern: "{agent} · {project}",
    confirmBeforeKill: true,
    hideEndedSessions: false,
    showTaskSessions: false,
    reconcileIntervalSeconds: 30,
    // Raised from 600 (fix: status-clearing-semantics) — now that a mere
    // glance/tab-switch no longer clears a stale error (that was this TTL's
    // only companion release path; see write()'s genuine-input clear in
    // pty-manager.ts for the replacement), 10 minutes was short enough to
    // erase an error the user had simply stepped away from for a bit.
    staleErrorSeconds: 1800,
    // 4x staleErrorSeconds — a compaction or subagent run can legitimately
    // take much longer than an unresolved error should ever sit unnoticed.
    staleBusySeconds: 7200,
    gitAutoFetchIntervalSeconds: 300,
    eventPersistence: false,
    // 30 days — a generous but bounded default once persistence is turned
    // on at all; sanitizeSettings clamps this to [0, 3650] (0 = unlimited).
    eventRetentionDays: 30,
    // 0 = unlimited by default, matching eventRetentionDays — an operator
    // opts into a count cap explicitly rather than getting a surprise
    // truncation the first time this ships.
    eventRetentionPerSession: 0,
    injectAgentGuide: true,
    injectProjectBriefing: true,
    maxChildSessionsPerParent: 5,
    autoOpenChildPanels: false,
  },
  taskMaster: {
    autoClaimPaused: false,
    enabled: "inherit",
    maxConcurrent: -1,
    budgetMinutes: -1,
    progressCommentMinutes: -1,
    skipPermissions: "inherit",
    reviewCiWaitMinutes: 15,
    defaultAgent: "claude",
    defaultReviewAgent: "none",
  },
};

// Plain-object-aware deep merge: `patch` values win, arrays and any
// non-plain-object value (including null) replace outright rather than
// merging element-wise — a `projectRoots: []` patch should empty the list,
// not no-op against defaults.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A patch leaf only ever replaces a base leaf of the same JS type — a
// `{"terminal":{"fontSize":"huge"}}` or `{"terminal":5}` patch must not
// persist and silently corrupt a field/subtree forever (getStoredSettings
// re-merges the stored blob over DEFAULT_SETTINGS with this same function on
// every read, so a wrong-shape value, once written, never self-heals).
// Reached only when at least one side isn't a plain object (deepMerge
// recurses instead when both are), so an object-vs-anything-else mismatch is
// always rejected here.
function sameType(base: unknown, value: unknown): boolean {
  if (isPlainObject(base) || isPlainObject(value)) return false;
  if (Array.isArray(base)) return Array.isArray(value);
  if (Array.isArray(value)) return false;
  if (base === null || value === null) return false;
  return typeof base === typeof value;
}

// Iterates `base`'s own keys rather than the patch's: the property name
// written to `result` must never be sourced from request.body (an
// attacker-controlled PATCH /api/settings payload), since JSON.parse
// happily builds "__proto__" as an ordinary own-enumerable key and a
// naive `for (const key of Object.keys(patch))` would let that key reach
// a bracket-notation write — a prototype-pollution vector. Keys present in
// the patch but absent from `base` (i.e. not part of the known settings
// shape) are silently dropped rather than merged in.
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const baseObj = base as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseObj };
  for (const key of Object.keys(baseObj)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const baseValue = baseObj[key];
    const value = patch[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? deepMerge(baseValue, value)
        : sameType(baseValue, value)
          ? value
          : baseValue;
  }
  return result as T;
}

function safeNumber(
  value: unknown,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

// Like safeNumber, but for a field with a reserved "inherit from env"
// sentinel (Phase 6 Task Master follow-up) that must never be treated as
// part of the real numeric range — a single [min, max] clamp can't express
// "-1 is valid AND 0 is not" (maxConcurrent) independently of "-1 is valid
// AND 0 also is" (budgetMinutes/progressCommentMinutes). The sentinel is
// checked first and passed straight through.
//
// A merely-out-of-range-HIGH value (e.g. maxConcurrent: 25 against a max of
// 20) clamps to the nearest bound rather than falling back to the sentinel
// (Hermes review, PR #480) — a value that big clearly signals "I wanted a
// large number," and clamping honors that intent instead of silently
// discarding it to "inherit," which would leave the UI showing 25 while the
// server enforces a completely different env-derived number. Only a
// genuinely DANGEROUS low value repairs to the sentinel instead of clamping
// up to `min` — dangerousBelow lets maxConcurrent treat "0 or negative" as
// dangerous (env.ts's own documented reasoning: a 0 cap 429s every claim
// forever, so silently clamping a stray 0 up to 1 would mask what was
// probably a bug/cleared-field artifact rather than a deliberate "small cap"
// request) while budgetMinutes/progressCommentMinutes (whose min is already
// 0, so there's no meaningful "dangerous zero" to distinguish) just clamp.
function safeSentinelNumber(
  value: unknown,
  {
    sentinel,
    min,
    max,
    dangerousBelow,
  }: { sentinel: number; min: number; max: number; dangerousBelow?: number },
): number {
  if (value === sentinel) return sentinel;
  if (typeof value !== "number" || !Number.isFinite(value)) return sentinel;
  if (dangerousBelow !== undefined && value < dangerousBelow) return sentinel;
  return Math.min(max, Math.max(min, value));
}

// Clamps/repairs numeric fields to a sane range, falling back to the
// default on anything non-finite or out of bounds. The type guard in
// deepMerge above only proves a patched leaf is *a* number, not a *sane*
// one — a 0 or negative `reconcileIntervalSeconds` feeds straight into
// `setInterval` (see plugins/pty.ts's armReconcileTimer). Ranges mirror the
// min/max the Settings UI's own sliders/number fields already enforce
// client-side (Settings.tsx), so the server never rejects a value the UI
// allows.
export function sanitizeSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    // Same explicit-membership-check shape as taskMaster.enabled/
    // skipPermissions below — deepMerge only proves these are *a* string/
    // number, not a value the frontend's layout-tier switch actually
    // branches on; an unrecognized value falls back rather than reaching
    // resolveLayoutTier/tabletPositioning as a silent no-op.
    layoutMode:
      settings.layoutMode === "auto" ||
      settings.layoutMode === "phone" ||
      settings.layoutMode === "tablet" ||
      settings.layoutMode === "desktop"
        ? settings.layoutMode
        : DEFAULT_SETTINGS.layoutMode,
    tabletPaneCap: settings.tabletPaneCap === 3 ? 3 : 2,
    terminal: {
      ...settings.terminal,
      fontSize: safeNumber(settings.terminal.fontSize, {
        min: 10,
        max: 20,
        fallback: DEFAULT_SETTINGS.terminal.fontSize,
      }),
      padding: safeNumber(settings.terminal.padding, {
        min: 0,
        max: 16,
        fallback: DEFAULT_SETTINGS.terminal.padding,
      }),
      scrollback: safeNumber(settings.terminal.scrollback, {
        min: 100,
        max: 100000,
        fallback: DEFAULT_SETTINGS.terminal.scrollback,
      }),
      reconnect: {
        ...settings.terminal.reconnect,
        maxAttempts: safeNumber(settings.terminal.reconnect.maxAttempts, {
          min: 1,
          max: 20,
          fallback: DEFAULT_SETTINGS.terminal.reconnect.maxAttempts,
        }),
      },
    },
    notifications: {
      ...settings.notifications,
      idleThresholdSeconds: safeNumber(settings.notifications.idleThresholdSeconds, {
        min: 5,
        max: 120,
        fallback: DEFAULT_SETTINGS.notifications.idleThresholdSeconds,
      }),
    },
    sessions: {
      ...settings.sessions,
      reconcileIntervalSeconds: safeNumber(settings.sessions.reconcileIntervalSeconds, {
        min: 5,
        max: 3600,
        fallback: DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds,
      }),
      staleErrorSeconds: safeNumber(settings.sessions.staleErrorSeconds, {
        min: 30,
        max: 86400,
        fallback: DEFAULT_SETTINGS.sessions.staleErrorSeconds,
      }),
      staleBusySeconds: safeNumber(settings.sessions.staleBusySeconds, {
        min: 30,
        max: 86400,
        fallback: DEFAULT_SETTINGS.sessions.staleBusySeconds,
      }),
      gitAutoFetchIntervalSeconds: safeNumber(settings.sessions.gitAutoFetchIntervalSeconds, {
        min: 0,
        max: 3600,
        fallback: DEFAULT_SETTINGS.sessions.gitAutoFetchIntervalSeconds,
      }),
      // 0 disables the retention sweep entirely (unlimited history) — same
      // "0 is a valid, meaningful floor" shape as gitAutoFetchIntervalSeconds
      // just above. An unvalidated value here would otherwise reach a SQL
      // DELETE ... WHERE ts < ? threshold computed straight from it.
      eventRetentionDays: safeNumber(settings.sessions.eventRetentionDays, {
        min: 0,
        max: 3650,
        fallback: DEFAULT_SETTINGS.sessions.eventRetentionDays,
      }),
      // Same "0 disables, unvalidated number otherwise reaches SQL" reasoning
      // as eventRetentionDays just above — this one reaches
      // sweepSessionEventCap's own OFFSET, not a ts cutoff (see that
      // function's own comment on why an id-cutoff lookup, not an id list,
      // is what keeps 100_000 cheap regardless of SQLite's bind-parameter
      // limit).
      //
      // Hermes review, PR #563 (round 4) — deliberately NOT safeNumber, and
      // not the same choice as eventRetentionDays just above: this field's
      // fallback (0) IS "unlimited", so falling back on an out-of-range-HIGH
      // value (e.g. a typo'd 150_000) doesn't just land on a different
      // bounded number the way eventRetentionDays' fallback-to-30 does —
      // it silently disables the cap entirely, the opposite of what a
      // large-but-invalid value signals the operator wanted. Uses
      // safeSentinelNumber's clamp-to-bound behavior instead (the same
      // "a big number honors intent" reasoning maxConcurrent's own comment
      // gives), with `sentinel: 0` doing double duty as both "0 passes
      // through unclamped" and "non-finite/negative falls back to 0" —
      // exactly `safeNumber`'s old behavior for those two cases, just not
      // for out-of-range-high anymore.
      eventRetentionPerSession: safeSentinelNumber(settings.sessions.eventRetentionPerSession, {
        sentinel: 0,
        min: 0,
        max: 100_000,
      }),
      // A cap of 0 would make sessions.spawn_child permanently reject every
      // request rather than disable the feature (there's no "0 disables"
      // reading for a security backstop, unlike the sweep intervals above)
      // — floor at 1.
      maxChildSessionsPerParent: safeNumber(settings.sessions.maxChildSessionsPerParent, {
        min: 1,
        max: 50,
        fallback: DEFAULT_SETTINGS.sessions.maxChildSessionsPerParent,
      }),
    },
    taskMaster: {
      ...settings.taskMaster,
      enabled:
        settings.taskMaster.enabled === "inherit" ||
        settings.taskMaster.enabled === "on" ||
        settings.taskMaster.enabled === "off"
          ? settings.taskMaster.enabled
          : DEFAULT_SETTINGS.taskMaster.enabled,
      // -1 is the "inherit from MULLION_TASK_MAX_CONCURRENT" sentinel and
      // must be excluded from the real range: unlike budget/throttle below,
      // 0 has no "unlimited" reading here (env.ts's own minimum: 1 — a 0 cap
      // makes every claim 429 forever), so 0-or-below repairs to the
      // sentinel rather than clamping up to 1 (see safeSentinelNumber's own
      // doc comment for why that distinction matters). An out-of-range-HIGH
      // value (e.g. 25) clamps to 20 instead.
      maxConcurrent: safeSentinelNumber(settings.taskMaster.maxConcurrent, {
        sentinel: -1,
        min: 1,
        max: 20,
        dangerousBelow: 1,
      }),
      // -1 = inherit; 0 is a legitimate "unlimited" value here (no dangerous
      // floor to guard, unlike maxConcurrent) and must survive untouched.
      budgetMinutes: safeSentinelNumber(settings.taskMaster.budgetMinutes, {
        sentinel: -1,
        min: 0,
        max: 10080,
      }),
      // -1 = inherit; 0 is a legitimate "no throttle" value here (no
      // dangerous floor to guard, unlike maxConcurrent) and must survive
      // untouched.
      progressCommentMinutes: safeSentinelNumber(settings.taskMaster.progressCommentMinutes, {
        sentinel: -1,
        min: 0,
        max: 1440,
      }),
      skipPermissions:
        settings.taskMaster.skipPermissions === "inherit" ||
        settings.taskMaster.skipPermissions === "on" ||
        settings.taskMaster.skipPermissions === "off"
          ? settings.taskMaster.skipPermissions
          : DEFAULT_SETTINGS.taskMaster.skipPermissions,
      // No sentinel — 0 is a legitimate "never wait" value (same "0 is a
      // real floor" shape as budgetMinutes/progressCommentMinutes' own 0,
      // just without an "inherit" case to also preserve).
      reviewCiWaitMinutes: safeNumber(settings.taskMaster.reviewCiWaitMinutes, {
        min: 0,
        max: 240,
        fallback: DEFAULT_SETTINGS.taskMaster.reviewCiWaitMinutes,
      }),
    },
  };
}

/** Deep-merges a possibly-partial/older stored blob over the current defaults. */
export function mergeSettings(stored: unknown): AppSettings {
  return sanitizeSettings(deepMerge(DEFAULT_SETTINGS, stored));
}

// Singleton row id — see db/schema.ts's `settings` table doc comment.
export const SETTINGS_ROW_ID = 1;

// Shared "read the settings row and merge over defaults" used by every
// consumer (the settings route itself, project-roots resolution, the
// reconcile-interval boot read, and per-request idle-threshold lookups).
export function getStoredSettings(db: ReturnType<typeof getDb>): AppSettings {
  const [row] = db.select().from(settingsTable).where(eq(settingsTable.id, SETTINGS_ROW_ID)).all();
  if (!row) return DEFAULT_SETTINGS;
  try {
    return mergeSettings(JSON.parse(row.data));
  } catch {
    return DEFAULT_SETTINGS;
  }
}
