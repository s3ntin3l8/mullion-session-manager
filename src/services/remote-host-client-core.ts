import type { AgentProtocolInfo } from "../shared/agent-protocol.js";
import { browserTargetQuery, type BrowserTarget } from "./browser-manager.js";
import { renderScrollback } from "./scrollback-render.js";
import type { TerminalPalette } from "./terminal-query-reply.js";
import type { TranscriptQuery, TranscriptResult } from "./session-transcript.js";
import type { GitIdentity } from "./git-env.js";
import type { SessionGithubAuth } from "./session-github-token.js";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { WebSocket as NodeWebSocket } from "ws";
import type { HostCapacityReport } from "./host-capacity.js";
import { DEFAULT_GENERATION_TIMEOUT_MS, type GenerationTurnResult } from "./scaffold-turn.js";
import type { CloneResult } from "./git-clone.js";
import type { DiscoveredCandidate, Launcher, DockControl } from "./project-config.js";
import type { AgentRuleTarget } from "./agent-rules.js";
import type { DockConfigReadResult } from "./dock-config.js";
import type { SkillInfo, SkillAgent } from "./skills.js";
import type { SessionInfo } from "./pty-manager.js";
import type { DetectedAgent } from "./agent-detect.js";
import type { GitHubRepoRef } from "./git-remote.js";
import type { GitStatusResult } from "./git-status.js";
import type { GitBranchInfo, GitWorktreeInfo } from "./git-refs.js";
import type { GitDiffStats } from "./git-diff.js";
import type { CommitDetail, CommitLogEntry } from "./git-log.js";
import type { UpdateStatus, ApplyUpdateBody } from "./update-apply.js";
import type { HostTransport } from "./agent-channel-tunnel.js";
import {
  downloadOverChannel,
  previewHttpOverChannel,
  uploadOverChannel,
} from "./remote-host-channel-transfers.js";
import { attachStreamQuery, openStreamOnTransport } from "./agent-channel-streams.js";
import {
  AGENT_CHANNEL_STREAMS_OPERATION,
  type AgentChannelStreamKind,
} from "../shared/agent-channel.js";
import type { DirectoryListing } from "./fs-dirs.js";
import { HostRequestError, HostUnreachableError, isHostBusyError } from "./remote-host-errors.js";
import * as git from "./remote-host-git.js";
import { probeHealth } from "./host-health-probe.js";

export {
  HostOutcomeUnknownError,
  HostRequestError,
  HostUnreachableError,
} from "./remote-host-errors.js";
import type {
  AgentConfig,
  OpenAttachOptions,
  RemoteWaitOutputResult,
  SpawnResult,
  SpawnSessionOptions,
} from "./remote-host-client-types.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER } from "./request-signature.js";
import { uploadInbound, downloadInbound } from "./remote-host-file-streams.js";
import { RemoteHostTransport, type HostCredentials } from "./remote-host-transport.js";
import type { PromoteDecision } from "../shared/promote-decision.js";
import type {
  ClearOrphanedTaskWorktreeResult,
  CommitWipChangesResult,
  ResyncStaleWorktreeResult,
  CreateWorktreeResult,
  PruneWorktreesResult,
  RemoveIfCleanResult,
  RemoveListedWorktreeResult,
  WorktreeResult,
} from "./git-worktree.js";
import type { DeleteBranchResult } from "./git-branch-delete.js";
import type { GitPullResult } from "./git-pull.js";
import type { GitBranchOpResult } from "./git-branch-ops.js";
import type { CloneHealth, RepairOutcome, RepairPlan } from "./git-doctor.js";
import type { PushResult } from "./git-push.js";
import type { ScaffoldEntry } from "./mullion-scaffold.js";
import type {
  ProjectDirListing,
  ProjectFileContent,
  ProjectFileWriteResult,
  ProjectFileStat,
  ProjectSearchListing,
} from "./project-files.js";
import { DEFAULT_SETUP_TIMEOUT_MS, type SetupRunResult } from "./setup-recipe-shared.js";

export type {
  AgentConfig,
  OpenAttachOptions,
  RemoteWaitOutputResult,
  SessionTarget,
  SpawnResult,
  SpawnSessionOptions,
} from "./remote-host-client-types.js";

// One HTTP+WS client per remote "agent" host (issue #26), talking to its
// token-gated /internal/* API (src/routes/internal.ts). Every request sets
// `Authorization: Bearer <token>`; a bearer WS header (not a query-string
// token) is only settable via the `ws` package's client, not the global
// WebSocket — see src/routes/internal.test.ts's identical reasoning.

// A network blip must never read as "the agent said no sessions are alive"
// (landmine #1 — an unreachable host's sessions must be skipped, not
// flipped to exited) — every call below throws HostUnreachableError rather
// than returning a default/empty payload on network failure or timeout.
const REQUEST_TIMEOUT_MS = 5_000;

// Issue #1721 / roadmap 8.7 — the CAPACITY call's own budget, shorter
// than the default on purpose. Capacity is ADVISORY input to a placement
// policy, while the health ping next to it decides a verdict; the sweep
// awaits the capacity call after the ping, so a hung capacity route would
// otherwise add its own timeout to the sweep and, with the sweep's
// reentrancy guard, push the NEXT tick (and with it every host's health
// update) out. Two seconds is generous for a reading of four numbers on
// the far end of a LAN.
const CAPACITY_REQUEST_TIMEOUT_MS = 2_000;

// Test-only knob (issue #1634): a full local `make test` runs hundreds of real
// Fastify servers in parallel, and the multi-host integration tests make REAL
// loopback round trips whose 5s budget the resulting event-loop lag can blow
// through. This widens only the DEFAULT budget (not any call's own explicit
// one) and returns a restore function; production code never calls it, so
// the user-facing "how long before an unreachable host is reported as such"
// value stays REQUEST_TIMEOUT_MS.
let defaultRequestTimeoutMs = REQUEST_TIMEOUT_MS;
// The capacity call's own budget (see CAPACITY_REQUEST_TIMEOUT_MS). Kept as
// its own variable so the test override below can widen it too: the knob
// exists because this host's parallel suite blows real budgets, and a test
// that exercises a slow capacity route needs the SAME escape hatch every
// other call site has.
let capacityRequestTimeoutMs = CAPACITY_REQUEST_TIMEOUT_MS;
export function overrideDefaultRequestTimeoutForTests(ms: number): () => void {
  // AbortSignal.timeout throws on NaN/negative and a value above 2^31-1 only
  // warns and clamps to 1ms (every request would abort instantly) — refuse
  // both rather than invert the intent.
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2 ** 31 - 1) {
    throw new RangeError(`request timeout override must be in (0, 2^31-1] ms, got ${ms}`);
  }
  const previous = defaultRequestTimeoutMs;
  const previousCapacity = capacityRequestTimeoutMs;
  defaultRequestTimeoutMs = ms;
  // The capacity call has its own (shorter) budget, so it needs the same
  // escape hatch — otherwise a test that needs a slow capacity route to
  // answer would have no way to say so.
  capacityRequestTimeoutMs = ms;
  return () => {
    defaultRequestTimeoutMs = previous;
    capacityRequestTimeoutMs = previousCapacity;
  };
}

// Bulk live-status responses are reused for this long — see the plan's
// "list performance" note: multiple browser tabs/poll cycles hitting
// GET /api/sessions within the same short window shouldn't each cost this
// host its own HTTP round trip.
const LIVE_STATUS_CACHE_TTL_MS = 1_500;

// Issue #2255 — GET /api/sessions awaits every host's bulk live status, and a
// host that does not answer cost it the full request timeout on EVERY poll
// (and the pane of a just-created session waited behind two of those). Once a
// host has failed to answer, its next reads fail immediately with the same
// error and one background probe per cooldown checks whether it is back, with
// the normal request timeout (nothing waits on the probe, so a shorter budget
// would only turn a slow-but-alive host into a permanently "down" one): the
// list never waits on a dead host again, at the price of showing a recovered
// host as unreachable for at most one more cooldown.
const LIVE_STATUS_DOWN_COOLDOWN_MS = 10_000;

// A preview asset request (issue #28 phase 6) can legitimately take longer
// than REQUEST_TIMEOUT_MS's 5s — a dev server compiling a route on first
// request (Vite/webpack's on-demand compilation) is a real, non-error delay
// this proxy must not preempt.
const PREVIEW_REQUEST_TIMEOUT_MS = 30_000;

// Same reasoning as PREVIEW_REQUEST_TIMEOUT_MS above, for the same reason:
// a file upload (issue #68) can be up to MAX_UPLOAD_BYTES (25 MiB,
// session-upload.ts) — a real, non-error transfer time over a WAN/VPN link
// to a remote agent that REQUEST_TIMEOUT_MS's 5s is nowhere near generous
// enough for. 25 MiB needs ~3.5 Mbit/s to finish inside this window.
const UPLOAD_REQUEST_TIMEOUT_MS = 60_000;

// File-browser transfers (uploadProjectFile / downloadProjectFile) can run for
// minutes, so a TOTAL timeout would kill a healthy large transfer. This is an
// IDLE timeout instead: it re-arms on every chunk that moves, and only fires
// when the link has gone quiet for this long.
const TRANSFER_IDLE_TIMEOUT_MS = 30_000;
let transferIdleTimeoutMs = TRANSFER_IDLE_TIMEOUT_MS;
// Test escape hatch (same shape as overrideDefaultRequestTimeoutForTests): a
// stalled-agent test shouldn't have to wait half a minute of real time.
export function overrideTransferIdleTimeoutForTests(ms: number): () => void {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 2 ** 31 - 1) {
    throw new RangeError(`idle timeout override must be in (0, 2^31-1] ms, got ${ms}`);
  }
  const previous = transferIdleTimeoutMs;
  transferIdleTimeoutMs = ms;
  return () => {
    transferIdleTimeoutMs = previous;
  };
}

// #484 — the four new task-git proxy calls each wrap an agent-side git
// shell-out with its own timeout (git-push.ts/git-refs.ts/git-status.ts/
// git-worktree.ts), every one of which is already well above
// REQUEST_TIMEOUT_MS's 5s. Without an override here, this client would
// raise HostUnreachableError while the agent's own git call is still
// running — e.g. reporting push-failed on a branch that actually landed.
// Each constant below is the agent-side budget plus headroom, following the
// same "real, non-error delay this proxy must not preempt" reasoning as
// PREVIEW_REQUEST_TIMEOUT_MS/UPLOAD_REQUEST_TIMEOUT_MS above.
/** git-push.ts's GIT_TIMEOUT_MS is 120s (one `git push`, raised from 30s so
 * `--no-verify` doesn't have to also budget for a target repo's own
 * pre-push hook — see that file's header comment). Kept in lockstep with
 * that constant on purpose: falling behind it here is exactly the failure
 * mode this whole block's own comment warns against — reporting
 * push-failed/host-unreachable on a remote push that's still legitimately
 * running. */
const GIT_PUSH_REQUEST_TIMEOUT_MS = 140_000;
/** git-refs.ts's GIT_TIMEOUT_MS is 10s, and resolveDefaultBaseRef can run up
 * to 4 sequential git calls (fetch, symbolic-ref, 2x rev-parse candidates)
 * before this route's own resolveCommitSha adds a 5th. */
const GIT_BASE_REF_REQUEST_TIMEOUT_MS = 60_000;
/** git-worktree.ts's GIT_TIMEOUT_MS is 15s (one `git worktree add`). */
const GIT_WORKTREE_RESUME_REQUEST_TIMEOUT_MS = 20_000;
/** A bounded batch may resolve hundreds of paths on a slow agent filesystem. */
const WORKTREE_PATH_COMPARE_TIMEOUT_MS = 30_000;

// Issue #345 — a dock-preview worktree's checkout/force-remove/sync
// (`git worktree add`/`remove --force`/`reset --hard`) can take longer than
// REQUEST_TIMEOUT_MS's 5s on a large repo — the agent's own runGit already
// allows 15s (GIT_TIMEOUT_MS, git-worktree.ts) per invocation before it
// gives up. checkoutBranchWorktree (prune, then add) and removeWorktree
// (remove, then prune) each run TWO sequential runGit calls agent-side —
// worst case 2×15s = 30s BEFORE the agent even replies, so this timeout
// needs real headroom beyond that, not just beyond a single 15s call
// (Hermes review, this PR — the original 30s left zero headroom and could
// abort a request the instant before the agent's response arrived,
// orphaning a real worktree the primary never tracked: an unrecoverable
// leak, same class as the accepted restart-leak limitation). 45s gives 15s
// of margin for network RTT on top of the 30s agent-side worst case.
// Distinct from PREVIEW_REQUEST_TIMEOUT_MS (that one covers the browser
// dev-server proxy, an unrelated "preview" — dock-preview worktrees are a
// different feature despite the name collision).
const GIT_WORKTREE_REQUEST_TIMEOUT_MS = 45_000;

// Issue #1951 follow-up — the agent validates every root with a few stat/realpath
// calls on its own disk; a network share or a sleeping disk makes that slower
// than the default 5 s, and a timeout here would read as "host unreachable"
// for a save that may in fact have been applied.
const PROJECTS_ROOTS_REQUEST_TIMEOUT_MS = 15_000;

// Issue #1951 — `sessions.prompt` against a child on this host. The agent
// types the body, waits the adapter's submit delay (~150 ms), re-checks, then
// presses Enter, all under a per-session lock — so a queued prompt can wait
// behind another one. Its OWN constant: a timeout AFTER the body was typed
// leaves text sitting in the child's input box while the primary reports the
// host as unreachable, and the call is not idempotent (a retry would type it
// twice). Generous so that only a genuinely wedged agent trips it.
const SESSION_PROMPT_REQUEST_TIMEOUT_MS = 30_000;
// Issue #1951 — slack added to a remote output wait's own timeout so the
// request outlives the agent's wait by the network round trip, never the
// other way round.
const WAIT_OUTPUT_REQUEST_SLACK_MS = 10_000;

// Issue #1101 — deliberately its OWN constant, NOT a reuse of
// GIT_PUSH_REQUEST_TIMEOUT_MS or any other neighbor above: every existing
// timeout constant in this file tops out at GIT_PUSH_REQUEST_TIMEOUT_MS's
// 140s (one `git push`), nowhere near enough for a real, non-interactive
// agent CLI turn. scaffold-generate.ts's own DEFAULT_GENERATION_TIMEOUT_MS
// is 5 minutes (300_000ms) — the agent-side execFile budget for the turn
// itself — and /internal/run-generation-turn's own handler ALSO runs a
// worktree create (`git worktree add`) and a worktree remove + branch
// delete (`git worktree remove` + `git worktree prune` + a branch delete)
// around that turn, each its own `runGit` call at GIT_TIMEOUT_MS (15s,
// git-worktree.ts) — up to ~60s of additional, real, non-error time before
// and after the 5-minute turn itself.
//
// Derived from DEFAULT_GENERATION_TIMEOUT_MS (not a bare literal) so a
// future change to that constant can't silently shrink the margin below —
// a mullion-reviewer pass on PR #1134 found the original literal 420_000
// would have kept this margin fixed even if the turn budget it's meant to
// cover changed. Sized as the turn budget + 60s worktree lifecycle + 60s
// network/HTTP round-trip margin, the same "agent-side budget plus
// headroom" reasoning as GIT_PUSH_REQUEST_TIMEOUT_MS's own comment.
const GENERATION_TURN_WORKTREE_LIFECYCLE_MARGIN_MS = 60_000;
const GENERATION_TURN_NETWORK_MARGIN_MS = 60_000;
// Issue #2245 — the setup-recipe request outlives the run it carries by a
// network margin, the same "agent-side budget plus headroom" shape.
const SETUP_REQUEST_MARGIN_MS = 60_000;
const GENERATION_TURN_REQUEST_TIMEOUT_MS =
  DEFAULT_GENERATION_TIMEOUT_MS +
  GENERATION_TURN_WORKTREE_LIFECYCLE_MARGIN_MS +
  GENERATION_TURN_NETWORK_MARGIN_MS;

/** The run of private-mode set/reset sequences (`ESC[?<n>[;<n>…]h|l`) that
 * Session.getScrollback() prepends to the ring. */
// eslint-disable-next-line no-control-regex -- the escape byte is the point
const LEADING_PRIVATE_MODES = /^(?:\x1b\[\?\d+(?:;\d+)*[hl])+/;

export class RemoteHostClient {
  // Addressing, signing, SSRF pinning and the credential state (token / session
  // secret) live in the transport (remote-host-transport.ts); every fetch site
  // below takes its dispatcher and signature headers from it.
  private readonly transport: RemoteHostTransport;
  private readonly hostId: string;
  // The app, for opening streams over the outbound channel (#2571).
  private readonly channelApp?: FastifyInstance;

  private liveStatusCache: {
    key: string;
    ts: number;
    result: Record<string, SessionInfo | null>;
  } | null = null;
  // Concurrent misses on the same key (e.g. two browser tabs' list
  // requests landing in the same tick, before either has populated
  // liveStatusCache) share one HTTP call instead of each firing their own.
  private liveStatusInFlight = new Map<string, Promise<Record<string, SessionInfo | null>>>();
  // Set while the host is not answering live-status calls (#2255).
  private liveStatusDown: {
    error: HostUnreachableError;
    checkedAt: number;
    probing: boolean;
  } | null = null;

  constructor(opts: {
    hostId: string;
    baseUrl: string | null;
    token: string;
    sessionSecret?: string | null;
    refreshCredentials?: () => HostCredentials | null;
    resolveTransport?: (operation?: string) => HostTransport;
    channelApp?: FastifyInstance;
  }) {
    this.hostId = opts.hostId;
    this.transport = new RemoteHostTransport(opts);
    this.channelApp = opts.channelApp;
  }

  /**
   * How this host is reached for a request/response exchange (#2451, #2620);
   * see RemoteHostTransport.requestTransport.
   */
  private requestTransport(): HostTransport {
    return this.transport.requestTransport();
  }

  private request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs: number = defaultRequestTimeoutMs,
  ): Promise<T> {
    return this.transport.request<T>(path, init, timeoutMs);
  }

  // `request`, bound, for the git path builders in remote-host-git.ts.
  private readonly gitRequest: git.GitRequest = (path, init, timeoutMs) =>
    this.request(path, init, timeoutMs);

  discover(): Promise<DiscoveredCandidate[]> {
    return this.request("/internal/discover");
  }

  /**
   * Issue #1951 follow-up — saves (or, with `null`, removes) this agent's
   * project-roots override. The agent answers a refusal (locked, an unsafe or
   * missing directory) as HTTP 422 `{status, error}`; an agent build too old
   * to have the route answers 404.
   */
  resolveSetProjectsRoots(roots: string[] | null): Promise<AgentConfig> {
    return this.request(
      "/internal/projects-roots",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roots }),
      },
      PROJECTS_ROOTS_REQUEST_TIMEOUT_MS,
    );
  }

  // Issue #247 / roadmap 7.4 — see internal.ts's GET /internal/config for
  // what's (and isn't — no idle timeout, no DB-backed anything) included.
  resolveConfig(): Promise<AgentConfig> {
    return this.request("/internal/config");
  }

  /**
   * Issue #1721 / roadmap 8.7 — this agent's own capacity report.
   *
   * Returns null — NOT an error — when the agent answers 404, which is what
   * an agent build that predates the route does. "This build does not
   * report capacity" and "this host is broken" are different facts, and
   * only the second one may ever affect a health verdict (see
   * host-heartbeat.ts's sweep). Every other failure (timeout, unreachable,
   * 5xx) propagates to the caller, which decides what to do with it.
   */
  async resolveCapacity(): Promise<HostCapacityReport | null> {
    try {
      return await this.request<HostCapacityReport>(
        "/internal/capacity",
        undefined,
        capacityRequestTimeoutMs,
      );
    } catch (err) {
      if (err instanceof HostRequestError && err.statusCode === 404) return null;
      throw err;
    }
  }

  // Issue #647 / roadmap 7.8 — mirrors GET /internal/updates/status; see
  // that route's own comment for why it lives under /internal/ rather than
  // the primary's /api/updates/* path.
  getUpdateStatus(): Promise<UpdateStatus> {
    return this.request("/internal/updates/status");
  }

  applyUpdate(body: ApplyUpdateBody): Promise<{ phase: string; version: string }> {
    return this.request("/internal/updates/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  resolveActions(cwd: string): Promise<Launcher[]> {
    return this.request(`/internal/actions?cwd=${encodeURIComponent(cwd)}`);
  }

  resolveDock(cwd: string): Promise<DockControl[]> {
    return this.request(`/internal/dock?cwd=${encodeURIComponent(cwd)}`);
  }

  // U4 — the client half of the dock-config write triple; see
  // routes/internal.ts's /internal/dock-config for the agent-side
  // resolveWithinRoots containment these two rely on. Deliberately a
  // separate pair from resolveDock above, not a rename/reuse of it: that
  // route returns the MERGED view (global default + Docker-discovered
  // controls), the wrong shape for an editor to read back or write through
  // (see dock-config.ts's readDockConfig doc comment).
  resolveDockConfig(cwd: string): Promise<DockConfigReadResult> {
    return this.request(`/internal/dock-config?cwd=${encodeURIComponent(cwd)}`);
  }

  writeDockConfig(cwd: string, controls: DockControl[]): Promise<DockConfigReadResult> {
    return this.request(`/internal/dock-config?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ controls }),
    });
  }

  // Issue #431 — the client half of the agent-rules triple; see
  // routes/internal.ts's /internal/agent-rules for the agent-side
  // containment (resolveWithinRoots) these three all rely on.
  resolveAgentRules(cwd: string): Promise<AgentRuleTarget[]> {
    return this.request(`/internal/agent-rules?cwd=${encodeURIComponent(cwd)}`);
  }

  // Issue #431, Hermes review on PR #458 — a names-only counterpart for the
  // sidebar's per-project indicator, so GET /api/projects's ruleFiles field
  // doesn't pull full file content (up to 512KB x 12 targets) for a remote
  // project on every poll — see /internal/agent-rules/exists's own comment.
  resolveExistingRuleFileNames(cwd: string): Promise<string[]> {
    return this.request(`/internal/agent-rules/exists?cwd=${encodeURIComponent(cwd)}`);
  }

  /** The sub-directories of `path` on THIS host's filesystem — the Add project
   * folder picker for a remote host (GET /internal/fs/dirs). */
  listDirectories(path: string, hidden: boolean): Promise<DirectoryListing> {
    return this.request(
      `/internal/fs/dirs?path=${encodeURIComponent(path)}${hidden ? "&hidden=1" : ""}`,
    );
  }

  writeAgentRule(cwd: string, target: string, content: string): Promise<AgentRuleTarget> {
    return this.request(
      `/internal/agent-rules/${encodeURIComponent(target)}?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
    );
  }

  deleteAgentRule(cwd: string, target: string): Promise<void> {
    return this.request(
      `/internal/agent-rules/${encodeURIComponent(target)}?cwd=${encodeURIComponent(cwd)}`,
      { method: "DELETE" },
    );
  }

  detectAgents(): Promise<DetectedAgent[]> {
    return this.request("/internal/agents");
  }

  // Issue #2306 — an agent build without the route answers 404 (unknown).
  detectCapabilities = (): Promise<{ capabilities: string[] }> =>
    this.request("/internal/capabilities");

  // Issue #2248 — the protocol handshake; an agent build without it answers 404.
  detectProtocol = (): Promise<AgentProtocolInfo> => this.request("/internal/protocol");

  // Issue #432 — the client half of the skills-discovery triple; see
  // routes/internal.ts's /internal/skills for the agent-side resolveWithinRoots
  // containment this relies on, same as resolveAgentRules above.
  resolveSkills(cwd: string): Promise<SkillInfo[]> {
    return this.request(`/internal/skills?cwd=${encodeURIComponent(cwd)}`);
  }

  // Forwards the dashboard's resolved terminal palette so this agent can answer
  // its sessions' startup color queries (see terminal-query-reply.ts).
  async setTerminalPalette(palette: TerminalPalette): Promise<void> {
    await this.request<void>("/internal/terminal/palette", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(palette),
    });
  }

  // Issue #463 — the client half of the skills enable/disable triple; see
  // routes/internal.ts's PUT /internal/skills. Same body-only
  // {agent, name, enabled} contract as writeAgentRule above.
  writeSkillEnabled(
    cwd: string,
    agent: SkillAgent,
    name: string,
    enabled: boolean,
  ): Promise<SkillInfo> {
    return this.request(`/internal/skills?cwd=${encodeURIComponent(cwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, name, enabled }),
    });
  }

  resolveGitHubRepo(cwd: string): Promise<GitHubRepoRef | null> {
    return git.resolveGitHubRepo(this.gitRequest, cwd);
  }

  resolveGitBranch(cwd: string): Promise<string | null> {
    return git.resolveGitBranch(this.gitRequest, cwd);
  }

  /** Mirrors `/internal/git-status`'s `{ isRepo, status }` shape exactly (see
   * that route's own comment) — `isRepo: false` is durable "not a repo",
   * `isRepo: true, status: null` is a transient `git status` failure on the
   * agent side. Callers must not collapse these back into a single
   * `GitStatus | null` — that's the exact ambiguity this shape exists to
   * avoid. `opts.fresh` (#484) requests the same cache-bypassing read
   * task-promote.ts's local dirty-tree gate already uses — a stale "clean"
   * result could let a push silently exclude work committed moments ago
   * (see the route's own comment). Every existing caller (sidebar
   * polls) omits it and keeps the cached read, at the default timeout. */
  resolveGitStatus(cwd: string, opts?: { fresh?: boolean }): Promise<GitStatusResult> {
    return git.resolveGitStatus(this.gitRequest, cwd, opts);
  }

  /** Local branches + worktrees (issue #162), plus remote-tracking branches
   * (issue #271's base-ref picker) for a remote-hosted project's Source Control —
   * same reasoning as resolveGitStatus above. `detail` (issue #442) mirrors
   * the public route's `?detail=1` — omitted (not `&detail=0`) when falsy,
   * matching every other optional query param in this file. */
  resolveGitBranches(
    cwd: string,
    detail?: boolean,
  ): Promise<{
    branches: GitBranchInfo[];
    worktrees: GitWorktreeInfo[];
    remoteBranches: string[];
    // Issue #271 follow-up — absent on an older agent build that predates
    // this field (same degradation convention as the rest of this file's
    // optional response fields); `null` when the agent resolved it and
    // found no usable default. Both cases mean "the caller should fall
    // back to the current branch."
    defaultBranch?: string | null;
  } | null> {
    return git.resolveGitBranches(this.gitRequest, cwd, detail);
  }

  /** Creates a worktree on this agent's own filesystem (issue #271's
   * launcher-toggle/promote flows) — mirrors /internal/git-worktree's
   * `{cwd, baseRef, seed, branchName?}` -> `CreateWorktreeResult` shape
   * (issue #677: `{created, path?, branch?, reason?, detail?}`, not a bare
   * `{path, branch} | null`). Unlike the read-only git methods above, a
   * `created: false` result here isn't folded into an empty/absent value by
   * the caller — it means creation genuinely failed and the caller
   * (session-lifecycle.ts) must not proceed to spawn a session against a
   * worktree that doesn't exist. Passes GIT_WORKTREE_REQUEST_TIMEOUT_MS
   * explicitly (Hermes-style fix found during #677's research) — this was
   * previously the only worktree-creating RPC on this client left at the
   * 5s REQUEST_TIMEOUT_MS default, unlike its local-host counterpart
   * (createWorktree's own GIT_TIMEOUT_MS = 15s) and its sibling
   * resolveCheckoutBranchWorktree below (already on this same 45s budget),
   * so a slow-but-legitimate remote `git worktree add` could time out here
   * well before the git call itself would have. */
  resolveCreateWorktree(
    cwd: string,
    baseRef: string,
    seed: string,
    branchName?: string,
  ): Promise<CreateWorktreeResult> {
    return this.request(
      "/internal/git-worktree",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, baseRef, seed, branchName }),
      },
      GIT_WORKTREE_REQUEST_TIMEOUT_MS,
    );
  }

  /** Removes a task worktree on this agent's own filesystem — only when
   * clean (issue #283). Mirrors /internal/git-worktree/remove's
   * `{worktreePath, parentCwd?}` -> `RemoveIfCleanResult` shape. */
  resolveRemoveWorktreeIfClean(
    worktreePath: string,
    parentCwd?: string,
  ): Promise<RemoveIfCleanResult> {
    return this.request("/internal/git-worktree/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreePath, parentCwd }),
    });
  }

  /** Checks out an EXISTING branch into a fresh detached-HEAD worktree on
   * this agent's own filesystem — the dock-preview flow (issue #345).
   * Mirrors /internal/git-worktree/checkout's `{cwd, branch}` ->
   * `{path, branch} | null` shape. Distinct from resolveCreateWorktree
   * above (a NEW branch from a baseRef). */
  resolveCheckoutBranchWorktree(
    cwd: string,
    branch: string,
  ): Promise<{ path: string; branch: string } | null> {
    return this.request(
      "/internal/git-worktree/checkout",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      },
      GIT_WORKTREE_REQUEST_TIMEOUT_MS,
    );
  }

  /** Force-removes a dock-preview worktree on this agent's own filesystem
   * (issue #345) — mirrors /internal/git-worktree/force-remove's
   * `{worktreePath, parentCwd?}` -> `{removed: boolean}` shape. Distinct
   * from resolveRemoveWorktreeIfClean above (never `--force`). */
  async resolveRemoveWorktree(worktreePath: string, parentCwd?: string): Promise<boolean> {
    const result = await this.request<{ removed: boolean }>(
      "/internal/git-worktree/force-remove",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreePath, parentCwd }),
      },
      GIT_WORKTREE_REQUEST_TIMEOUT_MS,
    );
    return result.removed;
  }

  /** Resets a dock-preview worktree on this agent's own filesystem to the
   * current tip of a LOCAL branch ref (issue #345's worktreeRefresh
   * live-sync tick) — mirrors /internal/git-worktree/sync's
   * `{worktreePath, branch}` -> `{synced: boolean}` shape. */
  async resolveSyncWorktree(worktreePath: string, branch: string): Promise<boolean> {
    const result = await this.request<{ synced: boolean }>(
      "/internal/git-worktree/sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worktreePath, branch }),
      },
      GIT_WORKTREE_REQUEST_TIMEOUT_MS,
    );
    return result.synced;
  }

  /** Removes the explicitly-named orphan task worktrees in `orphanPaths` on
   * this agent's own filesystem (issue #283) — mirrors
   * /internal/git-worktree/prune's `{cwd, orphanPaths}` ->
   * `PruneWorktreesResult` shape. See git-worktree.ts's pruneWorktrees doc
   * comment for why this takes an explicit delete list rather than
   * figuring out orphans on the agent side. */
  resolvePruneWorktrees(cwd: string, orphanPaths: string[]): Promise<PruneWorktreesResult> {
    return this.request("/internal/git-worktree/prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, orphanPaths }),
    });
  }

  /** task-claim.ts's pre-claim orphan clearing on this agent's own
   * filesystem (issue #283) — mirrors
   * /internal/git-worktree/clear-orphan's `{cwd, worktreePath, branchName}`
   * -> `ClearOrphanedTaskWorktreeResult` shape. */
  resolveClearOrphanedTaskWorktree(
    cwd: string,
    worktreePath: string,
    branchName: string,
  ): Promise<ClearOrphanedTaskWorktreeResult> {
    return this.request("/internal/git-worktree/clear-orphan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, worktreePath, branchName }),
    });
  }

  /** Deletes a local branch on this agent's own filesystem (issue #442) —
   * mirrors /internal/git-branch-delete's `{cwd, name, force?}` ->
   * `DeleteBranchResult` shape. Always 200 with a reason envelope, never a
   * 5xx for a git-level refusal (see that route's own comment). */
  resolveDeleteBranch(cwd: string, name: string, force?: boolean): Promise<DeleteBranchResult> {
    return this.request("/internal/git-branch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, name, force }),
    });
  }

  /** Removes any worktree `git worktree list` itself reports on this
   * agent's own filesystem (issue #442) — mirrors
   * /internal/git-worktree/remove-listed's `{cwd, worktreePath, force?}` ->
   * `RemoveListedWorktreeResult` shape. Unlike resolveRemoveWorktreeIfClean
   * above, not scoped to task worktrees — see git-worktree.ts's
   * removeListedWorktree doc comment. */
  resolveRemoveListedWorktree(
    cwd: string,
    worktreePath: string,
    force?: boolean,
  ): Promise<RemoveListedWorktreeResult> {
    return this.request("/internal/git-worktree/remove-listed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, worktreePath, force }),
    });
  }

  /** Clears stale worktree administrative metadata (`git worktree prune`)
   * on this agent's own filesystem (issue #442) — mirrors
   * /internal/git-worktree/prune-metadata's `{cwd}` -> `{pruned: boolean}`
   * shape. Never removes a worktree that still exists on disk. */
  resolvePruneWorktreeMetadata(cwd: string): Promise<{ pruned: boolean }> {
    return this.request("/internal/git-worktree/prune-metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
  }

  /** Diff stats (issue #202) for a session's effective cwd on a remote host
   * — mirrors resolveGitStatus's `{ isRepo, stats }` shape for the same
   * "durable not-a-repo vs. transient git failure" reason. Passes an
   * optional `baseRef` (e.g. `origin/main`) so the diff is computed against
   * the merge-base of that ref instead of just HEAD (issue #262 follow-up). */
  resolveGitDiffStats(
    cwd: string,
    baseRef?: string,
    opts: { fresh?: boolean } = {},
  ): Promise<{ isRepo: boolean; stats: GitDiffStats | null; baseResolved?: boolean }> {
    return git.resolveGitDiffStats(this.gitRequest, cwd, baseRef, opts);
  }

  /** Per-file unified diff (issue #262) for a remote-hosted session's cwd —
   * runs `git diff [base]...HEAD -- <path>` on this agent's filesystem.
   * Returns `{ patch }` where `patch` is the raw unified diff text or null. */
  resolveGitFileDiff(
    cwd: string,
    filePath: string,
    baseRef?: string,
  ): Promise<{ patch: string | null }> {
    return git.resolveGitFileDiff(this.gitRequest, cwd, filePath, baseRef);
  }

  /** Commit history (issue #1969) for a remote-hosted project's Git view —
   * mirrors /internal/git-log. `worktree` scopes it to one of the project's
   * worktrees; the agent answers `forbidden: true` when it isn't one. */
  resolveGitLog(
    cwd: string,
    opts: { worktree?: string; skip: number; limit: number; scope: "all" | "head" },
  ): Promise<{ commits: CommitLogEntry[] | null; forbidden?: boolean }> {
    return git.resolveGitLog(this.gitRequest, cwd, opts);
  }

  /** One commit's message and changed files — mirrors /internal/git-commit. */
  resolveGitCommit(
    cwd: string,
    sha: string,
    worktree?: string,
  ): Promise<{ detail: CommitDetail | null; forbidden?: boolean }> {
    return git.resolveGitCommit(this.gitRequest, cwd, sha, worktree);
  }

  /** One file's patch within a commit — mirrors /internal/git-commit-file. */
  resolveGitCommitFile(
    cwd: string,
    sha: string,
    filePath: string,
    worktree?: string,
  ): Promise<{ patch: string | null; forbidden?: boolean }> {
    return git.resolveGitCommitFile(this.gitRequest, cwd, sha, filePath, worktree);
  }

  /** Runs `git fetch origin` on this agent's filesystem (issue #369 —
   * background auto-fetch and manual fetch button). Returns
   * `{ success, error? }` so the caller can distinguish a git-level failure
   * from a host-reachability 5xx.
   *
   * `skipped: true` means the clone was busy — a repair was working on it
   * (issue #1896) — so the fetch did not run. That is not a failure, and the
   * caller must not report it as one. */
  resolveGitFetch(
    cwd: string,
    token?: string,
  ): Promise<{ success: boolean; error?: string; skipped?: boolean }> {
    return git.resolveGitFetch(this.gitRequest, cwd, token);
  }

  /** Issue #1851 — the READ-ONLY clone health check on this agent's
   * filesystem. Returns the doctor's CloneHealth shape.
   *
   * Its own timeout: the agent-side check runs `git fsck`, which has a 30s
   * budget of its own — see GIT_HEALTH_REQUEST_TIMEOUT_MS above. */
  resolveGitHealth(cwd: string): Promise<CloneHealth> {
    return git.resolveGitHealth(this.gitRequest, cwd);
  }

  /** Issue #1896 — the clone REPAIR on this agent's filesystem, and the
   * read-only PLAN of what it would do.
   *
   * Without `confirm` the agent returns the plan (computed from reads only —
   * nothing is touched); with `confirm: true` it runs the repair and returns
   * what it actually did.
   *
   * Its own timeout: the repair does more than the check — quarantine, a
   * `git fetch origin --prune`, the index rebuild and a second `git fsck` —
   * and the doctor's per-git-call budget is 30s, so the worst case is several
   * calls' worth. The default 5s would abandon the request and report a
   * healthy host as unreachable — see GIT_REPAIR_REQUEST_TIMEOUT_MS above. */
  resolveGitRepair(
    cwd: string,
    opts: { confirm?: boolean } = {},
  ): Promise<RepairPlan | RepairOutcome> {
    return git.resolveGitRepair(this.gitRequest, cwd, opts);
  }

  /** Runs a fast-forward `git pull` on this agent's filesystem (issue #745).
   * Returns `{ pulled: boolean, reason?, detail? }` matching runGitPull's
   * GitPullResult shape. */
  resolveGitPull(cwd: string): Promise<GitPullResult> {
    return git.resolveGitPull(this.gitRequest, cwd);
  }

  /** The guarded checkout / create / rebase on this agent's filesystem
   * (issue #1672) — mirror /internal/git-checkout, /internal/git-branch-create
   * and /internal/git-rebase, each returning git-branch-ops.ts's
   * GitBranchOpResult. */
  resolveGitCheckout(cwd: string, branch: string): Promise<GitBranchOpResult> {
    return git.resolveGitCheckout(this.gitRequest, cwd, branch);
  }

  resolveGitBranchCreate(
    cwd: string,
    name: string,
    startPoint: string,
    checkout?: boolean,
  ): Promise<GitBranchOpResult> {
    return git.resolveGitBranchCreate(this.gitRequest, cwd, name, startPoint, checkout);
  }

  resolveGitRebase(cwd: string, onto?: string): Promise<GitBranchOpResult> {
    return git.resolveGitRebase(this.gitRequest, cwd, onto);
  }

  /** Resolves this agent's default base ref (and its pinned commit SHA) on
   * its own filesystem (#484) — mirrors /internal/git-base-ref's
   * `{ baseRef, sha }` shape. `resolveDefaultBaseRef` runs `git fetch
   * origin` first, hence the raised timeout — see the constant's own
   * comment. Never throws for a git-level failure: a non-repo cwd resolves
   * `{ baseRef: "HEAD", sha: null }`, the same last-resort fallback the
   * local path produces. */
  resolveHostBaseRef(cwd: string): Promise<{ baseRef: string; sha: string | null }> {
    return this.request(
      `/internal/git-base-ref?cwd=${encodeURIComponent(cwd)}`,
      undefined,
      GIT_BASE_REF_REQUEST_TIMEOUT_MS,
    );
  }

  /** Pushes a task's branch to `origin` on this agent's own filesystem
   * (#484) — mirrors /internal/git-push's `PushResult` shape. `cwd` must be
   * the task's worktree path, not the bare project root — see that route's
   * own comment. The token crosses once, over this already-signed,
   * IP-pinned channel; never logged by this method or the route it calls. */
  resolvePushBranch(cwd: string, branch: string, token: string): Promise<PushResult> {
    return this.request(
      "/internal/git-push",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch, token }),
      },
      GIT_PUSH_REQUEST_TIMEOUT_MS,
    );
  }

  /** Clones `url` into the first PROJECTS_ROOTS entry of this agent's
   * filesystem as `<root>/<name>` — mirrors /internal/git-clone's
   * `CloneResult` shape. The optional read token crosses once, over this
   * already-signed, IP-pinned channel; never logged by this method or the
   * route it calls. */
  resolveGitClone(url: string, name: string, token?: string): Promise<CloneResult> {
    return git.resolveGitClone(this.gitRequest, url, name, token);
  }

  /** Reads `paths`' current content directly off this agent's own
   * filesystem (#895) — mirrors /internal/read-files' `{cwd, paths}` ->
   * `{files: Record<string, string|undefined>}` shape. A path absent from
   * the returned record (or mapped to `undefined`) means "doesn't exist on
   * this host yet" — the same "missing key = absent" convention
   * computeScaffold's own `existingFiles` parameter already uses locally
   * (mullion-scaffold.ts). */
  async readFiles(cwd: string, paths: string[]): Promise<Record<string, string | undefined>> {
    const result = await this.request<{ files: Record<string, string | undefined> }>(
      "/internal/read-files",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, paths }),
      },
    );
    return result.files;
  }

  /** Writes `entries` (files and/or symlinks) onto this agent's own
   * filesystem, optionally staging every change afterward via `git add -A`
   * (#895) — mirrors /internal/write-files' `{cwd, entries, stage?}` ->
   * `{ok: true}` shape. See host-files.ts's writeHostFiles doc comment for
   * why `stage` is a named, explicit opt-in rather than baked in
   * unconditionally, and for why BOTH ScaffoldEntry variants (file and
   * symlink) are supported remotely, not rejected. */
  async writeFiles(cwd: string, entries: ScaffoldEntry[], stage?: boolean) {
    return this.request<{ ignored?: unknown }>("/internal/write-files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, entries, stage }),
    });
  }

  /** Project file editor (routes/project-files.ts) — directory listing,
   * file read and in-place write on this agent's own filesystem. Mirrors
   * /internal/project-files/{list,read,write}; the agent replies with a
   * structured `code` on a ProjectFileError, which the primary route reads
   * off HostRequestError.body. */
  async listProjectDir(cwd: string, relPath: string): Promise<ProjectDirListing> {
    return this.request<ProjectDirListing>("/internal/project-files/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: relPath }),
    });
  }

  async readProjectFile(cwd: string, relPath: string): Promise<ProjectFileContent> {
    return this.request<ProjectFileContent>("/internal/project-files/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: relPath }),
    });
  }

  async statProjectFile(cwd: string, relPath: string): Promise<ProjectFileStat> {
    return this.request<ProjectFileStat>("/internal/project-files/stat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: relPath }),
    });
  }

  async writeProjectFile(
    cwd: string,
    relPath: string,
    content: string,
    opts: { expectedMtimeMs?: number; create?: boolean } = {},
  ): Promise<ProjectFileWriteResult> {
    return this.request<ProjectFileWriteResult>("/internal/project-files/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: relPath, content, ...opts }),
    });
  }

  async makeProjectDir(cwd: string, relPath: string): Promise<{ path: string }> {
    return this.request<{ path: string }>("/internal/project-files/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: relPath }),
    });
  }

  async deleteProjectPath(cwd: string, relPath: string): Promise<{ path: string }> {
    return this.request<{ path: string }>("/internal/project-files/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, path: relPath }),
    });
  }

  async renameProjectPath(cwd: string, from: string, to: string): Promise<{ path: string }> {
    return this.request<{ path: string }>("/internal/project-files/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, from, to }),
    });
  }

  /**
   * Streams a file upload to this agent's /internal/project-files/upload.
   * The body is piped through, never buffered, under an idle (not total)
   * timeout. No 401 retry: the body stream is single-use, so a stale-credential
   * failure surfaces to the caller instead of being replayed.
   */
  async uploadProjectFile(
    cwd: string,
    relPath: string,
    body: Readable,
    opts: { mkdirs?: boolean; declaredBytes?: number } = {},
  ): Promise<{ path: string; size: number }> {
    const query = new URLSearchParams({ cwd, path: relPath });
    if (opts.mkdirs) query.set("mkdirs", "1");
    const requestTarget = `/internal/project-files/upload?${query.toString()}`;
    const t = this.requestTransport();
    if (t.kind !== "inbound") {
      return uploadOverChannel(this.hostId, t, requestTarget, body, transferIdleTimeoutMs, opts);
    }
    return uploadInbound(this.transport, requestTarget, body, transferIdleTimeoutMs);
  }

  /**
   * Opens a streamed download from this agent's /internal/project-files/
   * download. Resolves once the agent has accepted the request (every refusal
   * — not found, too large, a directory — is a HostRequestError thrown
   * BEFORE any byte is returned); the bytes then flow through `stream` under
   * an idle timeout. One 401 retry with refreshed credentials, as request().
   */
  async downloadProjectFile(
    cwd: string,
    relPath: string,
  ): Promise<{ stream: Readable; size: number | null; path: string; name: string }> {
    const t = this.requestTransport();
    if (t.kind !== "inbound") {
      return downloadOverChannel(this.hostId, t, cwd, relPath, transferIdleTimeoutMs);
    }
    return downloadInbound(this.transport, cwd, relPath, transferIdleTimeoutMs);
  }

  async searchProjectFiles(cwd: string, query: string): Promise<ProjectSearchListing> {
    return this.request<ProjectSearchListing>("/internal/project-files/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, query }),
    });
  }

  /** Reports whether a Mullion scaffold is actually committed under `cwd`
   * on this agent's own filesystem (#1124) — mirrors
   * /internal/scaffold-scan's `{cwd}` -> `{skillCommitted, reviewerCommitted, warnings}`
   * shape. See session-lifecycle.ts's discoverCommittedScaffoldOnHost for
   * the caller-side dispatch this backs, and discoverCommittedScaffold's own
   * doc comment for what "committed" means here. */
  async scaffoldScan(
    cwd: string,
  ): Promise<{ skillCommitted: boolean; reviewerCommitted: boolean; warnings: string[] }> {
    return this.request("/internal/scaffold-scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
  }

  /** Reads this agent's own persisted "bundle disabled" flag (#1089) —
   * mirrors /internal/bundle-sync/status' `{disabled}` shape. A single
   * local JSON-file read on the agent side, so the default timeout is
   * fine. Named distinctly from bundle-sync.ts's own (unrelated, local-only)
   * `getBundleSyncStatus` to avoid confusion between the two. */
  async getAgentBundleState(): Promise<{ disabled: boolean }> {
    return this.request("/internal/bundle-sync/status");
  }

  /** Disables (or re-enables) bundle sync on this agent's own filesystem
   * and, when disabling, removes previously-installed bundle content
   * (#1089) — mirrors /internal/bundle-sync/remove's `{disabled}` ->
   * `{removed, legacySwept}` shape. See agent-bundle-state.ts's
   * removeHostBundle for the caller-side dispatch this backs.
   *
   * Cost differs by direction (Hermes review, PR #1151 — this comment
   * used to call both branches uniformly "fast/cheap"): `disabled: true`
   * is a JSON-file write plus a manifest-driven filesystem sweep, cheap by
   * construction. `disabled: false` (issue #1128) now also runs a full
   * `runBundleSyncExclusive(true)` reinstall across all four CLI roots
   * plus content hashing — real work, not the trivial write the old
   * comment implied. Still synchronous, local-disk-only (no network, no
   * subprocess), so it comfortably clears the default timeout in the
   * ordinary case; a host with an unusually large bundle or a genuinely
   * slow disk could in principle push closer to it, at which point this
   * client sees a spurious "unreachable" even though the agent completes
   * the install anyway (see plugins/bundle-sync.ts's reenableAgentBundles
   * for how that log-only symptom is handled). */
  async removeAgentBundle(disabled = true): Promise<{ removed: number; legacySwept: number }> {
    return this.request("/internal/bundle-sync/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
  }

  /** Salvages uncommitted work in `cwd` on this agent's own filesystem into
   * a single commit (#895) — mirrors /internal/git-commit-wip's `{cwd,
   * message?}` -> `CommitWipChangesResult` shape. See git-worktree.ts's
   * commitWipChanges doc comment for the staging/no-op/never-throws
   * contract this preserves over the wire. */
  resolveCommitWipChanges(
    cwd: string,
    message?: string,
    gitIdentity?: GitIdentity,
  ): Promise<CommitWipChangesResult> {
    return this.request("/internal/git-commit-wip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, message, gitIdentity }),
    });
  }

  /** Resyncs a stale task worktree on this agent's filesystem — mirrors
   * /internal/git-resync-stale's `{cwd, branch}` -> `ResyncStaleWorktreeResult`.
   * See git-worktree.ts's resyncStaleWorktree for the safety condition. */
  resolveResyncStaleWorktree(cwd: string, branch: string): Promise<ResyncStaleWorktreeResult> {
    return this.request("/internal/git-resync-stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, branch }),
    });
  }

  /** Runs one non-interactive generation-agent CLI turn end-to-end
   * (scratch-worktree create -> sandboxed spawn -> teardown) on this
   * agent's own filesystem (#1101) — mirrors
   * /internal/run-generation-turn's `{cwd, slug, baseRef, agentCommand,
   * prompt, timeoutMs}` -> `GenerationTurnResult` shape. Unlike this file's
   * other RPCs, an agent-side APPLICATION-level failure (an unsupported
   * agent CLI, the scratch worktree failing to create, the spawn itself
   * failing) is never reported via HTTP status — the whole response is
   * always 200 with a discriminated `outcome` field instead (see
   * GenerationTurnResult's own doc comment, scaffold-generate.ts, for why:
   * `viaRemote`'s HostRequestError mapping only distinguishes a 404 from
   * "everything else", which would collapse those three distinguishable
   * error classes into one indistinguishable bucket if they were carried
   * as HTTP status here instead). `GENERATION_TURN_REQUEST_TIMEOUT_MS` (see
   * that constant's own comment) is this call's own, independently-sized
   * network timeout — always well above whatever `timeoutMs` this call
   * forwards in the body, which only bounds the AGENT's own execFile. */
  resolveRunGenerationTurn(
    cwd: string,
    slug: string,
    baseRef: string,
    agentCommand: string,
    prompt: string,
    timeoutMs: number,
  ): Promise<GenerationTurnResult> {
    return this.request(
      "/internal/run-generation-turn",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, slug, baseRef, agentCommand, prompt, timeoutMs }),
      },
      GENERATION_TURN_REQUEST_TIMEOUT_MS,
    );
  }

  /** Runs a project's setup recipe on this agent (#2245) — mirrors
   * /internal/run-setup's `{cwd, recipe, logKey}` -> `SetupRunResult`.
   * Like run-generation-turn, an application-level failure is a 200 `outcome`,
   * not an HTTP status. The request timeout is the run's budget plus a margin. */
  resolveRunSetup(cwd: string, recipe: string, logKey: string): Promise<SetupRunResult> {
    return this.request(
      "/internal/run-setup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, recipe, logKey }),
      },
      DEFAULT_SETUP_TIMEOUT_MS + SETUP_REQUEST_MARGIN_MS,
    );
  }

  /** The tail of a setup log on this agent (#2245). */
  resolveSetupLog(logKey: string): Promise<{ content: string; truncated: boolean }> {
    return this.request(`/internal/setup-log?logKey=${encodeURIComponent(logKey)}`);
  }

  /** Lists this agent's own on-disk task-worktree directories (#484) — for
   * the primary's boot-time orphan sweep (plugins/task-watcher.ts). Mirrors
   * /internal/git-worktree/task-dirs's `{ dirs }` shape; a pure filesystem
   * read, so the default timeout is fine. */
  async resolveTaskWorktreeDirs(cwd: string): Promise<string[]> {
    const result = await this.request<{ dirs: string[] }>(
      `/internal/git-worktree/task-dirs?cwd=${encodeURIComponent(cwd)}`,
    );
    return result.dirs;
  }

  /** Checks out an existing `mullion/task-<id>-<slug>` branch into a fresh
   * worktree on this agent's own filesystem (#484) — for Retry (#483) on a
   * remote-hosted task. Mirrors /internal/git-worktree/resume's
   * `WorktreeResult | null` shape; `null` (not thrown) means the resume
   * failed for a git-level reason, same "not applicable, not unreachable"
   * posture as resolveCreateWorktree above. */
  resolveResumeTaskWorktree(cwd: string, branchName: string): Promise<WorktreeResult | null> {
    return this.request(
      "/internal/git-worktree/resume",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branchName }),
      },
      GIT_WORKTREE_RESUME_REQUEST_TIMEOUT_MS,
    );
  }

  /** #2246 — re-send a session's GitHub token before it expires. The route
   * 404s for a session the host no longer tracks, which is reported like any
   * other failed request. */
  async sendSessionGithubAuth(sessionId: string, auth: SessionGithubAuth): Promise<void> {
    await this.request(`/internal/sessions/${encodeURIComponent(sessionId)}/github-auth`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(auth),
    });
  }

  async spawn(opts: SpawnSessionOptions): Promise<SpawnResult> {
    return this.request("/internal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
  }

  /**
   * `opts.fresh` (issue #1962) skips both the 1.5 s result cache and the
   * in-flight sharing, so the answer cannot predate this call. A wait that
   * follows a prompt needs that: a cached read from just before the prompt
   * can still say the PREVIOUS turn `finished`, and would satisfy the wait
   * before the prompted turn ran. A fresh read leaves the cache alone: it is
   * keyed to one id, and writing it would evict the multi-id entry the
   * dashboard's list poll shares every few seconds.
   */
  async bulkLiveStatus(
    ids: string[],
    idleThresholdMs: number,
    sessionProjectIds?: Record<string, number>,
    opts: { fresh?: boolean } = {},
  ): Promise<Record<string, SessionInfo | null>> {
    if (ids.length === 0) return Object.create(null);
    const key =
      [...ids].sort().join(",") + `|${idleThresholdMs}|${JSON.stringify(sessionProjectIds || {})}`;
    if (opts.fresh === true) {
      const result = await this.request<Record<string, SessionInfo | null>>(
        "/internal/sessions/live",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, idleThresholdMs, sessionProjectIds }),
        },
      );
      // The host just answered: it is not down, whatever the last probe said.
      this.liveStatusDown = null;
      return result;
    }
    if (
      this.liveStatusCache &&
      this.liveStatusCache.key === key &&
      Date.now() - this.liveStatusCache.ts < LIVE_STATUS_CACHE_TTL_MS
    ) {
      return this.liveStatusCache.result;
    }
    const down = this.liveStatusDown;
    if (down) {
      if (!down.probing && Date.now() - down.checkedAt >= LIVE_STATUS_DOWN_COOLDOWN_MS) {
        down.probing = true;
        this.fetchLiveStatus(ids, idleThresholdMs, sessionProjectIds, key).then(
          () => {},
          () => {},
        );
      }
      throw down.error;
    }
    const inFlight = this.liveStatusInFlight.get(key);
    if (inFlight) return inFlight;
    return this.fetchLiveStatus(ids, idleThresholdMs, sessionProjectIds, key);
  }

  private fetchLiveStatus(
    ids: string[],
    idleThresholdMs: number,
    sessionProjectIds: Record<string, number> | undefined,
    key: string,
  ): Promise<Record<string, SessionInfo | null>> {
    const promise = this.request<Record<string, SessionInfo | null>>("/internal/sessions/live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, idleThresholdMs, sessionProjectIds }),
    })
      .then((result) => {
        this.liveStatusCache = { key, ts: Date.now(), result };
        this.liveStatusDown = null;
        return result;
      })
      .catch((err: unknown) => {
        // Only "did not answer" counts as down; a host that answered with an
        // error (HostRequestError) is up and keeps being asked.
        this.liveStatusDown =
          err instanceof HostUnreachableError
            ? { error: err, checkedAt: Date.now(), probing: false }
            : null;
        throw err;
      })
      .finally(() => {
        this.liveStatusInFlight.delete(key);
      });
    this.liveStatusInFlight.set(key, promise);
    return promise;
  }

  compareWorktreePaths(
    target: string,
    candidates: { id: string; cwd: string | null }[],
  ): Promise<unknown> {
    return this.request(
      "/internal/worktrees/compare-paths",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, candidates }),
      },
      WORKTREE_PATH_COMPARE_TIMEOUT_MS,
    );
  }

  bulkIsMasterAlive(ids: string[]): Promise<Record<string, boolean>> {
    if (ids.length === 0) return Promise.resolve(Object.create(null));
    return this.request("/internal/sessions/liveness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  }

  async terminate(id: string): Promise<void> {
    await this.request(`/internal/sessions/${encodeURIComponent(id)}/terminate`, {
      method: "POST",
    });
  }

  /**
   * Delivers a review-gate decision (issue #178) to whichever host actually
   * holds the pending hook connection — the agent's own
   * /internal/sessions/:id/review-gate, mirroring
   * /internal/sessions/:id/terminate's shape but with a real JSON response
   * body (`{ok}`) rather than a bare 204, since the caller needs to know
   * whether a gate was actually pending to resolve.
   */
  async resolveReviewGate(
    id: string,
    gateId: string | undefined,
    decision: "approved" | "denied",
    reason?: string,
  ): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>(
      `/internal/sessions/${encodeURIComponent(id)}/review-gate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason, gateId }),
      },
    );
    return result.ok;
  }

  /**
   * Clears non-blocking attention (issue #1472) on whichever agent actually
   * tracks this session's live PtyManager state — the agent's own
   * /internal/sessions/:id/attention/ack, mirroring resolveReviewGate's
   * shape exactly (same `{ok}` body, same POST-with-no-meaningful-body
   * request). A 404 here (an OLDER agent that predates this route
   * entirely) surfaces as an ordinary HostRequestError from request()
   * below, same as any other 4xx — session-backend.ts's RemoteBackend lets
   * it propagate unchanged, and routes/sessions.ts's ack route maps any
   * thrown error (this version-skew 404 included) to a 502, the same
   * posture the review-gate route already uses for a transport/host
   * failure.
   */
  async acknowledgeAttention(id: string): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>(
      `/internal/sessions/${encodeURIComponent(id)}/attention/ack`,
      { method: "POST" },
    );
    return result.ok;
  }

  /**
   * Issue #1951 — types a prompt into session `id`'s agent on this host
   * (`sessions.prompt` for a remote child). The agent answers a refusal
   * (blocked, not running, no framing for that agent, backpressure) as HTTP
   * 422 carrying `{status, error}` — a 4xx, because `request()` discards the
   * body of a 5xx — and a 404 means an agent build predating the route.
   */
  resolvePrompt(
    id: string,
    body: { text: string; submit: boolean },
  ): Promise<{ outputOffset: number; afterSeq?: number }> {
    return this.request(
      `/internal/sessions/${encodeURIComponent(id)}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      SESSION_PROMPT_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * Issue #1951 — one bounded output wait on session `id` on this host
   * (`sessions.wait_for_output` for a remote child). `body.timeoutMs` is the
   * wait's own length (the agent caps it); the request is given that plus
   * slack. The result mirrors services/output-wait.ts's, plus the PTY's
   * `outputOffset` so the caller can resume where this one stopped, or
   * `{ notRunning: true }` when the agent has no live PTY for the id.
   */
  resolveWaitOutput(
    id: string,
    body: { match: string; regex: boolean; timeoutMs: number; afterOffset?: number },
  ): Promise<RemoteWaitOutputResult> {
    return this.request(
      `/internal/sessions/${encodeURIComponent(id)}/wait-output`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      body.timeoutMs + WAIT_OUTPUT_REQUEST_SLACK_MS,
    );
  }

  /**
   * Uploads a pasted/attached image (issue #68) to this agent's own
   * `/internal/uploads`, which writes it under the given session cwd — on
   * *this* host's filesystem, not the primary's, since that's where the
   * CLI reading it back by path actually runs. Reuses request()'s ordinary
   * JSON-response handling; only the request body here is raw bytes rather
   * than JSON, which request()'s header/body passthrough already supports
   * unchanged.
   */
  uploadImage(cwd: string, buffer: Buffer, mime: string): Promise<{ path: string }> {
    const query = new URLSearchParams({ cwd, mime });
    return this.request(
      `/internal/uploads?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": mime },
        body: buffer,
      },
      UPLOAD_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * Generic-file counterpart to uploadImage: same `/internal/uploads`
   * endpoint (so the unsigned-body path exemption applies unchanged), with
   * `application/octet-stream` and the original file name as a `name` query
   * param; the agent sanitizes it before touching disk.
   */
  uploadFile(cwd: string, buffer: Buffer, name: string): Promise<{ path: string }> {
    const query = new URLSearchParams({ cwd, name });
    return this.request(
      `/internal/uploads?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buffer,
      },
      UPLOAD_REQUEST_TIMEOUT_MS,
    );
  }

  /** Fetches the scrollback replay buffer (Phase 4, #187) from whichever
   * agent actually runs this session's PTY, base64-decoded back into a
   * Buffer here so callers (session-backend.ts's RemoteBackend) never see
   * the wire encoding. Mirrors resolveGitStatus/resolveGitBranch's plain-GET
   * shape — no request body, cwd-free (the agent resolves scrollback by
   * session id alone via its own app.pty). */
  async resolveScrollback(id: string): Promise<Buffer> {
    const result = await this.request<{ b64: string }>(
      `/internal/sessions/${encodeURIComponent(id)}/scrollback`,
    );
    return Buffer.from(result.b64, "base64");
  }

  /** One page of the session's conversation (issue #2268), read ON the agent,
   * where the transcript file lives. The agent answers a `TranscriptResult`
   * as JSON with a 200 either way, so a refusal needs no error mapping here. */
  async resolveTranscript(id: string, query: TranscriptQuery): Promise<TranscriptResult> {
    const params = new URLSearchParams({
      afterSeq: String(query.afterSeq),
      limit: String(query.limit),
      tools: query.fullTools ? "1" : "0",
    });
    return this.request<TranscriptResult>(
      `/internal/sessions/${encodeURIComponent(id)}/transcript?${params.toString()}`,
    );
  }

  /** The session's scrollback rendered as plain text (issue #2112) — rendered
   * ON the agent, where the PTY's real size is known, so only text crosses. */
  async resolveRenderedScrollback(id: string): Promise<string> {
    const result = await this.request<{ text?: string; b64?: string }>(
      `/internal/sessions/${encodeURIComponent(id)}/scrollback?mode=rendered`,
    );
    if (typeof result.text === "string") return result.text;
    // An agent build that predates this mode ignores `?mode=` and answers the raw
    // `{b64}`; an empty string there would read as "no output". Render the bytes
    // here instead, so a mixed-version fleet stays readable.
    //
    // That `b64` is `getScrollback()`: the terminal-mode preamble (alt-screen
    // enter/exit, mouse and bracketed-paste modes) followed by the ring. A leading
    // `ESC[?1049h` would put the whole replay into the alternate buffer, which has
    // no scrollback, so the leading run of private-mode sequences is dropped — the
    // ring's own escapes switch screens where they happened. The match is greedy,
    // so a private-mode run that begins the ring itself and abuts the preamble
    // (e.g. `ESC[?25l` then the TUI's own `ESC[?1049h`) goes too: the content then
    // lands in the normal buffer, which has scrollback, and only the
    // `--- alternate screen ---` marker is lost — benign.
    //
    // The size is a fixed 120x40: an older agent cannot tell us the real one, so a
    // session that ran at another width is re-wrapped. Accepted for a skew path.
    if (typeof result.b64 === "string" && result.b64.length > 0) {
      const bytes = Buffer.from(result.b64, "base64").toString("latin1");
      const ring = bytes.replace(LEADING_PRIVATE_MODES, "");
      return renderScrollback(Buffer.from(ring, "latin1"), { cols: 120, rows: 40 });
    }
    return "";
  }

  /** Stashes a seed prompt (issue #271) on this agent's own PtyManager, for
   * a NEW session's SessionStart hook to pick up once it fires. */
  async resolveStashSeed(id: string, seed: string): Promise<void> {
    await this.request(`/internal/sessions/${encodeURIComponent(id)}/stash-seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed }),
    });
  }

  /** Delivers a promote decision (issue #271) to whichever host actually
   * holds the pending promote_request connection — mirrors
   * resolveReviewGate's shape exactly. */
  async resolvePendingPromote(id: string, decision: PromoteDecision): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>(
      `/internal/sessions/${encodeURIComponent(id)}/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decision),
      },
    );
    return result.ok;
  }

  /**
   * Reads a task's round-suffixed review-findings file (#760) off this
   * agent's own filesystem — mirrors /internal/task-review-findings's
   * `{ content: string | null }` shape exactly. `content: null` is a real
   * 200 response meaning "genuinely absent/empty", not a connectivity or
   * scope failure — those still surface as thrown HostUnreachableError/
   * HostRequestError from `request()` below, unchanged. A 404
   * specifically (an old peer build with no such route — version skew)
   * throws HostRequestError like any other 4xx (see that class's own doc
   * comment) rather than being swallowed here into a `null`, which is
   * exactly what would misread "the route doesn't exist" as "the file
   * doesn't exist" — session-backend.ts's RemoteBackend passes this
   * straight through so its own caller (task-reconciler.ts) sees the
   * distinction too.
   */
  async resolveReadTaskReviewFindings(taskId: number, round: number): Promise<string | null> {
    const result = await this.request<{ content: string | null }>(
      `/internal/task-review-findings?taskId=${taskId}&round=${round}`,
    );
    return result.content;
  }

  /**
   * Deletes a task's round-suffixed review-findings file (#760) off this
   * agent's own filesystem, once its content has been durably ingested.
   * Mirrors resolveReadTaskReviewFindings's own route.
   */
  async resolveDeleteTaskReviewFindings(taskId: number, round: number): Promise<void> {
    await this.request(`/internal/task-review-findings?taskId=${taskId}&round=${round}`, {
      method: "DELETE",
    });
  }

  /**
   * #778 — reads a task's Conventional Commits title file off this agent's
   * own filesystem, mirrors resolveReadTaskReviewFindings's own shape and
   * version-skew posture exactly (a 404 — the route doesn't exist on an old
   * peer build — throws HostRequestError, never collapses into `null`).
   */
  async resolveReadTaskCommitTitle(taskId: number): Promise<string | null> {
    const result = await this.request<{ content: string | null }>(
      `/internal/task-commit-title?taskId=${taskId}`,
    );
    return result.content;
  }

  /**
   * Reads a suggestions-round worker's re-review request file off this
   * agent's own filesystem (`taskRereviewRequestPath`). Same shape and
   * version-skew posture as `resolveReadTaskCommitTitle`: a 404 from a peer
   * build without the route throws HostRequestError, never collapses into
   * `null`.
   */
  async resolveReadTaskRereviewRequest(taskId: number, key: number): Promise<string | null> {
    const result = await this.request<{ content: string | null }>(
      `/internal/task-rereview-request?taskId=${taskId}&key=${key}`,
    );
    return result.content;
  }

  /** The bearer+signature-authed inbound WebSocket to one `/internal/ws/*` route. */
  private inboundStream(requestTarget: string, capPayload: boolean): NodeWebSocket {
    return new NodeWebSocket(`${this.transport.wsBaseUrl}${requestTarget}`, {
      headers: {
        authorization: `Bearer ${this.transport.token}`,
        ...this.transport.signatureHeaders("GET", requestTarget, undefined),
      },
      ...(capPayload ? { maxPayload: 1024 * 1024 } : {}),
      ...this.transport.pinnedWsOptions(),
    });
  }

  /** Issue #2571 — a stream over the outbound channel, or null for the inbound
   * transport (see openStreamOnTransport). */
  private channelStream(
    kind: AgentChannelStreamKind,
    identity: string,
    query?: Record<string, string>,
  ): NodeWebSocket | null {
    const transport = this.transport.resolveTransport?.(AGENT_CHANNEL_STREAMS_OPERATION);
    return openStreamOnTransport(this.channelApp, transport, kind, identity, query);
  }

  /**
   * Opens (but does not wait for) a WS connection to this agent's
   * `/internal/ws/attach`, bearer-authed via a request header (the `ws`
   * package is required for this — the browser/global WebSocket API can't
   * set one). Callers (routes/terminal.ts) own the open/error/close
   * lifecycle and the actual byte piping; this just constructs the socket.
   */
  openAttach(opts: OpenAttachOptions): NodeWebSocket {
    const viaChannel = this.channelStream("attach", opts.id, attachStreamQuery(opts));
    if (viaChannel) return viaChannel;
    const query = new URLSearchParams({
      id: opts.id,
      cwd: opts.cwd,
      command: opts.command,
      cols: String(opts.cols),
      rows: String(opts.rows),
    });
    if (opts.projectId !== undefined) {
      query.set("projectId", String(opts.projectId));
    }
    if (opts.env !== undefined) {
      query.set("env", JSON.stringify(opts.env));
    }
    const requestTarget = `/internal/ws/attach?${query.toString()}`;
    return this.inboundStream(requestTarget, false);
  }

  /** POST to an agent browser route, naming the target in the query. */
  postBrowser(path: string, target: BrowserTarget, body?: unknown): Promise<unknown> {
    return this.request(`${path}?${browserTargetQuery(target)}`, {
      method: "POST",
      // No JSON content type without a body: Fastify refuses an empty body
      // under it, which failed every close against a real agent (#2688).
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  browserAutomationAction(sessionId: number, target: BrowserTarget, body: unknown) {
    return this.postBrowser(`/internal/sessions/${sessionId}/browser`, target, body);
  }

  browserAutomationFind(sessionId: number, target: BrowserTarget, body: unknown) {
    return this.postBrowser(`/internal/sessions/${sessionId}/browser/find`, target, body);
  }

  openBrowserWs(sessionId: number, target: BrowserTarget): NodeWebSocket {
    const requestTarget = `/internal/ws/browser/${sessionId}?${browserTargetQuery(target)}`;
    return this.inboundStream(requestTarget, false);
  }

  /**
   * Opens (but does not wait for) a WS connection to this agent's
   * `/internal/ws/events` (issue #166) — the events-channel counterpart to
   * openAttach() above, bearer-authed the same header-only way (the `ws`
   * package, not the browser/global WebSocket API, is what makes a custom
   * Authorization header possible on the upgrade request). Unlike
   * openAttach(), this takes no per-session target — it's one aggregated
   * stream covering every session this agent tracks, so there are no query
   * params to build. Callers (routes/events.ts's relayRemoteEventsHost,
   * services/remote-event-subscriber.ts) own the open/error/close lifecycle
   * and the actual frame relaying/handling.
   *
   * `maxPayload` bounds inbound frames on this (client) socket, matching
   * plugins/websocket.ts's own 1 MiB server-side cap (Hermes review, PR
   * #564 round 4) — without it, `ws`'s 100 MiB default leaves both callers
   * exposed to an oversized frame from a buggy or compromised agent: an
   * unbounded `JSON.parse` and, for remote-event-subscriber.ts, an
   * unbounded flush-buffer entry. A frame over the cap makes `ws` close the
   * connection (RFC 6455 1009) rather than deliver it — both callers
   * already handle an unexpected close via their normal reconnect/relay
   * teardown paths, so this doesn't need its own error handling.
   *
   * Issue #1459 — `opts.cursors` (only ever passed by
   * routes/events.ts's relayRemoteEventsHost, never by
   * remote-event-subscriber.ts's own history-capture subscription, which has
   * no browser-facing cursors/seen story to opt into) appends `?cursors=1`
   * to `requestTarget` — BEFORE it's used for both the actual URL and the
   * signature's canonical request-target string, so the two can never
   * diverge (buildCanonicalString's own doc comment: the signed target must
   * match byte-for-byte what's actually sent on the wire). This is what
   * tells the agent's own `/internal/ws/events` route to also send its own
   * `cursors` frame and join its seenSubscribers broadcast set — see
   * relayRemoteEventsHost's own doc comment for why this is opt-in rather
   * than unconditional.
   */
  openEventsStream(opts?: { cursors?: boolean }): NodeWebSocket {
    const cursors = opts?.cursors ? { cursors: "1" } : undefined;
    const viaChannel = this.channelStream("events", cursors ? "cursors" : "", cursors);
    if (viaChannel) return viaChannel;
    const requestTarget = opts?.cursors ? "/internal/ws/events?cursors=1" : "/internal/ws/events";
    return this.inboundStream(requestTarget, true);
  }

  /**
   * Opens (but does not wait for) a WS connection to this agent's
   * `/internal/ws/ssh-agent` (issue #820, PR5b) — bearer+signature-authed
   * the same header-only way as openEventsStream() above. The caller
   * (ssh-agent-fanout.ts's subscriber, PR5c) is expected to immediately
   * wrap the returned socket in `createMuxConnection(socket,
   * {channelIdParity: "odd"})` — THIS side (primary) dials out, so it must
   * be "odd" to match the agent's own "even" pin (routes/internal.ts's
   * `/internal/ws/ssh-agent` handler). `maxPayload` matches
   * openEventsStream()'s own 1 MiB cap (plugins/websocket.ts's identical
   * server-side limit) — well above `CHANNEL_WINDOW_BYTES` (256 KiB,
   * ssh-agent-mux.ts), the largest a single mux Data frame's payload can
   * legitimately be.
   */
  openSshAgentStream(): NodeWebSocket {
    const viaChannel = this.channelStream("ssh-agent", "");
    if (viaChannel) return viaChannel;
    const requestTarget = "/internal/ws/ssh-agent";
    return this.inboundStream(requestTarget, true);
  }

  /**
   * Opens this agent's `/internal/ws/control-relay` (issue #1656): the mux
   * the primary dials so sessions on the agent can reach the primary's
   * control surface. Same bearer, signing and pinning as every other stream
   * here; `maxPayload` matches the mux's largest Data frame.
   */
  openControlRelayStream(): NodeWebSocket {
    const viaChannel = this.channelStream("control-relay", "");
    if (viaChannel) return viaChannel;
    const requestTarget = "/internal/ws/control-relay";
    return this.inboundStream(requestTarget, true);
  }

  /**
   * Forwards an HTTP preview request to this agent's own
   * `/internal/preview/:port/*` (issue #28 phase 6) — the agent, not this
   * process, dials the actual dev server, always on its own loopback (see
   * internal.ts's own loopback assertion; `port` is never a caller-supplied
   * host, only a number this method interpolates into the path). Returns
   * the raw Response regardless of status (a 404/500 from the dev server is
   * not this method's failure to report — only a network-level failure to
   * reach the agent itself is, same distinction request()'s callers rely
   * on but this method can't reuse it for: unlike request(), a non-2xx
   * upstream status must pass through to the caller unchanged, not throw).
   *
   * `body`/`duplex`, when present, stream a non-GET/HEAD request body
   * through to the agent unbuffered — see http-proxy.ts's
   * buildUpstreamRequestBody. Note PREVIEW_REQUEST_TIMEOUT_MS now also
   * bounds upload time for those requests, not just the response: a large
   * POST to a remote-hosted preview can abort mid-upload once it elapses.
   */
  async openPreviewHttp(
    port: number,
    pathAndQuery: string,
    init: {
      method: string;
      headers: Headers;
      body?: ReadableStream<Uint8Array>;
      duplex?: "half";
    },
  ): Promise<Response> {
    return this.openPreviewHttpRequest(`/internal/preview/${port}${pathAndQuery}`, init);
  }

  openConfiguredPreviewHttp(
    url: string,
    init: { method: string; headers: Headers; body?: ReadableStream<Uint8Array>; duplex?: "half" },
  ): Promise<Response> {
    return this.openPreviewHttpRequest(
      `/internal/configured-preview?${new URLSearchParams({ url })}`,
      init,
    );
  }

  openConfiguredPreviewWs(url: string): NodeWebSocket {
    const viaChannel = this.channelStream("configured-preview", url, { url });
    if (viaChannel) return viaChannel;
    const requestTarget = `/internal/ws/configured-preview?${new URLSearchParams({ url })}`;
    return this.inboundStream(requestTarget, false);
  }

  private async openPreviewHttpRequest(
    requestTarget: string,
    init: { method: string; headers: Headers; body?: ReadableStream<Uint8Array>; duplex?: "half" },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    // Issue #249 / roadmap 7.5 — `init.headers` here is seeded from a
    // BROWSER-controlled request forwarded through the preview proxy
    // (preview-proxy.ts), unlike every other call site in this file, which
    // only ever builds its own headers from scratch. Delete-then-set, never
    // just set-without-delete: this route's own request body is exempt from
    // hashing (isUnsignedBodyPath), so if the auth/signature headers below
    // were only conditionally set (empty for a static-Bearer host) a
    // browser could otherwise inject its own x-request-signature/
    // -timestamp/-nonce and have them pass straight through unexamined.
    headers.delete("authorization");
    headers.delete(SIGNATURE_HEADER);
    headers.delete(TIMESTAMP_HEADER);
    headers.delete(NONCE_HEADER);
    const t = this.requestTransport();
    if (t.kind !== "inbound") {
      return previewHttpOverChannel(
        this.hostId,
        t,
        requestTarget,
        init,
        headers,
        PREVIEW_REQUEST_TIMEOUT_MS,
      );
    }
    headers.set("authorization", `Bearer ${this.transport.token}`);
    for (const [key, value] of Object.entries(
      this.transport.signatureHeaders(init.method, requestTarget, undefined),
    )) {
      headers.set(key, value);
    }
    try {
      return await fetch(`${this.transport.baseUrl}${requestTarget}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body, duplex: init.duplex } : {}),
        // "manual" here for the same reason request()'s own comment gives:
        // a followed redirect would resend this bearer token whichever way
        // the redirect's target points, cross-origin-redirect stripping
        // rules notwithstanding — never rely on that instead of just not
        // following. The dev server's own 3xx (relayed by the agent's
        // /internal/preview handler as an ordinary response status, not an
        // HTTP-level redirect of *this* fetch) reaches this method as an
        // ordinary non-ok Response either way, which the caller forwards
        // to the browser unchanged.
        redirect: "manual",
        signal: AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
        dispatcher: this.transport.pinnedDispatcher(),
      } as RequestInit & { duplex?: "half" });
    } catch (err) {
      throw new HostUnreachableError(this.hostId, err);
    }
  }

  /**
   * Opens (but does not wait for) a WS connection to this agent's
   * `/internal/ws/preview` (issue #28 phase 6) — the WS analog of
   * openPreviewHttp above, and constructed the same bearer-header way as
   * openAttach (the `ws` package is required for a request header the
   * browser/global WebSocket API can't set). Callers (preview-proxy.ts) own
   * the open/error/close lifecycle and the actual frame piping.
   *
   * No connect timeout, deliberately matching openAttach's own gap rather
   * than a bespoke one just for this method (Hermes review, PR #48): if the
   * agent accepts the TCP/WS handshake but its own loopback dev server
   * never answers, this connection can sit open with nothing flowing. A
   * hung *preview* pane is a lower-stakes failure mode than the equivalent
   * for a terminal attach — worth fixing for both together in a follow-up,
   * not diverging on here in isolation.
   */
  openPreviewWs(port: number, pathAndQuery: string): NodeWebSocket {
    const viaChannel = this.channelStream("preview", `${port}${pathAndQuery}`, {
      port: String(port),
      path: pathAndQuery,
    });
    if (viaChannel) return viaChannel;
    const query = new URLSearchParams({ port: String(port), path: pathAndQuery });
    const requestTarget = `/internal/ws/preview?${query.toString()}`;
    return this.inboundStream(requestTarget, false);
  }

  /** Best-effort reachability probe for the Settings hosts panel's "test
   * connection" action — deliberately doesn't use `request()`'s bearer
   * header/timeout semantics that throw on any non-2xx, since a healthy
   * agent's /health is intentionally unauthenticated. */
  async ping(): Promise<boolean> {
    return (await this.probe()) !== "down";
  }

  /** ping() with "busy" (channel up, saturated) kept apart for the heartbeat. */
  async probe(): Promise<"ok" | "busy" | "down"> {
    const transport = this.requestTransport();
    // A host bound to its outbound channel is as reachable as the channel is,
    // and one small round trip through it proves the agent answers. It never
    // probes /health (#2620): there may be no address to probe (#2572), and a
    // bound host must not be judged by a transport it does not use.
    if (transport.kind === "channel-down") return "down";
    if (transport.kind === "channel" || this.transport.baseUrl === "") {
      // Saturated (transfers/previews hold slots) is busy, not down; the
      // heartbeat bounds how long that may last.
      return this.request("/internal/protocol", { method: "GET" }, defaultRequestTimeoutMs).then(
        () => "ok",
        (err: unknown) => (isHostBusyError(err) ? "busy" : "down"),
      );
    }
    return probeHealth(
      this.transport.baseUrl,
      defaultRequestTimeoutMs,
      () => this.transport.pinnedDispatcher(),
      {
        hostId: this.hostId,
        log: this.channelApp?.log,
      },
    );
  }

  // Cookie profiles are primary-only state (see routes/browser-cookies.ts's
  // own comment) — there is no list/import/upload/delete dispatch to an
  // agent at all, so this class carries no methods for them (issue #522;
  // the agent-side routes these used to call always 500'd, since an agent
  // has no app.db to satisfy them).

  getDevServerStatus(port: number, scheme: "http" | "https"): Promise<{ online: boolean }> {
    return this.request<{ online: boolean }>(
      `/internal/dev-server-status?port=${port}&scheme=${scheme}`,
      { method: "GET" },
    );
  }
}
