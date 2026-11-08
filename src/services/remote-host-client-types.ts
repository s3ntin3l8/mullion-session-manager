import type { GitIdentity } from "./git-env.js";
import type { SessionGithubAuth } from "./session-github-token.js";
import type { SshAuthSockSource } from "./ssh-agent-socket.js";

// Split out of remote-host-client-core.ts (issue #2714, its size ceiling): the
// request/response shapes the remote host client speaks. Type-only — no runtime.

/** What an agent's `/internal/sessions/:id/wait-output` answers (issue #1951). */
export type RemoteWaitOutputResult =
  | { matched: true; text: string; line: string; outputOffset: number }
  | { matched: false; timedOut: true; outputOffset: number }
  | { matched: false; gone: true; outputOffset: number }
  | { notRunning: true };

// spawn() and openAttach() both target the same session — same id/cwd/
// command/size — just over HTTP vs. WS; kept as one shared shape rather
// than two field-for-field-identical interfaces.
export interface SessionTarget {
  id: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
  skipPermissions?: boolean;
  // Task Master's initial-turn prompt (see pty-manager.ts's
  // CreateSessionOptions.initialPrompt) — only meaningful for spawn(), not
  // openAttach() (attaching never re-spawns), but kept on the shared
  // SessionTarget shape rather than splitting it for one optional field.
  initialPrompt?: string;
  // Issue #678 — the promote flow's seed prompt, for spawn() only (same
  // "meaningless for openAttach" posture as initialPrompt above — attaching
  // never re-spawns, so there's nothing to inject context into here).
  seedPrompt?: string;
  // Issue: per-project briefing storage (a follow-up PR) — for spawn() only,
  // same "meaningless for openAttach" posture as seedPrompt immediately
  // above. See CreateSessionOptions.briefingOverride's own doc comment
  // (pty-manager.ts) for the full multi-host reasoning this exists for.
  briefingOverride?: string;
  // Issue #937 — for spawn() only, same "meaningless for openAttach"
  // posture as seedPrompt/briefingOverride above. See
  // CreateSessionOptions.workflowConventionsText's own doc comment
  // (pty-manager.ts) — already fully resolved on the primary before this is
  // ever built.
  workflowConventionsText?: string;
  // PR-5 — for spawn() only, same posture as briefingOverride above. See
  // CreateSessionOptions.projectSkill/projectReviewerAgent's own doc
  // comments (pty-manager.ts).
  projectSkill?: string;
  projectReviewerAgent?: string;
  // Issue #957 — for spawn() only, same posture as projectReviewerAgent above.
  // See CreateSessionOptions.model's own doc comment (pty-manager.ts) for the
  // full multi-host reasoning.
  model?: string;
  // Issue #958 — same posture as `model` above, for opencode's
  // `small_model` config key.
  smallModel?: string;
  // Issue #884 — for spawn() only, same "meaningless for openAttach"
  // posture as seedPrompt/briefingOverride above. See
  // CreateSessionOptions.injectAgentGuide/injectProjectBriefing's own doc
  // comments (pty-manager.ts) for the full multi-host reasoning.
  injectAgentGuide?: boolean;
  injectProjectBriefing?: boolean;
  // Issue #1089 — for spawn() only, same posture as injectAgentGuide/
  // injectProjectBriefing above. See CreateSessionOptions.injectMullionBundle's
  // own doc comment (pty-manager.ts) for the full multi-host reasoning.
  injectMullionBundle?: boolean;
  // See CreateSessionOptions.taskId's own doc comment (pty-manager.ts) —
  // Task Master spawn sites set this to flag an unattended worker
  // session, which the opencode adapter uses to deny superpowers skills
  // that gate on a human in the loop. Forwarded verbatim to the agent
  // host, same posture as seedPrompt above.
  taskId?: number;
  // Resolved on the primary (project override, else settings.sessions.gitIdentity)
  // and forwarded to a remote host verbatim: it becomes user.name/user.email in
  // the session's numbered GIT_CONFIG_* env (session-env.ts buildGitConfigEnv).
  gitIdentity?: GitIdentity;
  // #2246 — for spawn() only; see CreateSessionOptions.githubAuth.
  githubAuth?: SessionGithubAuth;
  projectId?: number;
  // Issue #822 — see CreateSessionBody.env's own doc comment
  // (session-lifecycle.ts). Unlike initialPrompt/seedPrompt, this DOES
  // matter for openAttach(): a re-bootstrap on the agent side (its own
  // attachSocketToSession -> getOrCreate, internal.ts's /internal/ws/attach)
  // must reproduce the same env the original spawn used, and the agent has
  // nowhere else to read it from — it's DB-less, so it never saw the
  // primary's sessions.env column.
  env?: Record<string, string>;
}

export type SpawnSessionOptions = SessionTarget;

// Hermes review, PR #538 — spawn()'s result reports whether an
// `initialPrompt` (if one was sent) was actually understood and applied,
// echoed back from the agent's own POST /internal/sessions response rather
// than assumed locally. An agent build too old to have this route's
// `initialPrompt`/`skipPermissions` schema properties silently strips them
// (Fastify's default `removeAdditional` behavior applies even though the
// schema declares `additionalProperties: false`, verified empirically) — so
// the field's mere ABSENCE from an old build's response (parsed here as
// `undefined`, same as a field the response never included), not a `false`
// value, is itself the version-skew signal task-claim.ts's callers key off
// of to avoid trusting a locally-computed `seedDelivered` that the remote
// host may have silently failed to honor.
export interface SpawnResult {
  initialPromptApplied?: boolean;
  // Issue #884 — same "echoed back, not assumed" posture as
  // initialPromptApplied above: the resolved value THIS agent build
  // actually applied, absent entirely on a build too old to know these
  // fields exist. session-lifecycle.ts logs a warning on a mismatch
  // against what it requested.
  injectAgentGuide?: boolean;
  injectProjectBriefing?: boolean;
  // Issue #1089 — same "echoed back, not assumed" posture as
  // injectAgentGuide/injectProjectBriefing immediately above, for the
  // independent sessions.injectMullionBundle setting. Previously missing
  // entirely, which meant a version-skewed agent build silently dropping
  // this field (Fastify's `removeAdditional`, same mechanism the other two
  // fields' own doc comments describe) was undetectable by the primary —
  // session-lifecycle.ts's warning loop had nothing to compare against.
  injectMullionBundle?: boolean;
  // Hermes review, PR #966 — same "echoed back, not assumed" posture for
  // `taskId`. The remote `/internal/sessions` handler echoes this so
  // the primary can detect a version-skewed agent (an old build strips
  // `taskId` from the request body before the handler runs — see
  // spawnSessionSchema's `additionalProperties: false` and Fastify's
  // `removeAdditional`) and warn that the opencode skill denials for
  // Task Master sessions are not in effect on that agent. Optional, same
  // reason as the other two fields above: an agent build that pre-dates
  // this field simply never includes the key in its response. Note: the
  // local / internal-session handler ALWAYS echoes it (even as `false`
  // when the field was absent from the request), unlike
  // initialPromptApplied which is omitted entirely — the receiving route
  // sees `taskId: undefined` for an old-build request and reports
  // `taskIdApplied: false` rather than omitting the field, because the
  // OPENCODE_CONFIG_CONTENT it produces is itself a known-shape object
  // (never omitted from the response, just empty). See
  // routes/internal.ts's own comment for the full reasoning.
  taskIdApplied?: boolean;
}
export type OpenAttachOptions = SessionTarget;

// Issue #247 / roadmap 7.4 — mirrors GET /internal/config's response shape
// (routes/internal.ts). No idle timeout: that's a DB-backed Settings value
// on the primary, with no env-var equivalent an agent could read.
export interface AgentConfig {
  role: "primary" | "agent";
  version: string;
  projectsRoots: string[];
  // Issue #1951 follow-up — where `projectsRoots` comes from ("env": this
  // host's own PROJECTS_ROOTS; "override": saved from the primary's
  // Settings → Hosts), the env value a reset returns to, and whether this
  // host's operator pinned the roots (PROJECTS_ROOTS_LOCKED). All optional: an
  // agent build that predates them omits them, and the dialog then offers no
  // editing rather than guessing.
  projectsRootsSource?: "env" | "override";
  projectsRootsEnv?: string[];
  projectsRootsLocked?: boolean;
  // A saved override exists but the lock keeps it from applying — see
  // routes/internal.ts's buildAgentConfig.
  projectsRootsOverrideIgnored?: boolean;
  sessionsDir: string;
  crsConfigDir: string;
  browserEnabled: boolean;
  // #819/#822 SSH-agent follow-up — null when MULLION_SSH_AUTH_SOCK is
  // unset, otherwise the configured path plus a live existsSync check.
  // `present: false` is expected and NOT an error: a session spawned while
  // the far end (e.g. an `ssh -R` tunnel from a laptop) is offline is
  // supposed to keep working the moment it reconnects, with no respawn —
  // see env.ts's own comment on MULLION_SSH_AUTH_SOCK. This field is
  // read-only diagnostics for Settings > Hosts, never used to gate the
  // injection itself. Optional, same as SpawnResult.initialPromptApplied
  // just above — resolveConfig() does a raw fetch-and-cast with no runtime
  // validation, so a remote agent on a build that predates this field
  // simply omits the key, and `undefined` (not `null`) is what actually
  // arrives at runtime despite this being a locally-built object on this
  // process. HostConfigModal.tsx renders that distinctly from `null`
  // ("unknown, agent predates this field" vs. "not configured").
  //
  // PR7a: `source` says which of resolveSshAuthSock's tiers is *why* `path`
  // has this value (configured / ambient / bridge — "none" is never
  // reported here, it's the `null` case above). For `configured`/`bridge`,
  // `path` is exactly what resolveSshAuthSock itself returned. For
  // `ambient`, resolveSshAuthSock's own result is always `path: ""` (its
  // signal to "don't touch it" — buildAgentConfig substitutes the process's
  // real ambient SSH_AUTH_SOCK afterward purely for diagnostics; see its
  // own comment). Optional for the same reason the whole field is: a remote
  // agent on a build between this field's introduction (PR5d) and PR7a
  // reports `{path, present}` with no `source` — treat that as "unknown
  // which tier, but Mullion did resolve *a* path" rather than defaulting it
  // to "configured", which would be actively wrong for what was actually a
  // bridge-backed agent on that build.
  sshAuthSock?: { path: string; present: boolean; source?: SshAuthSockSource } | null;
}
