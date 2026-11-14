import { sanitizeCacheDirIds } from "./cache-storage.js";
import { clampGitIdentityField } from "./git-identity.js";
import { DEVICE_EMULATOR_GPU_PATTERN } from "./device-defaults.js";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { settings as settingsTable } from "../db/schema.js";
import type { getDb } from "../db/client.js";
// Theme/CursorStyle/SidebarDensity/SoundName (AppSettings's leaf unions)
// now physically live in src/shared/types.ts (hand-mirrored 1:1 on the
// frontend — see frontend/src/api.ts's own re-export). Re-exported below so
// every existing backend importer of this module keeps working unchanged.
// AppSettings itself stays declared here — see shared/types.ts's own doc
// comment for why (its notificationMatrix field is a real, deliberate
// backend/frontend type divergence, not cosmetic drift).
import type { Theme, CursorStyle, SidebarDensity, SoundName, LayoutMode } from "../shared/types.js";
import {
  buildWorkflowConventionsText,
  WORKFLOW_CONVENTION_QUESTIONS,
} from "./workflow-conventions.js";
import {
  resolveGitHubPoll,
  resolveHeartbeatSeconds,
  resolveLogLevel,
  toActivityIntervals,
} from "./runtime-config.js";

export type { Theme, CursorStyle, SidebarDensity, SoundName, LayoutMode };

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

import { LOG_LEVELS, type AppSettings, type LogLevel } from "./settings-types.js";
export { LOG_LEVELS, type AppSettings, type LogLevel };

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
    voice: {
      enabled: true,
      hotkeyEnabled: true,
      lang: "",
      hotkey: "Ctrl+Shift+Space",
    },
  },
  sidebarDensity: "comfortable",
  layoutMode: "auto",
  balancePanesOnDrop: true,
  projectRoots: [],
  autoDetectHostCheckouts: false,
  externalReadRoots: ["~/.claude/plans", "~/.minimax/v2/sessions"],
  diskCleanup: { cacheDirs: [] },
  launchers: {
    defaultShell: "zsh",
    defaultAgent: "claude",
    hiddenAgents: [],
    skipPermissionsAgents: [],
  },
  github: {
    pollActiveSeconds: -1,
    pollQuietSeconds: -1,
    pollStaleThresholdSeconds: -1,
  },
  hosts: {
    heartbeatSeconds: -1,
  },
  reviewRelay: {
    provider: "none",
    apiUrl: "",
    model: "hermes-agent",
    modelProvider: "",
    promptRepo: "",
    promptPath: "hermes-review-prompt.md",
    triagePromptRepo: "",
    triagePromptPath: "hermes-triage-prompt.md",
    cooldownMinutes: 10,
    reviewerBotLogin: "s3ntin3l8-hermes[bot]",
    ledgerName: "Hermes review",
    reReviewAfterApproval: "refuse",
    taskMasterReviewer: false,
  },
  runway: {
    apiUrl: "",
    // The default maps the providers whose quota IS the CLI's own quota.
    // Runway's provider ids are PROVIDER names and Mullion's agents are CLI
    // names, so the correspondence is configured, not derived.
    //
    // Verified (issue #1841) against the `latest_usage` table of a live
    // Runway on 2026-10-26, read-only and without the admin key. That
    // install reported: anthropic, anthropic_console, antigravity, chatgpt,
    // deepseek, gemini, github, kimi_coding, minimax, ollama, opencode,
    // openrouter, xai. kimi_api, kimi_k2 and zai had no card there, so they
    // are known only from the collectors' source. One install's snapshot,
    // not the full set.
    //
    // Mapped, and why each one is the CLI's own quota:
    //   anthropic   -> claude    the Claude plan's session/weekly windows.
    //   chatgpt     -> codex     Runway's chatgpt collector reads
    //                            chatgpt.com/backend-api/wham/usage, which is
    //                            Codex's own rate-limit endpoint.
    //   antigravity -> agy       read with agy's OAuth token. agy is
    //                            quarantined when ANY of its pools is
    //                            exhausted, even if another still has room.
    //   minimax     -> mcode     the MiniMax Code plan (coding_plan/remains).
    //   opencode    -> opencode/opencode-go
    //                            the OpenCode Go usage API. opencode is a
    //                            multi-provider CLI, so the target names the
    //                            opencode provider: a task whose model is
    //                            `opencode-go/…` is held when Go is out. A task
    //                            with NO resolved model (the stock install)
    //                            could run on any provider, so it is held when
    //                            any mapped opencode provider is out. A
    //                            provider's quota
    //                            that opencode spends too (xai, openrouter,
    //                            minimax-coding-plan, …) is added per install
    //                            as e.g. `xai: "opencode/xai"`, or a list
    //                            (`minimax: ["mcode", "opencode/minimax-coding-plan"]`).
    //                            A bare `opencode` target still holds every
    //                            opencode task.
    //
    // Left unmapped on purpose: gemini (stale cards, API-strategy collector),
    // anthropic_console, deepseek, github, kimi_*, ollama, openrouter, xai,
    // zai — none is a quota a Mullion agent CLI spends by itself. An
    // operator who disagrees adds the entry in Settings; the Runway section
    // lists the providers Runway reports that have no entry.
    providerMap: {
      anthropic: "claude",
      opencode: "opencode/opencode-go",
      chatgpt: "codex",
      antigravity: "agy",
      minimax: "mcode",
    },
    pollSeconds: 60,
  },
  browser: {
    enabled: "inherit",
    framerate: -1,
    maxInstances: -1,
  },
  devices: {
    discoveryEnabled: "inherit",
    emulatorHeadless: "inherit",
    emulatorGpu: null,
  },
  server: {
    logLevel: "inherit",
  },
  opencode: {
    implementerModel: null,
    reviewerModel: null,
    defaultSmallModel: null,
  },
  claudeCode: { defaultModel: null, reviewerModel: null, smallModel: null },
  codex: { defaultModel: null, reviewerModel: null },
  agy: { defaultModel: null, reviewerModel: null },
  mcode: { defaultModel: null, reviewerModel: null },
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
      // Issue #1727 — "suspended" (the host did not answer). Off by
      // default, and deliberately: a laptop that fell asleep is not an
      // event worth a notification. The frontend's own mirror of this
      // matrix is exhaustiveness-checked, so it HAD to grow the entry —
      // this side is typed `Record<string, ...>`, so it would have drifted
      // silently without this line (the same shape as the
      // awaiting_question gap above).
      suspended: { notify: false, sound: false, autoFocus: false },
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
    autoAttachDockerLogs: false,
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
    injectMullionBundle: true,
    // Empty by design — a fresh install has no opinion yet; Settings ->
    // Sessions surfaces the wizard specifically so nobody has to hand-type
    // this from a blank starter template. See this field's own doc comment
    // above for why "" is itself the gate, not just an uninteresting
    // default.
    workflowConventionsText: "",
    // Every CURRENT question id mapped to "", not `{}` — deepMerge (below
    // in this file) only ever touches a patch key that already exists on
    // `base` (deliberately: it iterates base's own keys, never the
    // patch's, so a PATCH body can't smuggle in an arbitrary key like
    // "__proto__" — see deepMerge's own doc comment). A bare `{}` default
    // would mean NO question id pre-exists on `base`, so a wizard's own
    // PATCH — which sends real answers for ids that were never in the
    // stored blob before — would silently merge to nothing. Derived from
    // WORKFLOW_CONVENTION_QUESTIONS, never hand-copied, so an added/removed
    // question (this file adding `worktrees`, say) changes this
    // automatically — and getStoredSettings' own re-merge-over-defaults on
    // every read means an older stored row missing a newer question's key
    // self-heals to "" instead of staying permanently absent. `""` is the
    // same "not yet answered" sentinel buildWorkflowConventionsText already
    // treats as skip-worthy (no option has id "").
    workflowConventionAnswers: Object.fromEntries(
      WORKFLOW_CONVENTION_QUESTIONS.map((q) => [q.id, ""]),
    ),
    workflowConventionsAppliedText: "",
    maxChildSessionsPerParent: 5,
    autoOpenChildPanels: false,
    gitIdentity: { name: "", email: "" },
  },
  taskMaster: {
    autoClaimPaused: false,
    enabled: "inherit",
    maxConcurrent: -1,
    budgetMinutes: -1,
    progressCommentMinutes: -1,
    rateLimitGraceMinutes: -1,
    skipPermissions: "inherit",
    trustedLogins: [],
    reviewCiWaitMinutes: 15,
    // The review loop now ends on an approval, not on exhausting a budget, so
    // the cap is only a backstop against a loop that never converges.
    maxAutoReturnRounds: 10,
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
//
// `defaultValue` is that field's value in the STATIC DEFAULT_SETTINGS tree
// (threaded through deepMerge's recursion below, distinct from `base` which
// is the current, possibly-already-patched value at that key) — the only
// reliable signal for "is this field declared nullable," since `base` drifts
// away from null the moment the field is first set.
//
// Regression: `opencode.implementerModel`/`reviewerModel`/`defaultSmallModel`
// (issue #957/#958) are this schema's first fields whose default is `null`.
// Before this nullability check existed, such a field could never transition
// null -> a value (`sameType(null, "x")` was always false) NOR back from a
// value -> null (`sameType("x", null)` was also always false) — Settings ->
// Models could show a selection in the dropdown but it silently never
// persisted (caught by Settings.models.test.tsx). Every other existing
// field's default is non-null, so this branch is unreached for them and
// their behavior is unchanged.
//
// Restricted to `string` (not "any scalar") deliberately: `defaultValue`
// only proves the field is NULLABLE, not what its non-null type is — there's
// no runtime signal for that beyond the default itself. Every field that
// takes this branch today (all three opencode.* fields) is `string | null`,
// so this is exact, not a guess. A code-review pass on the first version of
// this fix caught that accepting number/boolean too would let a
// wrong-typed PATCH (e.g. `{opencode:{implementerModel: 42}}`) silently
// corrupt the field — sanitizeSettings doesn't touch settings.opencode, so
// nothing would repair it. If a genuinely nullable number/boolean field is
// ever added to this schema, this check needs revisiting (e.g. threading an
// explicit type tag rather than inferring from `defaultValue`).
function sameType(base: unknown, value: unknown, defaultValue: unknown): boolean {
  if (isPlainObject(base) || isPlainObject(value)) return false;
  if (Array.isArray(base)) return Array.isArray(value);
  if (Array.isArray(value)) return false;
  if (defaultValue === null) {
    return value === null || typeof value === "string";
  }
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
//
// `defaults` defaults to `base` itself when omitted — every existing
// internal recursive call and the `deepMerge(DEFAULT_SETTINGS, stored)` call
// in getStoredSettings below already satisfy `base === defaults` at the top
// level, so this default is not a behavior change for them. A caller merging
// a patch onto a value that has DRIFTED from the defaults (route handlers
// merging a PATCH body onto the currently-stored settings) must pass
// DEFAULT_SETTINGS explicitly — see routes/settings.ts's call site.
export function deepMerge<T>(base: T, patch: unknown, defaults: T = base): T {
  if (!isPlainObject(patch)) return base;
  const baseObj = base as Record<string, unknown>;
  const defaultsObj = defaults as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseObj };
  for (const key of Object.keys(baseObj)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const baseValue = baseObj[key];
    const value = patch[key];
    const defaultValue = defaultsObj[key];
    result[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? deepMerge(baseValue, value, isPlainObject(defaultValue) ? defaultValue : baseValue)
        : sameType(baseValue, value, defaultValue)
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

// A `-gpu` mode is one token, the same bound as env.ts's
// DEVICE_EMULATOR_GPU pattern (DEVICE_EMULATOR_GPU_PATTERN). `null` (and
// anything that isn't) means "inherit the env default" — never forward a
// blank or a multi-word string to the emulator.
const EMULATOR_GPU_TOKEN = new RegExp(DEVICE_EMULATOR_GPU_PATTERN);

function sanitizeEmulatorGpu(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  // "inherit" is the UI sentinel for null, not a -gpu mode. A client that
  // PATCHes the dropdown's value literally would otherwise pass the token
  // check and launch with `-gpu inherit`.
  if (trimmed.toLowerCase() === "inherit") return null;
  return EMULATOR_GPU_TOKEN.test(trimmed) ? trimmed : null;
}

// Clamps/repairs numeric fields to a sane range, falling back to the
// default on anything non-finite or out of bounds. The type guard in
// deepMerge above only proves a patched leaf is *a* number, not a *sane*
// one — a 0 or negative `reconcileIntervalSeconds` feeds straight into
// `setInterval` (see plugins/pty.ts's armReconcileTimer). Ranges mirror the
// min/max the Settings UI's own sliders/number fields already enforce
// client-side (Settings.tsx), so the server never rejects a value the UI
// allows.
/** Keep only entries that are an absolute or `~/`-prefixed directory path and
 * not the filesystem root / home dir themselves (too broad to be a "narrow
 * plan folder" — they'd expose ~/.ssh and friends). Trailing slashes are
 * dropped and duplicates collapsed. */
export function sanitizeExternalReadRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  const out: string[] = [];
  for (const raw of roots) {
    if (typeof raw !== "string" || raw.includes("\0")) continue;
    // Not a /\/+$/ regex: that backtracks quadratically on a long run of "/".
    let trimmed = raw.trim();
    while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
    if (trimmed === "" || trimmed === "~") continue;
    if (!trimmed.startsWith("/") && !trimmed.startsWith("~/")) continue;
    if (trimmed.split("/").includes("..")) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function sanitizeSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    // Same explicit-membership-check shape as taskMaster.enabled/
    // skipPermissions below — deepMerge only proves these are *a* string/
    // number, not a value the frontend's layout-tier switch actually
    // branches on; an unrecognized value falls back rather than reaching
    // resolveLayoutTier as a silent no-op.
    layoutMode:
      settings.layoutMode === "auto" ||
      settings.layoutMode === "phone" ||
      settings.layoutMode === "tablet" ||
      settings.layoutMode === "desktop"
        ? settings.layoutMode
        : DEFAULT_SETTINGS.layoutMode,
    externalReadRoots: sanitizeExternalReadRoots(settings.externalReadRoots),
    // A patch can only ever replace the array wholesale; drop anything that
    // isn't an allowlisted cache id so it can't be persisted, let alone acted on.
    diskCleanup: { cacheDirs: sanitizeCacheDirIds(settings.diskCleanup.cacheDirs) },
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
      // Each half is kept as typed (bounded) so the Settings UI can be
      // filled in one field at a time; resolveGitIdentity (git-identity.ts)
      // only uses the pair once BOTH halves are usable.
      gitIdentity: {
        name: clampGitIdentityField(settings.sessions.gitIdentity?.name),
        email: clampGitIdentityField(settings.sessions.gitIdentity?.email),
      },
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
    // -1 = inherit from the env var. The floors keep a stray small value
    // from hammering the GitHub API; a value below the floor clamps up.
    github: {
      pollActiveSeconds: safeSentinelNumber(settings.github.pollActiveSeconds, {
        sentinel: -1,
        min: 5,
        max: 3600,
      }),
      pollQuietSeconds: safeSentinelNumber(settings.github.pollQuietSeconds, {
        sentinel: -1,
        min: 5,
        max: 3600,
      }),
      pollStaleThresholdSeconds: safeSentinelNumber(settings.github.pollStaleThresholdSeconds, {
        sentinel: -1,
        min: 30,
        max: 86400,
      }),
    },
    // -1 = inherit; 0 is a real "heartbeat off" value, matching the env var.
    hosts: {
      heartbeatSeconds: safeSentinelNumber(settings.hosts.heartbeatSeconds, {
        sentinel: -1,
        min: 0,
        max: 3600,
      }),
    },
    browser: {
      enabled:
        settings.browser.enabled === "on" || settings.browser.enabled === "off"
          ? settings.browser.enabled
          : DEFAULT_SETTINGS.browser.enabled,
      framerate: safeSentinelNumber(settings.browser.framerate, {
        sentinel: -1,
        min: 1,
        max: 30,
      }),
      maxInstances: safeSentinelNumber(settings.browser.maxInstances, {
        sentinel: -1,
        min: 1,
        max: 32,
      }),
    },
    devices: {
      discoveryEnabled:
        settings.devices.discoveryEnabled === "on" || settings.devices.discoveryEnabled === "off"
          ? settings.devices.discoveryEnabled
          : DEFAULT_SETTINGS.devices.discoveryEnabled,
      emulatorHeadless:
        settings.devices.emulatorHeadless === "on" || settings.devices.emulatorHeadless === "off"
          ? settings.devices.emulatorHeadless
          : DEFAULT_SETTINGS.devices.emulatorHeadless,
      // null inherits DEVICE_EMULATOR_GPU. Anything that isn't one token
      // (a space, empty, or a sentence) is not a `-gpu` value — drop it
      // back to inherit rather than forwarding it to the emulator.
      emulatorGpu: sanitizeEmulatorGpu(settings.devices.emulatorGpu),
    },
    server: {
      logLevel:
        settings.server.logLevel === "inherit" ||
        (LOG_LEVELS as readonly string[]).includes(settings.server.logLevel)
          ? settings.server.logLevel
          : DEFAULT_SETTINGS.server.logLevel,
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
      // -1 = inherit; 0 is a legitimate "fail immediately on rate_limit" value
      // (the explicit opt-out, same "0 is a real floor" shape as
      // budgetMinutes/progressCommentMinutes above — there's no "unlimited"
      // reading, just "off") and must survive untouched.
      rateLimitGraceMinutes: safeSentinelNumber(settings.taskMaster.rateLimitGraceMinutes, {
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
      trustedLogins: Array.isArray(settings.taskMaster.trustedLogins)
        ? settings.taskMaster.trustedLogins.filter(
            (l): l is string => typeof l === "string" && l.trim() !== "",
          )
        : DEFAULT_SETTINGS.taskMaster.trustedLogins,
      // No sentinel — 0 is a legitimate "never wait" value (same "0 is a
      // real floor" shape as budgetMinutes/progressCommentMinutes' own 0,
      // just without an "inherit" case to also preserve).
      reviewCiWaitMinutes: safeNumber(settings.taskMaster.reviewCiWaitMinutes, {
        min: 0,
        max: 240,
        fallback: DEFAULT_SETTINGS.taskMaster.reviewCiWaitMinutes,
      }),
      // 0 is a real value (unlimited), so it must survive untouched.
      maxAutoReturnRounds: safeNumber(settings.taskMaster.maxAutoReturnRounds, {
        min: 0,
        max: 100,
        fallback: DEFAULT_SETTINGS.taskMaster.maxAutoReturnRounds,
      }),
    },
    reviewRelay: {
      provider: settings.reviewRelay.provider === "hermes" ? "hermes" : "none",
      apiUrl: safeString(settings.reviewRelay.apiUrl, DEFAULT_SETTINGS.reviewRelay.apiUrl),
      model: safeString(settings.reviewRelay.model, DEFAULT_SETTINGS.reviewRelay.model),
      modelProvider: safeString(
        settings.reviewRelay.modelProvider,
        DEFAULT_SETTINGS.reviewRelay.modelProvider,
      ),
      promptRepo: safeString(
        settings.reviewRelay.promptRepo,
        DEFAULT_SETTINGS.reviewRelay.promptRepo,
      ),
      promptPath: safeString(
        settings.reviewRelay.promptPath,
        DEFAULT_SETTINGS.reviewRelay.promptPath,
      ),
      triagePromptRepo: safeString(
        settings.reviewRelay.triagePromptRepo,
        DEFAULT_SETTINGS.reviewRelay.triagePromptRepo,
      ),
      triagePromptPath: safeString(
        settings.reviewRelay.triagePromptPath,
        DEFAULT_SETTINGS.reviewRelay.triagePromptPath,
      ),
      cooldownMinutes: safeNumber(settings.reviewRelay.cooldownMinutes, {
        min: 0,
        max: 1440,
        fallback: DEFAULT_SETTINGS.reviewRelay.cooldownMinutes,
      }),
      reviewerBotLogin: normalizeBotLogin(
        safeString(
          settings.reviewRelay.reviewerBotLogin,
          DEFAULT_SETTINGS.reviewRelay.reviewerBotLogin,
        ),
      ),
      // A check run's name is at most 100 characters; empty is meaningful (ledger off).
      ledgerName: safeString(
        settings.reviewRelay.ledgerName,
        DEFAULT_SETTINGS.reviewRelay.ledgerName,
      )
        .trim()
        .slice(0, 100),
      reReviewAfterApproval:
        settings.reviewRelay.reReviewAfterApproval === "allow" ? "allow" : "refuse",
      // Only a literal `true` enables it — the object is rebuilt field by
      // field above, so a field not named here would be dropped on every read.
      taskMasterReviewer: settings.reviewRelay.taskMasterReviewer === true,
    },
    runway: {
      apiUrl: safeString(settings.runway.apiUrl, DEFAULT_SETTINGS.runway.apiUrl),
      // The provider map is a plain string->string table, so a value that is
      // not a string cannot be persisted. An entry whose AGENT is not one
      // Mullion knows is kept (the operator may name an agent Mullion has
      // not shipped yet) but it can never match a resolved agent, so it is
      // inert rather than dangerous.
      providerMap: sanitizeProviderMap(
        settings.runway.providerMap,
        DEFAULT_SETTINGS.runway.providerMap,
      ),
      pollSeconds: safeNumber(settings.runway.pollSeconds, {
        min: 0,
        max: 3600,
        fallback: DEFAULT_SETTINGS.runway.pollSeconds,
      }),
    },
  };
}

/**
 * Issue #29 — the Runway provider-id → Mullion-agent map.
 *
 * The key is a plain string and the value a target string or a list of
 * them. An empty provider id or target is dropped: an empty key could match
 * every provider, and an empty target could match nothing.
 *
 * The object is built with a NULL PROTOTYPE and `Object.defineProperty`,
 * not `out[key] = value`. The provider id is operator-supplied, so a plain
 * assignment would hand a key of `__proto__` to the prototype setter. With
 * the value gated to a string that form was INERT — the `__proto__` setter
 * ignores a non-object value — but it would become a real
 * prototype-pollution hole the moment a non-string value were allowed
 * here, and it is the reason CodeQL flags the naive form. With no
 * prototype to pollute and no `[[Set]]` on the way in, a `__proto__` key
 * is just an ordinary own property that nothing looks up.
 *
 * CodeQL's `js/remote-property-injection` still fires on the
 * user-provided property NAME (it does not model the null-prototype
 * containment), so the alert is dismissed in GHAS with this containment
 * argument — the same pattern dock-config.ts's `isSymlinkPath` uses for
 * `js/path-injection`, and for the same reason: no step of this repo's
 * CodeQL workflow reads a SARIF suppression annotation (the analyze step
 * itself lives in the shared workflow this repo calls), so a
 * `// codeql[...]` comment here would not silence anything.
 */
function sanitizeProviderMap(
  value: unknown,
  fallback: Record<string, string | string[]>,
): Record<string, string | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
  const out: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;
  for (const [provider, targets] of Object.entries(value as Record<string, unknown>)) {
    if (typeof provider !== "string" || provider.trim() === "") continue;
    // A value is one target or a list of them (issue #2054); anything else
    // in a list is dropped, and a list left empty drops the entry.
    let clean: string | string[] | null = null;
    if (typeof targets === "string") {
      if (targets.trim() !== "") clean = targets.trim();
    } else if (Array.isArray(targets)) {
      const list = [
        ...new Set(
          targets
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim())
            .filter((t) => t !== ""),
        ),
      ];
      if (list.length > 0) clean = list;
    }
    if (clean === null) continue;
    Object.defineProperty(out, provider.trim(), {
      value: clean,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

// deepMerge only proves a field is *a* string; trim it so a stray space from
// the settings form can't turn "http://host:8643 " into an invalid URL.
function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/**
 * The reviewer's GitHub login, in the form a bot's reviews carry.
 *
 * A bot's review is authored by "<app-slug>[bot]", and the shared workflow
 * derives the same login from its `mention-trigger` input — so a value
 * without the suffix would match nothing, and the base rule it guards (only
 * the reviewer's own landed review sets the delta base) would quietly stop
 * applying. Normalising here keeps the two entry points in agreement.
 */
function normalizeBotLogin(login: string): string {
  if (login === "") return "";
  return login.endsWith("[bot]") ? login : `${login}[bot]`;
}

/**
 * `runway.providerMap` is the one settings field whose KEYS are data
 * (operator-chosen Runway provider ids), not schema. `deepMerge` only
 * carries keys the base object already has, so it would clamp the map to
 * the default's keys: an added mapping would vanish on load and a removed
 * default would come back. When the raw source carries a map, it replaces
 * the merged one wholesale and `sanitizeSettings` then cleans it (null
 * prototype, no empty entries). That is the contract of `PATCH
 * /api/settings` too, not just of the settings form: a patch carrying
 * `runway.providerMap` sets the WHOLE map, so a caller changing one entry
 * sends the others with it (that is the only way an entry can be removed).
 * A source without a map leaves the merged value alone.
 */
function withRawProviderMap(merged: AppSettings, raw: unknown): AppSettings {
  const map = (raw as { runway?: { providerMap?: unknown } } | null)?.runway?.providerMap;
  if (!isPlainObject(map)) return merged;
  return {
    ...merged,
    runway: { ...merged.runway, providerMap: map as Record<string, string | string[]> },
  };
}

/** Deep-merges a possibly-partial/older stored blob over the current defaults. */
export function mergeSettings(stored: unknown): AppSettings {
  const merged = sanitizeSettings(withRawProviderMap(deepMerge(DEFAULT_SETTINGS, stored), stored));
  // Relay settings saved before `provider` existed were Hermes-only: keep
  // them working instead of silently switching the reviewer off.
  const legacy = (stored as { reviewRelay?: { provider?: unknown; apiUrl?: unknown } } | null)
    ?.reviewRelay;
  if (
    legacy &&
    legacy.provider === undefined &&
    typeof legacy.apiUrl === "string" &&
    legacy.apiUrl.trim()
  ) {
    merged.reviewRelay.provider = "hermes";
  }
  return merged;
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
    return refreshGeneratedConventions(mergeSettings(JSON.parse(row.data)));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function withoutAppliedSnapshot(patch: Record<string, unknown>): Record<string, unknown> {
  const sessions = patch.sessions;
  if (typeof sessions !== "object" || sessions === null) return patch;
  const { workflowConventionsAppliedText: _ignored, ...rest } = sessions as Record<string, unknown>;
  return { ...patch, sessions: rest };
}

/**
 * Conventions text that is still exactly what the wizard generated (it equals
 * `workflowConventionsAppliedText`) follows the generator: when the rules in
 * `WORKFLOW_CONVENTION_QUESTIONS` have changed since, it is re-derived from
 * the saved answers on read. Hand-edited text, and text that predates the
 * snapshot, is returned as stored.
 */
function refreshGeneratedConventions(settings: AppSettings): AppSettings {
  const { workflowConventionsText: text, workflowConventionsAppliedText: applied } =
    settings.sessions;
  if (applied === "" || text !== applied) return settings;
  const regenerated = buildWorkflowConventionsText(settings.sessions.workflowConventionAnswers);
  if (regenerated === "" || regenerated === text) return settings;
  return {
    ...settings,
    sessions: {
      ...settings.sessions,
      workflowConventionsText: regenerated,
      workflowConventionsAppliedText: regenerated,
    },
  };
}

/**
 * Applies a partial settings patch via the EXACT same deep-merge + upsert +
 * live-reconfigure sequence `PATCH /api/settings` uses (routes/settings.ts's
 * handler now just calls this) — reused by routes/bundle-sync.ts's
 * `POST /api/bundle-sync/remove` (issue #945) to flip
 * `sessions.injectMullionBundle` off as part of removal. Sharing this one
 * write path, rather than a hand-rolled second upsert, is what keeps the
 * two callers from silently drifting apart — e.g. if this function ever
 * gains another live-reconfigure call for a new setting, both callers pick
 * it up automatically.
 *
 * The explicit third `deepMerge` argument matters here specifically:
 * `previous` has already drifted from DEFAULT_SETTINGS (that's the whole
 * point of reading it), so deepMerge can't infer a field's nullability from
 * `previous` alone once it's been set once — DEFAULT_SETTINGS is the one
 * reference that never drifts. See deepMerge's own doc comment.
 */
export function applySettingsPatch(
  app: FastifyInstance,
  rawPatch: Record<string, unknown>,
): AppSettings {
  // The snapshot is the server's to write (below); a client cannot mark
  // hand-edited text as wizard output.
  const patch = withoutAppliedSnapshot(rawPatch);
  const previous = getStoredSettings(app.db);
  const next: AppSettings = sanitizeSettings(
    withRawProviderMap(deepMerge(previous, patch, DEFAULT_SETTINGS), patch),
  );
  // A patched conventions text is "applied" only when it is exactly what the
  // answers generate (the wizard's single PATCH); anything else is a hand edit.
  const patchedSessions = patch.sessions as Record<string, unknown> | undefined;
  if (typeof patchedSessions?.workflowConventionsText === "string") {
    const generated = buildWorkflowConventionsText(next.sessions.workflowConventionAnswers);
    next.sessions.workflowConventionsAppliedText =
      generated !== "" && next.sessions.workflowConventionsText === generated ? generated : "";
  }
  const data = JSON.stringify(next);

  // Upsert the singleton row — SQLite's ON CONFLICT DO UPDATE, matching how
  // a settings row simply doesn't exist until the first write.
  app.db
    .insert(settingsTable)
    .values({ id: SETTINGS_ROW_ID, data })
    .onConflictDoUpdate({ target: settingsTable.id, set: { data, updatedAt: new Date() } })
    .run();

  // Live-reconfigure the reconciler timer (see plugins/pty.ts) rather than
  // only picking up the new interval on next process restart.
  if (next.sessions.reconcileIntervalSeconds !== previous.sessions.reconcileIntervalSeconds) {
    app.reconfigureReconciler(next.sessions.reconcileIntervalSeconds);
  }
  // Live-reconfigure the git fetcher (see plugins/git-fetcher.ts) when its
  // interval changes — same immediate-effect pattern.
  if (next.sessions.gitAutoFetchIntervalSeconds !== previous.sessions.gitAutoFetchIntervalSeconds) {
    app.reconfigureGitFetcher(next.sessions.gitAutoFetchIntervalSeconds);
  }
  // Live-reconfigure the event-history retention sweep (see
  // plugins/event-store.ts) when any setting it depends on changes — runs
  // one sweep immediately against the just-persisted value rather than
  // waiting for its next fixed-cadence tick. This sweep's own onTick also
  // reconciles remote-event-subscriber.ts's per-host subscriptions (issue
  // #213 hazard 6), so an eventPersistence flip opens/closes upstreams
  // through this same call — no separate reconfigureRemoteEventSubscriptions()
  // wiring needed here.
  if (
    next.sessions.eventRetentionDays !== previous.sessions.eventRetentionDays ||
    next.sessions.eventRetentionPerSession !== previous.sessions.eventRetentionPerSession ||
    next.sessions.eventPersistence !== previous.sessions.eventPersistence
  ) {
    app.reconfigureEventRetention();
  }
  if (
    next.github.pollActiveSeconds !== previous.github.pollActiveSeconds ||
    next.github.pollQuietSeconds !== previous.github.pollQuietSeconds ||
    next.github.pollStaleThresholdSeconds !== previous.github.pollStaleThresholdSeconds
  ) {
    app.githubActivityTracker?.setIntervals(toActivityIntervals(resolveGitHubPoll(next, app)));
  }
  if (next.hosts.heartbeatSeconds !== previous.hosts.heartbeatSeconds) {
    app.reconfigureHostHeartbeat?.(resolveHeartbeatSeconds(next, app));
  }
  if (next.server.logLevel !== previous.server.logLevel) {
    app.log.level = resolveLogLevel(next, app);
  }
  // Issue #1128 — fans out a re-enable to every registered agent host on
  // the injectMullionBundle false->true edge — see plugins/bundle-sync.ts's
  // reenableAgentBundles for the full reasoning (including why this does
  // NOT also resync the primary here). Checked as the false->true edge
  // specifically, not just "next is true": every other PATCH that leaves
  // injectMullionBundle unchanged at `true` (an unrelated settings field,
  // or a redundant re-write of the same value) must not re-trigger a full
  // agent-host network fan-out on every request.
  if (next.sessions.injectMullionBundle && !previous.sessions.injectMullionBundle) {
    app.reenableAgentBundles();
  }

  return next;
}
