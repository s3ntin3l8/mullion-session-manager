import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/sqlite-core";
// TASK_STATUSES/TaskStatus now physically live in src/shared/constants.ts
// (re-exported by the frontend too, from the same file — see
// frontend/src/api.ts's own re-export). Re-exported below so every existing
// backend importer of this module (task-state.ts, routes/tasks.ts, ...)
// keeps working unchanged.
// TASK_STATUSES is a runtime VALUE, not type-only, so this is a plain
// import, not `import type`.
import { TASK_STATUSES, type TaskStatus } from "../shared/constants.js";

export { TASK_STATUSES, type TaskStatus };

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  // Stored encrypted at rest via EncryptionService when DB_ENCRYPTION_KEY is set.
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A host a project's files (and therefore its sessions) live on — see issue
// #26. `id` is a stable slug ("local" is seeded by the migration and is the
// only host a `local`-role backend serves in-process; every other row is a
// remote agent reached over HTTP/WS via src/services/remote-host-client.ts).
// `baseUrl`/`authTokenEnc` are null for "local". The token is encrypted at
// rest via EncryptionService (same as `users.notes`) when DB_ENCRYPTION_KEY
// is set — see src/services/host-registry.ts.
//
// Issue #245 / roadmap 7.1 — the session_* columns are this row's *live*
// rotating credential from agent-initiated registration, existing
// alongside (not replacing) the manual authTokenEnc above; every row all
// existing manually-registered hosts stay on the manual path entirely, with
// these five columns permanently null. All nullable so existing rows are
// untouched by the migration. sessionIdEnc is the value the primary checks
// against an inbound `Authorization: Bearer` for a *registered* session —
// treat it as a secret, not an identifier: until #249 (7.5, HMAC signing)
// lands, it alone is a registered agent's entire inbound credential, doing
// the same job authTokenEnc/MULLION_AGENT_TOKEN does for a manual host
// today, so it's generated and stored with the same rigor (32 random
// bytes, encrypted at rest) rather than a plain crypto.randomUUID().
export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url"),
  authTokenEnc: text("auth_token_enc"),
  sessionIdEnc: text("session_id_enc"),
  sessionSecretEnc: text("session_secret_enc"),
  sessionExpiresAt: integer("session_expires_at", { mode: "timestamp" }),
  // "manual" (today's Settings -> Add host flow) | "enrolled" (agent-
  // initiated registration, #245). Null for every pre-#245 row and for
  // "local" — only ever set by the registration route itself.
  origin: text("origin"),
  // JSON-encoded agent-reported metadata (hostname, capabilities) from
  // registration — informational only, nothing in this app's own logic
  // reads it back out yet.
  agentMetadata: text("agent_metadata"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A project is just a folder new sessions get created in — now on a specific
// host (issue #26). Every session under a project inherits its host; a
// session has no hostId of its own since a project can't change host (cwd is
// host-specific) and denormalizing here would only add drift risk. Defaults
// to the seeded "local" host so every pre-#26 row backfills unambiguously —
// see the migration for why this FK isn't enforced at the SQLite level.
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  cwd: text("cwd").notNull(),
  hostId: text("host_id")
    .notNull()
    .default("local")
    .references(() => hosts.id),
  // Where this project's dev server listens — issue #28. A bare port
  // ("5173") or a full "scheme://host:port" URL; the preview proxy
  // (src/plugins/preview-proxy.ts) parses this to find the upstream.
  // IMPORTANT: for a remote-hosted project (hostId !== "local"), any host in
  // this value is never trusted or connected to — the proxy always forces
  // the destination to that agent's own loopback, forwarding only the
  // port (+ path) from here. Don't read a host out of this column and treat
  // it as reachable; it isn't part of the trust boundary (see the plan's
  // loopback-only two-hop design). Nullable: most projects have no dev
  // server, or haven't configured one yet.
  devServerUrl: text("dev_server_url"),
  autoFetch: integer("auto_fetch", { mode: "boolean" }),
  // Phase 6 Task Master (6.2/#215) — optional per-project override of
  // launchers.defaultAgent for autonomous task claims. Nullable: unset
  // falls through to the global default. Resolution precedence (6.2's
  // claim route): an issue's own `Agent: <name>` line, then this column,
  // then settings.launchers.defaultAgent. Same nullable-column
  // shape/precedent as devServerUrl/autoFetch above — PATCH
  // /api/projects/:id treats `undefined` as "leave unchanged" and `null`
  // as "clear it."
  defaultAgent: text("default_agent"),
  // Phase 6 Task Master (6.2/#215) — optional per-project advisory review
  // agent, spawned (in the worker's own worktree) when a task enters
  // "reviewing". Unlike defaultAgent there is no global-settings fallback
  // tier: a review agent is opt-in per project/task, not a new install-wide
  // default. Nullable: unset means "no review agent, human reviews
  // directly" — today's behavior, unchanged.
  defaultReviewAgent: text("default_review_agent"),
  // Merge-on-approve / auto-approve — both per-project only, no install-wide
  // tier, same posture as defaultReviewAgent above: whether a repo may merge
  // to its own main unattended is a property of that repo's branch
  // protection/CI/conventions, not of the Mullion install. Nullable,
  // null/false = off; default-off matters, since merging is outward-facing
  // and must not switch itself on for existing projects at upgrade.
  //
  // mergeOnApprove: approving a task (reviewing -> done) sets
  // tasks.mergeRequestedAt; task-reconciler.ts's processMergeRequests sweep
  // lands the merge asynchronously once GitHub allows it (see docs/tasks.md's
  // Task -> PR promotion section).
  mergeOnApprove: integer("merge_on_approve", { mode: "boolean" }),
  // autoApprove: task-reconciler.ts's processAutoApprovals sweep approves a
  // "reviewing" task on its own once its review agent's last verdict is
  // "clean" AND CI on the PR head is green — see tasks.lastReviewVerdict.
  autoApprove: integer("auto_approve", { mode: "boolean" }),
  // #772's roadmap follow-up — the per-project override of how many
  // automatic "reviewing -> in_progress" rounds a task may spend across its
  // lifecycle (tasks.autoReturnRounds/lastAutoReturnReason). Null means
  // "use the install default" (resolveMaxAutoReturnRounds,
  // task-reconciler.ts, currently 2) — same nullable-override shape as
  // defaultAgent above, not the no-install-wide-tier posture
  // mergeOnApprove/autoApprove use: unlike merging, a round cap has a
  // sensible default that works for every project, so a global fallback is
  // useful here where it wasn't for those two.
  maxAutoReturnRounds: integer("max_auto_return_rounds"),
  // #761 — opt-in per project, same no-install-wide-tier posture as
  // mergeOnApprove/autoApprove above: whether this repo's own commit
  // history follows Conventional Commits is a property of that repo's own
  // convention, not a Mullion-wide default. Null/false = off — the raw
  // task title is used as the PR title, today's unchanged behavior.
  conventionalCommitTitles: integer("conventional_commit_titles", { mode: "boolean" }),
  // #744 — per-project only, no install-wide tier, same posture as
  // mergeOnApprove/autoApprove/conventionalCommitTitles above: whether
  // a task's merged PR should automatically trigger a release-please run
  // is a property of that repo's release workflow, not a Mullion-wide
  // default. Null/false = off; default-off matters since an unattended
  // release trigger is outward-facing and must not silently enable itself
  // for existing projects at upgrade.
  autoTagRelease: integer("auto_tag_release", { mode: "boolean" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A slug->target registry for the subdomain preview proxy (issue #28). Each
// row maps an opaque, random `slug` (the "preview-<slug>" subdomain label —
// never a decodable/encoded target, which would be an SSRF amplifier) to
// either a project's dev server or an arbitrary external URL. `kind:
// "project"` upserts one row per `projectId` (the unique index below
// enforces this — SQLite treats multiple NULL `projectId`s as distinct, so
// it only constrains the "project" rows, never "external" ones);
// `kind: "external"` gets one row per registered URL. See
// src/routes/previews.ts and src/plugins/preview-proxy.ts.
export const previews = sqliteTable(
  "previews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull().unique(),
    kind: text("kind", { enum: ["project", "external"] }).notNull(),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
    externalUrl: text("external_url"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("previews_project_id_unique").on(table.projectId)],
);

// One row per terminal session. `status` records user intent (has this been
// explicitly killed?), not live process state — whether a session's dtach
// attach-client is actually running right now is only known by PtyManager,
// in-memory, in whichever Node process currently holds it; routes merge the
// two rather than trusting this column alone for "is it alive."
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Cosmetic label the user can rename; falls back to `command` when unset.
    name: text("name"),
    // True only once the user has explicitly renamed this session (PATCH
    // /api/sessions/:id) — NOT set by launch-time name patterns (see
    // CommandPalette's expandSessionNamePattern), which leave this false so a
    // live OSC title update (issue #69) is still free to override them. Once
    // true, the frontend pins the tab title against further OSC updates.
    nameLocked: integer("name_locked", { mode: "boolean" }).notNull().default(false),
    // Shell command line to run, e.g. "claude", "codex", "bash" — see the
    // plan's CLI-agnostic design; PtyManager treats this as an opaque string.
    command: text("command").notNull(),
    // Optional override of the parent project's cwd — lets a launcher/action
    // (src/services/project-config.ts) or dock control target a subdirectory
    // (e.g. a monorepo package) without needing its own project row. Falls
    // back to the parent project's cwd when unset (see sessions.ts).
    cwd: text("cwd"),
    // "dock" sessions are spawned from a project's dock controls (persistent
    // monitors — dev server, git status, logs; see project-config.ts's
    // resolveProjectDock) rather than a one-shot launcher/manual "+ Session."
    // Kept in the same table (same PtyManager lifecycle either way) but
    // discriminated so the redesign can render them in a separate dock region
    // instead of the normal per-project session inventory.
    kind: text("kind", { enum: ["terminal", "dock"] })
      .notNull()
      .default("terminal"),
    // "exited" (distinct from the user-initiated "killed") means the program
    // ended on its own — user typed `exit`, the process crashed — and was
    // caught by the reconciler in session-reconciler.ts rather than an
    // explicit DELETE /api/sessions/:id. Fixes the M2-era gap where such a
    // session left a stale dtach socket with status still "active" forever,
    // so the next getOrCreate() would silently bootstrap a fresh program
    // under the same id.
    status: text("status", { enum: ["active", "killed", "exited"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastAttachedAt: integer("last_attached_at", { mode: "timestamp" }),
    skipPermissions: integer("skip_permissions", { mode: "boolean" }).notNull().default(false),
    // Phase 5 (Track B, issue #193 5.3b) — set only for a session an agent
    // spawned via sessions.spawn_child, never by a launcher/dock/promote. One
    // level of nesting only (createSessionRecord rejects a parent that is
    // itself a child), so this is never a chain to walk. `set null`, not
    // `cascade`, matching tasks.sessionId/sessionEvents.sessionId above: a
    // child session is a real, independent session and must survive its
    // parent's deletion (killSession's cascade:"detach" default relies on
    // exactly this FK behavior) rather than being destroyed alongside it.
    // The FK itself is declared below via the table-level `foreignKey()`
    // helper (drizzle's own non-deprecated recommendation for this shape),
    // not a column-level `.references()` — verified empirically that
    // drizzle-kit's ALTER-TABLE-ADD-COLUMN generator drops the `onDelete`
    // action for a SELF-referencing FK either way (it emits a bare
    // `REFERENCES sessions(id)` with no `ON DELETE` clause), unlike every
    // other (cross-table) FK in this file. The generated migration is
    // hand-edited to add it back — see that file's own comment, same
    // "documented hand-edit for a drizzle-kit/SQLite limitation" precedent
    // as `0008_lovely_xavin.sql`.
    parentSessionId: integer("parent_session_id"),
    // JSON-encoded `Record<string, string>` (issue #822) — extra env vars
    // injected into this session at spawn, on top of whatever a dock
    // control or direct API caller set at creation. Persisted (not just
    // passed through spawn opts) for the same reason MULLION_HOOK_TOKEN
    // is (see pty-manager.ts's loadOrCreateHookToken): a session's dtach
    // master can outlive the Mullion process, and a re-bootstrap on
    // reattach (Session.spawnInternal) must rebuild the exact same launch
    // plan, not a launch-time-only one that silently loses this the
    // moment the server restarts. Nullable — most sessions set none.
    // Same JSON-as-text convention as `workspaces.layout`/`settings.data`.
    env: text("env"),
  },
  (table) => [
    foreignKey({
      columns: [table.parentSessionId],
      foreignColumns: [table.id],
    }).onDelete("set null"),
    // Perf audit finding A3 — SQLite does not auto-index FK columns, and
    // every project-scoped session query (routes/sessions.ts's list/lookup
    // paths, the ON DELETE CASCADE from projects) filters/joins on this
    // column. Without it, every one of those is a full table scan.
    index("sessions_project_id_idx").on(table.projectId),
  ],
);

// Phase 3, issue #182 — records which project browser (src/services/
// browser-manager.ts's BrowserManager, #179) a session's browser pane(s)
// are bound to, so the agent automation API (#183) can target "this
// session's browser" without the caller naming a project id, and so a
// session's close can tear down the browser it was using (#182's own
// wording — see src/services/session-browsers.ts for what actually happens,
// since BrowserManager pools one Chromium instance per *project*, shared
// across every session in it: closing one session's binding only closes
// the underlying browser once no other session still references it).
// One row per session (`uniqueIndex` below) rather than the roadmap's
// literal "multiple browser panes per session, targeted by index" — there
// is exactly one Page per project's pooled browser today, so a second
// binding row for the same session would have nothing distinct to point
// at; upserted on each /ws/browser/:sessionId connect (routes/browser.ts).
export const sessionBrowsers = sqliteTable(
  "session_browsers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastAttachedAt: integer("last_attached_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("session_browsers_session_id_unique").on(table.sessionId)],
);

// Phase 3, issue #184 — a named cookie profile imported from the operator's
// real Chrome/Firefox browser on this same host, applied to a project's
// pooled Playwright browser (BrowserManager, #179) on launch so it starts
// already-authenticated. `cookiesEnc` holds app.encryption.encryptJson(...)
// of a Playwright-shaped cookie array (see src/services/browser-cookie-
// import.ts) — same encrypted-at-rest convention as hosts.authTokenEnc
// (src/services/host-registry.ts). One row per (projectId, label) — "label"
// is the operator-chosen name ("work" vs "personal") the roadmap's
// "support multiple profiles" asks for; re-importing the same label
// upserts/refreshes it ("re-import on demand" — cookies expire) rather than
// accumulating duplicate rows.
export const browserCookies = sqliteTable(
  "browser_cookies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    browser: text("browser", { enum: ["chrome", "firefox"] }).notNull(),
    cookiesEnc: text("cookies_enc").notNull(),
    cookieCount: integer("cookie_count").notNull().default(0),
    importedAt: integer("imported_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("browser_cookies_project_id_label_unique").on(table.projectId, table.label),
  ],
);

// TASK_STATUSES/TaskStatus imported and re-exported near the top of this
// file (see that import's own comment) — see src/shared/constants.ts for
// the full lifecycle-vocabulary doc comment (Phase 6 Task Master, 6.9/#233).

// Phase 6 Task Master (6.9/#233, hardening the Phase 2.5 Thin Slice's
// #214/#227) — one row per task, the Mullion-local hub the roadmap's Task
// Model & Task Board section specifies: GitHub is a synced durable
// projection of a task (when one is linked), not the board's backend. A
// task can be created locally with no GitHub issue at all (issueNumber/
// htmlUrl nullable — see below) or ingested from a labeled issue by the
// watcher (src/services/task-watcher.ts). `status` gained a full lifecycle
// in 6.2 (backlog -> ready -> claimed -> in_progress -> reviewing ->
// done/failed — see TASK_STATUSES/task-state.ts); render/ordering
// (boardOrder) and runtime state (worktreePath/branchName/sessionId/
// reviewSessionId) are local-only tiers with no GitHub representation, per
// the roadmap's three-tiers-of-task-state framing.
export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Nullable (6.9): a chat-created or backlog-groomed local task has no
    // GitHub issue. Verified empirically that SQLite's unique index below
    // treats NULLs as distinct, so any number of local tasks per project
    // coexist freely alongside deduped GitHub-linked ones — no partial
    // index needed.
    issueNumber: integer("issue_number"),
    title: text("title").notNull(),
    body: text("body"),
    // Nullable alongside issueNumber (6.9) — same "no issue, no URL" case.
    htmlUrl: text("html_url"),
    // Free text, not a DB enum — see TASK_STATUSES above for the closed
    // TypeScript union route/service code validates against
    // (task-state.ts's canTransition). A DB-level enum would need a
    // migration every time a state is added; this column already survived
    // one vocabulary change (pending/claimed -> the full lifecycle) without
    // one, by design.
    status: text("status").notNull().default("backlog"),
    // Local-only render/ordering tier (roadmap's Task Model & Task Board
    // section) — column position / drag order within a status. Deliberately
    // never encoded into `status` itself; never pushed to GitHub.
    boardOrder: integer("board_order").notNull().default(0),
    // Set once claimed — links this task to the currently/most-recently
    // spawned worker session. Cascades to null (not delete) on session
    // removal since the task record itself should survive a killed session
    // for history/debugging.
    //
    // #772 — a normal transition that supersedes or ends this link
    // (approve, give-up, retry, the force re-seed behind an auto-return
    // round) now kills the OLD session first, before writing the new value
    // or nulling this column. Before that fix, the old session was simply
    // left running — no path in the task lifecycle ever terminated it once
    // this pointer moved on, so it lingered indefinitely as a live process
    // with no task attached to it. See task-approve.ts's cleanupTaskSessions
    // and task-claim.ts's retryTask for the two call sites that touch this
    // column directly.
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
    // Claimed-task-never-starts-a-turn fix — whether the worker's most
    // recent spawn (claim/auto-claim/retry) actually delivered an initial
    // prompt as argv (see task-claim.ts's own doc comment on why this moved
    // off stashSeed's SessionStart `additionalContext`, which injects
    // context but never submits a turn). Previously this existed only as
    // the claim/retry HTTP response's own `seedDelivered` field — real at
    // the moment of the call, but invisible on any later view of the task
    // (a page reload, another tab, the reconciler's own log line). Null
    // means "never claimed" (a `ready`/`backlog` task); every claim/retry
    // spawn sets this true/false alongside sessionId, mirroring
    // reviewSeedDelivered below (added for the review agent by #487, before
    // the worker side had the same "invisible after the fact" gap).
    seedDelivered: integer("seed_delivered", { mode: "boolean" }),
    // 6.2 — the optional advisory review agent's session (see the Review
    // agent design decision). Independent lifecycle from sessionId: it's
    // spawned fresh each time a task enters "reviewing" and never resumed
    // across a reject cycle.
    //
    // #772 — every fresh "-> reviewing" entry now kills the OLD review
    // session (task-reconciler.ts) before nulling this column, same
    // reasoning as sessionId's own comment above. A reject-and-re-review
    // cycle previously orphaned the prior round's review session with no
    // task row pointing at it at all — strictly less recoverable than
    // sessionId's own equivalent gap, since there was no pointer left to
    // even find it by.
    reviewSessionId: integer("review_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    // #487 — mirrors the worker claim's own `seedDelivered` signal above for
    // the review agent, which HAD no such signal at the time: it's spawned
    // unconditionally, and its prompt is silently skipped when the resolved
    // command's adapter can't receive one (e.g. OpenCode, or any
    // KNOWN_AGENTS entry with no adapter at all). Null means "no review
    // agent was spawned for this task" (most tasks); a spawn always sets
    // this true/false alongside reviewSessionId, so a promptless review
    // session is visible on the row instead of only in a server log line.
    reviewSeedDelivered: integer("review_seed_delivered", { mode: "boolean" }),
    // #738 follow-up — the review-agent spawn moved out of the `→
    // reviewing` transition (task-reconciler.ts's `processPendingReviewSpawns`,
    // a separate pass gated on `reviewSessionId IS NULL`) so it can hold
    // until CI reports on the PR's head commit instead of spawning before
    // the PR even exists. That split needs its own concurrency guard: this
    // column is a CAS claim written immediately before the spawn's own I/O
    // (`createSessionRecord`), gated on `status = "reviewing" AND
    // reviewSessionId IS NULL AND reviewSpawnClaimedAt IS NULL`, so a human
    // hitting Reject/Give-up mid-spawn can't race a second claim into
    // existence. That gate also, deliberately, does not protect the CAS
    // claim's OWN final write — Reject/Give-up/Approve CAS on `status`
    // alone and know nothing of this column, so one landing while
    // `createSessionRecord` itself is in flight still wins; the claim's
    // final write re-checks `status = "reviewing"` too and discards
    // (terminates) an orphaned spawn rather than recording it. Reset to
    // null alongside `reviewSessionId` on every fresh `→ reviewing` entry (a
    // second review round needs its own claim), and cleared back to null on
    // a failed spawn attempt so the next tick retries. A claim left non-null
    // by a process crash mid-spawn — nothing else ever clears it — is
    // reclaimed once it's older than `REVIEW_SPAWN_CLAIM_STALE_MS`
    // (task-reconciler.ts), rather than the task losing its reviewer
    // forever to a redeploy that happened at the wrong instant.
    reviewSpawnClaimedAt: integer("review_spawn_claimed_at", { mode: "timestamp" }),
    // Review-feedback loop — the review agent's own findings, read from the
    // round-suffixed file it wrote (see task-prompt.ts's
    // taskReviewFindingsPath) once its session reaches "finished". Appended
    // across rounds under a `## Round N` header (never replaced), so a
    // round-1 finding stays visible even after a round-2 review reuses
    // reviewSessionId for its own, newer session. Null means no findings
    // have been ingested yet — could be a task with no review agent
    // configured, one still running, or one that genuinely found nothing.
    reviewFindings: text("review_findings"),
    // How many times this task has already driven an automatic
    // "reviewing -> in_progress" round back to the worker — not just from a
    // changes-requested review verdict anymore (#772's roadmap follow-up):
    // see `lastAutoReturnReason` below for the full trigger vocabulary.
    // Bounded by the resolved per-project cap
    // (`resolveMaxAutoReturnRounds`/`projects.maxAutoReturnRounds`,
    // task-reconciler.ts) — previously hardcoded to a single round
    // (`reviewRounds < 1`) — and, once incremented, NEVER reset — not by
    // Retry, not by a human Reject — so a task's auto-return budget is
    // spent once per lifecycle no matter how many times a human sends it
    // back around by hand. The TS property was renamed from `reviewRounds`
    // to `autoReturnRounds` to match; the underlying SQL column stays
    // `review_rounds` deliberately — every other migration in this repo is
    // a purely additive `ALTER TABLE ... ADD`, and a genuine column rename
    // risks drizzle-kit treating it as a drop-and-add against a live DB.
    autoReturnRounds: integer("review_rounds").notNull().default(0),
    // Which trigger most recently drove an auto-return round — distinct
    // from the verdict itself (`lastReviewVerdict`, below), since not every
    // trigger is a review verdict. Null until the first auto-return.
    lastAutoReturnReason: text("last_auto_return_reason", {
      enum: ["review", "ci", "pr-comment"],
    }),
    // The reviewSessionId whose findings have already been read and acted
    // on (comment posted, review_findings appended, auto-return decided) —
    // NOT the same question autoReturnRounds answers. A task can sit in
    // "reviewing" for a long time with its review agent finished and ZERO
    // findings (nothing to auto-return for), and the reconciler polls every
    // "reviewing" task on every tick; without this marker that task would
    // be re-ingested (and re-commented) on every single tick forever. Null
    // means the current reviewSessionId's output hasn't been processed yet.
    reviewFindingsIngestedSessionId: integer("review_findings_ingested_session_id"),
    // #757 — the newest GitHub PR review comment (from an unresolved thread,
    // excluding Mullion's own review bot) already acted on by an auto-return
    // round. Prevents re-triggering a round for a comment already answered:
    // a comment thread stays "unresolved" from GitHub's own perspective
    // until a human clicks Resolve, so without this cursor the SAME
    // unresolved thread would drive a fresh round on every reconcile tick
    // forever. Null means no PR-comment round has ever fired for this task.
    // Advanced only after a round actually starts (autoReturnTask returns
    // `{ ok: true }`) — never on a lost CAS race, so a losing attempt
    // doesn't silently skip comments a later, successful attempt still
    // needs to see.
    lastPrReviewCommentAt: integer("last_pr_review_comment_at", { mode: "timestamp" }),
    // 6.2/6.8 — durable record of the task's worktree, set at claim time.
    // Previously this existed only as sessions.cwd, with nothing marking it
    // as a worktree or naming its owning task; 6.8's cleanup (clean-check
    // gated removal, boot-time orphan prune) and 6.7's push both need it,
    // and sessions.cwd alone doesn't survive the worker session's own
    // removal.
    worktreePath: text("worktree_path"),
    // 6.2/6.7/6.8 — the branch git actually created for this task
    // ("mullion/task-<id>", not derived from issueNumber — see the claim
    // route's own comment for why a deterministic issue-number-based name
    // broke retries). Recorded here so cleanup/push never have to
    // re-derive it.
    branchName: text("branch_name"),
    // #491 — the resolved commit SHA the worktree was actually branched
    // from, captured at claim time (local-hosted projects only — remote
    // projects branch from the literal "HEAD" and this stays null, same
    // boundary #484 draws elsewhere). A SHA, not a symbolic ref like
    // "origin/main": the ref moves as the default branch advances, so
    // storing the symbolic form and re-resolving it later for a diff-stat
    // would silently diff against a base the branch was never actually cut
    // from. Preserved (not cleared) across retry, since retry resumes the
    // same branch from the same original base.
    baseSha: text("base_sha"),
    // Explicit per-task implementation agent override (nullable: falls back to
    // issue directive -> project.defaultAgent -> global settings).
    agent: text("agent"),
    // Explicit per-task review agent override (nullable: falls back to
    // issue directive -> project.defaultReviewAgent; "none" disables review).
    reviewAgent: text("review_agent"),
    // 6.2/6.7 — the resolved launch command actually used for the worker
    // session (task.agent -> issue `Agent:` line -> projects.defaultAgent ->
    // settings.launchers.defaultAgent), recorded once at claim time so the
    // panel can show which agent a task ran under without re-deriving
    // precedence after any of those inputs later change.
    agentCommand: text("agent_command"),
    // 6.7 — the durable "linked PR" field from the roadmap's Tier-1
    // (durable/shareable) list. Set once Task -> PR promotion succeeds.
    prUrl: text("pr_url"),
    // Draft-PR-at-review — the PR number alongside prUrl, needed to look the
    // PR back up (comment on it, mark it ready for review) without parsing
    // it out of prUrl. Set at the same time as prUrl, whether that's the
    // reconciler opening a draft at "-> reviewing" or approve's own
    // fallback create path for a task claimed before this shipped. Doubles
    // as the idempotency check for both: a second "-> reviewing" (after an
    // auto-returned review round) or a second approve attempt sees this
    // already set and pushes new commits to the existing PR instead of
    // creating another one.
    prNumber: integer("pr_number"),
    // #761 — the agent-supplied Conventional Commits title (worker writes it
    // to a sessionsDir-relative file as part of its finish contract; see
    // taskCommitTitlePath's own doc comment, task-prompt.ts), validated and
    // ingested at the same "-> reviewing" transition openDraftPRForTask runs
    // from, so the draft PR's very first create call already has it.
    // Nullable: absent (project doesn't opt in via
    // projects.conventionalCommitTitles), or malformed (didn't match the
    // Conventional Commits pattern) — either way task-promote.ts falls back
    // to the raw task title, never blocking promotion on this.
    prTitle: text("pr_title"),
    // Merge-on-approve — the durable *intent* to merge this task's PR, set
    // when approve runs on a project with mergeOnApprove on (or by a manual
    // "Merge now"/"Retry merge" click). Bounds task-reconciler.ts's
    // processMergeRequests sweep candidate set: without this column, rollout
    // would retroactively try to merge every historically-approved PR.
    // Cleared once the PR is merged (or found already merged/closed) — the
    // rate limiter (backoff between attempts) is intentionally in-memory
    // only, not durable, same reasoning as retryStrandedDraftPRs' own
    // draftPrRetryState.
    mergeRequestedAt: integer("merge_requested_at", { mode: "timestamp" }),
    // Merge-on-approve — the last merge-sweep failure reason (conflicts with
    // main, checks blocked, no token, ...), surfaced in the task drawer. A
    // separate column from githubSyncError, which clearGithubSyncError would
    // otherwise clobber independently of this sweep's own state.
    mergeError: text("merge_error"),
    // #758 — how many times the merge sweep has spawned a worker to resolve
    // a real conflict (`dirty` mergeableState) with the base branch. A
    // deliberately SEPARATE counter/cap from `autoReturnRounds` above: this
    // never transitions the task out of `done` (there is no outgoing edge
    // from `done` — task-state.ts), so `autoReturnTask`'s CAS-on-"reviewing"
    // mechanism doesn't apply here, only the same shape (bounded counter,
    // give-up once spent). Never reset. See `attemptAutoRebase`
    // (task-reconciler.ts) for the cap.
    rebaseAttempts: integer("rebase_attempts").notNull().default(0),
    // #758 — set when an auto-rebase worker is spawned, read back on the
    // next merge-sweep tick to decide "is an attempt already in flight" —
    // NOT session-exited detection, because a Task Master worker is told to
    // stay running after it finishes (see buildTaskMasterPreamble), so a
    // still-"active" session is the COMMON case for a finished attempt, not
    // a signal one is still working. A timestamp older than
    // REBASE_ATTEMPT_STALE_MS is treated as abandoned, mirroring
    // REVIEW_SPAWN_CLAIM_STALE_MS's own reclaim reasoning. Cleared once the
    // merge sweep leaves the `dirty` state (clearMergeState).
    rebaseStartedAt: integer("rebase_started_at", { mode: "timestamp" }),
    // #744 — durable intent to cut a release covering this task, armed by
    // task-reconciler.ts's attemptMerge the moment this task's OWN PR
    // actually merges (case "clean" only — never on "already-done", which
    // also covers a PR closed WITHOUT merging; see that call site's own
    // comment). Per-task, not per-project, so the failure surfaces on the
    // task the way mergeError does; task-reconciler.ts's
    // processReleaseRequests sweep groups armed tasks BY project, so N tasks
    // landing in a burst coalesce into ONE release, not N. Gated on
    // projects.autoTagRelease — see that column's own doc comment.
    releaseRequestedAt: integer("release_requested_at", { mode: "timestamp" }),
    // #744 — the last autorelease-sweep failure for this task (no release
    // workflow configured, release PR blocked/dirty/behind, no write token,
    // ...), surfaced in the task drawer. A separate column from mergeError
    // (that sweep is already done by the time this one runs) and from
    // githubSyncError (clearGithubSyncError would otherwise clobber it
    // independently of this sweep's own state) — same reasoning mergeError
    // itself already documents relative to githubSyncError above.
    releaseError: text("release_error"),
    // Auto-approve — the review agent's most recently ingested verdict
    // ("clean" | "changes-requested" | "inconclusive"), written alongside
    // reviewFindingsIngestedSessionId in task-reconciler.ts's
    // processReviewingTasks. Durable because auto-approve's gate needs to
    // read it back later, not just at ingestion time — re-parsing the
    // rendered reviewFindings prose is not a gate worth betting a merge on.
    lastReviewVerdict: text("last_review_verdict"),
    // 6.4/6.9 — intended as part of the Tier-1 durable subset, but NOT
    // actually synced today and always null in practice: nothing in src/
    // ever writes this column. The assignee flow is write-only in the other
    // direction — task-github-sync.ts calls github-write.ts's setAssignees
    // once on claim with the integration's own login, and never reads it
    // back. The column is selected into GET /api/tasks and rendered in
    // TaskDetail.tsx, so it's plumbed end-to-end and just never populated.
    // See docs/tasks.md's Known limitations.
    assignee: text("assignee"),
    // 6.2 — why a task went to "failed" (session exited before completion,
    // budget exceeded, spawn failed) — surfaced on the task row and in the
    // panel rather than only in server logs. Deliberately NOT reused for a
    // GitHub sync/promotion failure (#485): this column is also written by
    // reject (routes/tasks.ts) with the human's feedback text on an
    // in_progress task, and only rendered in the UI when
    // status === "failed" — a sync error here would be both invisible on
    // any other status and capable of clobbering live reject feedback. See
    // githubSyncError below instead.
    failureReason: text("failure_reason"),
    // #485 — the most recent GitHub sync (task-github-sync.ts) or promotion
    // (task-promote.ts) failure, e.g. an under-scoped token's 403. Null
    // means "no known sync problem," not "never synced" — cleared on the
    // next successful sync for this task so it always reflects current
    // state, not history. Independent of failureReason/status: a task can
    // be happily in_progress while its GitHub sync is silently broken, and
    // this is the only durable, UI-visible record of that (previously only
    // a server log line, invisible even during promotion despite docs
    // claiming otherwise).
    githubSyncError: text("github_sync_error"),
    // #667 — dependency-aware auto-claim. Snapshot of GitHub's
    // `issue_dependencies_summary.total_blocked_by`, written on every
    // ingest (rides the `listLabeledIssues` list response for free — see
    // github.ts's TaskIssue). Deliberately NULLABLE, not
    // `NOT NULL DEFAULT 0`: null means "not yet observed" — a GitHub-linked
    // task whose dependency state has never been read (fresh webhook
    // ingest, a pre-#667 row, a sweep that hasn't reached it yet) must read
    // as unresolved/fail-closed, not as verified-zero. A local task
    // (issueNumber null) never gets this written and so always reads
    // "clear" — see task-dependencies.ts's dependencyGate table.
    dependencyCount: integer("dependency_count"),
    // JSON array of this task's currently-OPEN blockers (owner/repo/number/
    // title/htmlUrl), resolved via GET .../dependencies/blocked_by. Null =
    // never resolved, or the last resolution attempt failed (fail-closed,
    // same as a null dependencyCount). "[]" = resolved, zero open blockers.
    // See task-dependencies.ts.
    blockedBy: text("blocked_by"),
    // When blockedBy was last successfully resolved — drives the re-check
    // TTL in task-watcher.ts's autoClaimReadyTasks (avoids re-fetching
    // blockers on every sweep once webhooks or a recent check already
    // settled them).
    blockedByCheckedAt: integer("blocked_by_checked_at", { mode: "timestamp" }),
    // #701 — GitHub sub-issue hierarchy. parentIssueNumber/parentIssueRepo
    // ride the same listLabeledIssues response dependencyCount does (GitHub's
    // `parent_issue_url`, present on the plain issues-list response — no
    // extra call, verified live during planning against branchdam). Null
    // means "no parent OR never observed" — the two are indistinguishable
    // and deliberately so: unlike dependencyCount, nothing gates a claim
    // decision on this, it's a display concern only, so there's no
    // fail-closed reasoning to preserve.
    parentIssueNumber: integer("parent_issue_number"),
    // "owner/repo" of the PARENT, not necessarily this task's own project
    // repo — GitHub allows a cross-repo parent, and the title-fill pass
    // (task-watcher.ts's fillParentIssueTitles) needs the parent's own repo
    // to fetch against, not the child's.
    parentIssueRepo: text("parent_issue_repo"),
    // Denormalised onto every child row sharing a parent (e.g. 4 siblings
    // duplicate one phase title) rather than a separate cache table —
    // matches this repo's "just store what GitHub gave us" posture, and
    // staleness here is purely cosmetic. NOT part of the free ride: title
    // isn't on the list response, so this is filled lazily by
    // fillParentIssueTitles, one GitHub call per distinct parent, and
    // invalidated by upsertIssueTask only when the parent identity itself
    // changes (see that function's own comment).
    parentIssueTitle: text("parent_issue_title"),
    // GitHub's `sub_issues_summary` — also free on the same response. Only
    // meaningful when this task is ITSELF someone's parent, which requires
    // the parent to also carry the task label; on the reference install
    // none currently do, so this renders on zero cards today (documented,
    // not a bug).
    subIssueTotal: integer("sub_issue_total"),
    subIssueCompleted: integer("sub_issue_completed"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
    // The queue-then-dispatch split (rate-limit-storm fix) — stamped the
    // moment a task enters "claimed" (manual claim/retry unconditionally,
    // auto-claim only when it believes there's room), i.e. when the task
    // joins the queue. `claimedAt` below is stamped separately, only once a
    // worker session actually spawns — so a task that sits queued for hours
    // isn't force-failed by the budget reaper the instant it starts (that
    // reaper measures from `claimedAt`, never `queuedAt`). Never cleared
    // once set; a queued-then-dispatched task keeps this as a lifecycle
    // audit timestamp distinct from "when did its current spell start."
    queuedAt: integer("queued_at", { mode: "timestamp" }),
    // Stamped at DISPATCH (the reservation transaction that flips
    // "claimed" -> "in_progress"), not at claim/retry/enqueue time — see
    // queuedAt above. Null while a task sits queued with no session yet.
    claimedAt: integer("claimed_at", { mode: "timestamp" }),
    // 6.2 — lifecycle audit + the input to the per-task time-budget
    // deadline math (see task-reconciler.ts).
    startedAt: integer("started_at", { mode: "timestamp" }),
    reviewingAt: integer("reviewing_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  // De-dup mechanism for the watcher's poll sweep: insert-or-ignore/update
  // per (project, issue) rather than a "last-seen cursor" — see #214's
  // original design and #217/6.4's insert-or-update extension. NULLs are
  // distinct under this index (verified against SQLite directly), so it
  // only ever constrains GitHub-linked rows, never local ones.
  (table) => [
    uniqueIndex("tasks_project_id_issue_number_unique").on(table.projectId, table.issueNumber),
  ],
);

// A single-row table holding the whole Settings-modal preferences blob as
// opaque JSON (see src/services/settings.ts for the actual shape/defaults) —
// same "backend stores/replays an opaque value" philosophy as
// `workspaces.layout`. Singleton by convention (id is always 1); a settings
// row simply doesn't exist until the first PATCH, at which point
// src/routes/settings.ts upserts it.
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  data: text("data").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A single credential per external provider (today: just "github") — issue
// #27. `provider` is the primary key rather than an autoincrement id since
// there's exactly one account connected at a time (device flow yields one
// user token; per-project tokens would need a different shape entirely).
// `authTokenEnc` is encrypted at rest via EncryptionService (same convention
// as `hosts.authTokenEnc`/`users.notes`) when DB_ENCRYPTION_KEY is set — see
// src/services/github-integration.ts. `login`/`scopes` are cached from the
// token-validation response purely for display (Settings -> Integrations);
// never treat them as authoritative for authorization decisions.
export const integrations = sqliteTable("integrations", {
  provider: text("provider").primaryKey(),
  authTokenEnc: text("auth_token_enc"),
  tokenType: text("token_type", { enum: ["pat", "oauth"] }),
  login: text("login"),
  scopes: text("scopes"),
  webhookEnabled: integer("webhook_enabled", { mode: "boolean" }).notNull().default(false),
  webhookSecretEnc: text("webhook_secret_enc"),
  connectedAt: integer("connected_at", { mode: "timestamp" }),
  // #489 — an optional GitHub App, configured independently of the PAT/
  // OAuth token above. When present, both Task Master's own write paths
  // (sync, promote, push, issue ingest) and the base GitHub integration's
  // reads (repo-status widget, PR/CI poller) mint a short-lived installation
  // token scoped to the single repo in question — write-permissioned for
  // the former, read-permissioned for the latter — instead of using the
  // shared install-wide token above. Either flavor falls back to
  // authTokenEnc when the App isn't configured, isn't installed on a given
  // owner, or a mint fails. Webhook registration is the one exception that
  // always uses authTokenEnc: a GitHub App doesn't create per-repo hooks, so
  // there's no App-token path for it to begin with. `githubAppPrivateKeyEnc`
  // is a PEM, encrypted at rest the same way authTokenEnc/webhookSecretEnc
  // are.
  githubAppId: text("github_app_id"),
  githubAppPrivateKeyEnc: text("github_app_private_key_enc"),
  // #514 — stamped by setGitHubApp on every successful PUT (initial
  // configure or rotation), nulled by clearGitHubApp alongside the other
  // two App columns. Purely a display value (Settings -> Integrations
  // shows "Key set <date>") — resolveGitHubToken and the token cache never
  // read it. Pre-migration/never-configured rows are null; render nothing,
  // not "unknown."
  githubAppKeyRotatedAt: integer("github_app_key_rotated_at", { mode: "timestamp" }),
});

// #490b — per-project webhook registration record. Distinct from
// `integrations.webhookEnabled` above (the single install-wide on/off
// switch): this is what makes `webhookRegisteredCount` in
// `GitHubIntegrationSummary` report something real (it was hardcoded `0`
// before this table existed — nothing persisted a per-repo registration
// count for it to read), and what the reconciler diffs the project list
// against to detect a project that never got a hook (added after
// `enableWebhooks` last ran, or whose registration attempt failed). One
// row per project, not per repo — a project's remote can change, so this
// can't be derived from the project row alone. `hookId` is GitHub's own
// webhook id, null while unregistered/failed; `lastError` records the most
// recent registration failure (cleared on success) so a persistently
// unregistrable project (e.g. token lost hook-admin scope) is diagnosable
// without a server-log dig. Cascade-deletes with its project.
export const webhookRegistrations = sqliteTable(
  "webhook_registrations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    hookId: integer("hook_id"),
    registeredAt: integer("registered_at", { mode: "timestamp" }),
    lastError: text("last_error"),
    // #667 — which version of github-webhook.ts's registered `events` array
    // this hook was last (re-)registered against. NOT NULL DEFAULT 0 so
    // every pre-existing row starts below WEBHOOK_EVENTS_VERSION, which is
    // exactly what makes webhook-reconciler.ts re-run registration for an
    // already-healthy hook once, the only way an event-list change (e.g.
    // adding "issue_dependencies") ever reaches an install that registered
    // before it shipped — the reconciler otherwise only touches projects
    // with no hook at all. Stamped by upsertWebhookRegistration on every
    // successful registration.
    eventsVersion: integer("events_version").notNull().default(0),
  },
  (table) => [uniqueIndex("webhook_registrations_project_id_unique").on(table.projectId)],
);

// Saved URLs per project — quick-access bookmarks in the built-in browser
// (issue #109). `favorite` flags a URL to also surface in the command
// palette's Integrations section. Cascade-deleted when its project is removed.
export const projectUrls = sqliteTable("project_urls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  url: text("url").notNull(),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  order: integer("order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A collapsible named sidebar section that workspaces can optionally belong
// to — vision item #4 (cmux workspace groups). Deliberately simpler than
// cmux's own model: no "anchor workspace" owning the group header, just a
// plain container a workspace references by id. Orthogonal to `projects`
// (which group *sessions* by folder) — see the plan for why these two
// grouping axes are intentionally separate.
export const groups = sqliteTable("groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  icon: text("icon"),
  color: text("color"),
  collapsed: integer("collapsed", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Issue #213 (roadmap 4.7) — one row per `NotificationEvent` (see
// src/services/pty-manager.ts), mirrored to disk by src/plugins/event-store.ts
// so a session's notification history survives past its in-memory ring
// buffer (EVENTS_MAX = 100, FIFO-evicted) and process restarts. Opt-in via
// settings.sessions.eventPersistence (default off) — this table can be
// completely empty on a deployment that never turned it on.
//
// Issue #213 cross-host capture: as of remote-event-subscriber.ts, this table
// also holds events from every enrolled agent host, not just sessions this
// process itself spawned — see event-store.ts's own doc comment. The unique
// index below on (session_id, seq, ts, kind) is what makes that safe: a
// remote subscription replays its buffered events on every reconnect
// (REPLAY_MAX_EVENTS in events.ts), and this index lets insertSessionEvents
// use onConflictDoNothing() to silently drop the replayed duplicates rather
// than re-inserting them. NULL session_id (orphaned rows, onDelete: "set
// null" below) is NOT deduped by this index — SQLite treats NULLs as
// distinct in a UNIQUE index — but that's fine: orphaning happens strictly
// after insert, so a row can only reach NULL after already being counted
// once, and the age/count sweeps still bound orphan growth independently.
export const sessionEvents = sqliteTable(
  "session_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // `set null`, not `cascade` — same tradeoff `tasks.sessionId` above
    // documents ("the task record itself should survive a killed session
    // for history/debugging"), applying at least as strongly to a history
    // feature: the whole point is to outlive the session (and even the
    // project, since there's no project FK here at all — only the
    // retention sweep below bounds growth long-term). Cascade would be
    // tidier but would silently destroy the history the moment a project
    // is deleted, defeating the point of this table. foreign_keys is ON
    // for this connection (see db/client.ts), so this constraint is
    // actually enforced at runtime, not just declared.
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "set null" }),
    // Per-session sequence number from NotificationEvent.seq — monotonic
    // within a session, not globally unique (two different sessions both
    // legitimately have a seq:1; see that field's own doc comment in
    // pty-manager.ts).
    seq: integer("seq").notNull(),
    // Deliberately plain text, not a SQL enum matching NotificationEvent's
    // "kind" union (15+ members already and still growing) — same reasoning
    // `tasks.status` uses: a DB-level enum would need a migration every
    // time a new kind is added.
    kind: text("kind").notNull(),
    // Raw epoch milliseconds, mirroring NotificationEvent.ts (Date.now())
    // directly — deliberately NOT Drizzle's `mode: "timestamp"` (which
    // every other timestamp column in this file uses), because that mode
    // is second-granularity by this file's own convention, and truncating
    // to seconds here would introduce a unit mismatch against the
    // in-memory event objects this table mirrors. Don't "fix" this to
    // match the rest of the file — it's intentionally different.
    ts: integer("ts").notNull(),
    // Opaque JSON blob (JSON.stringify(event.payload)) — same
    // "backend service is the only thing that parses this" convention as
    // `settings.data`/`workspaces.layout` above.
    payload: text("payload"),
  },
  (table) => [
    // The query path's typical filter (a session's events, in time order).
    index("session_events_session_id_ts_idx").on(table.sessionId, table.ts),
    // Reconnect-replay dedupe for remote-event-subscriber.ts — see this
    // table's own doc comment above for why (session_id, seq, ts, kind) is
    // the right dedupe key and what it does NOT cover.
    uniqueIndex("session_events_dedupe_idx").on(table.sessionId, table.seq, table.ts, table.kind),
    // Perf audit finding A3 — event-history.ts's sweepOldSessionEvents runs
    // `WHERE ts < ?` with no session_id predicate, hourly, over the whole
    // table. The composite index above is useless for that query (its
    // leftmost column is session_id, so a ts-only filter can't use it) —
    // this standalone index is what the sweep actually needs.
    index("session_events_ts_idx").on(table.ts),
  ],
);

// A workspace is a named, saved dockview layout — the cmux-style "tab" that
// groups a whole split arrangement of terminals, not a single terminal. The
// backend treats `layout` as an opaque JSON blob (dockview's own
// api.toJSON()/fromJSON() shape, including each panel's params.sessionId) —
// same philosophy as `sessions.command` being an opaque string. Nullable
// because a freshly created workspace has no layout yet (empty dockview grid).
export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  layout: text("layout"),
  // Nullable: an ungrouped workspace is the common case. `set null` on
  // delete so removing a group leaves its former members ungrouped rather
  // than deleting them — a group is pure view metadata, same philosophy as
  // this table's own hard-delete (see workspaces.ts).
  groupId: integer("group_id").references(() => groups.id, { onDelete: "set null" }),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// #95 prerequisite — a single, auto-generated VAPID keypair for Web Push,
// not an env var: src/plugins/env.ts's @fastify/env schema has `required: []`
// (every var optional-with-default), so an env-var-only VAPID design would be
// a silently-disabled feature for anyone who doesn't read the docs. Generated
// on first subscribe via web-push's generateVAPIDKeys() and persisted here —
// see src/services/push-store.ts. Singleton row (id=1, enforced at the
// service layer, not a DB constraint — same convention as this file's other
// single-row tables). `privateKeyEnc` follows the `_enc`-suffix convention
// integrations.authTokenEnc/webhookSecretEnc establish for secrets at rest,
// decrypted via app.encryption. `publicKey` is public key material, not a
// credential — stored plaintext, same as pushSubscriptions.p256dhKey below.
export const pushKeys = sqliteTable("push_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  publicKey: text("public_key").notNull(),
  privateKeyEnc: text("private_key_enc").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// #95 prerequisite — one row per browser PushSubscription (endpoint +
// per-subscription keys), registered via POST /api/push/subscribe. Deliberately
// its own table, not a column on `settings` — GET /api/settings returns its
// whole blob to every client on hydrate, and a push credential (even just
// this table's auth key) has no business being handed back to the browser
// that already holds it locally. `p256dhKey` is public key material (safe
// plaintext, matches pushKeys.publicKey above); `authKeyEnc` is the shared
// secret and follows the same `_enc` convention. `endpoint` is unique per
// subscription (one row per device/browser installation); `lastSuccessAt`/
// `lastFailureAt` support a future Settings device list and are otherwise
// unused by delivery logic — a 404/410 send response deletes the row outright
// rather than accumulating failures (see push-delivery.ts, issue #95).
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    endpoint: text("endpoint").notNull(),
    p256dhKey: text("p256dh_key").notNull(),
    authKeyEnc: text("auth_key_enc").notNull(),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp" }),
    lastFailureAt: integer("last_failure_at", { mode: "timestamp" }),
  },
  (table) => [uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint)],
);
