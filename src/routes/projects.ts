import {
  parsePreProvision,
  serializePreProvision,
  type PreProvision,
} from "../services/pre-provision.js";
import {
  getMaterializeJob,
  startMaterialize,
  takeFailedMaterialize,
} from "../services/checkout-materialize.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  GIT_IDENTITY_FIELD_MAX,
  parseProjectGitIdentity,
  serializeProjectGitIdentity,
} from "../services/git-identity.js";
import path from "node:path";
import net from "node:net";
import {
  deleteProject,
  dockSessionIdsByProject,
  findOtherProject,
  getProjectById,
  getProjectOrThrow,
  getProjectsByIds,
  getWebhookRegistration,
  insertProject,
  listOtherProjectLocations,
  listProjectCwdsOnHost,
  listProjectIds,
  listProjects,
  listProjectsByName,
  listSessionsForProject,
  updateProject,
  type ProjectRow,
} from "../services/project-store.js";
import {
  ACCEPTS_CHILDREN_FROM,
  MAX_PROJECT_LIST,
  crossProjectFieldsOut,
  parseProjectIdList,
  serializeProjectIdList,
  type AcceptsChildrenFrom,
} from "../services/cross-project.js";
import {
  discoverCandidates,
  expandHome,
  resolveProjectActions,
  resolveProjectDock,
  type DiscoveredCandidate,
} from "../services/project-config.js";
import { getStoredSettings } from "../services/settings.js";
import { resolveProjectRoots } from "../services/project-roots.js";
import {
  metaAfterOperatorSave,
  parseHostCwdsMeta,
  serializeHostCwdsMeta,
} from "../services/host-cwds-meta.js";
import {
  attachHostCheckout,
  detectCheckouts,
  isStorablePath,
} from "../services/host-checkout-detect.js";
import {
  cancelDuplicateRefresh,
  getDuplicateGroups,
  mergeProjects,
  refreshDuplicateGroupsInBackground,
} from "../services/project-merge.js";
import {
  buildOriginIndex,
  findProjectByRepoIdentity,
  projectHasPath,
  type RepoMatchReason,
} from "../services/repo-identity.js";
import { KNOWN_AGENTS } from "../services/agent-detect.js";
import { HERMES_REVIEW_AGENT, hermesReviewAgentRefusal } from "../services/task-agent-resolve.js";
import { resolveGlobalPresets } from "./actions.js";
import { LOCAL_HOST_ID, getHostRow } from "../services/host-registry.js";
import { hasReachablePath } from "../services/agent-channel-tunnel.js";
import {
  MAX_HOST_CWDS,
  PLACEMENT_MODES,
  PLACEMENT_CAPABILITIES,
  PLACEMENT_PLATFORMS,
  type PlacementCapability,
  type PlacementMode,
  type PlacementPlatform,
} from "../shared/constants.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";

import { previewPlacement } from "../services/placement.js";
import { commandAgentBin } from "../services/hook-adapters/index.js";
import { portFromUrl } from "../plugins/preview-proxy.js";
import { resolveBackend } from "../services/session-backend.js";

import { readGitBranch } from "../services/git-branch.js";
import { listExistingProjectRuleFileNames } from "../services/agent-rules.js";

import { runGitInit } from "../services/git-init.js";
import {
  assertProjectDir,
  createProjectDir,
  ProjectDirError,
  type ProjectDirIssue,
} from "../services/project-dir.js";

import { getIntegration, getToken } from "../services/github-integration.js";
import { maybeAutoEnableConventionalTitles } from "../services/project-release-please.js";

import { repoKey, resolveRepoKeys } from "../services/repo-key.js";
import {
  buildWebhookUrl,
  getWebhookSecret,
  registerProjectWebhook,
  unregisterHook,
} from "../services/github-webhook.js";

import { projectGitHubRoute } from "./project-github.js";
import { projectGitRoute } from "./project-git.js";
import { projectGitWritesRoute } from "./project-git-writes.js";
import { projectDockerRoute, discoveredServicesForProject } from "./project-docker.js";
import { detectDevServerPortForSessionIds } from "../services/dev-server-detect.js";
import { toDockControls } from "../services/docker-service-detect.js";
import { SETUP_RECIPE_MAX_LENGTH } from "../services/setup-recipe-shared.js";
import { resolveWorkflowConventionsText } from "../services/workflow-conventions.js";
import { hashWorkflowConventionsSection } from "../services/mullion-scaffold.js";

import {
  parseHostCwds,
  parsePlacementConstraints,
  serializeHostCwds,
  serializePlacementConstraints,
} from "../services/placement.js";
import { listHosts } from "../services/host-registry.js";

/** Issues #2123 / #2124 — a list of project ids (an empty one is stored as null). */
const PROJECT_ID_LIST_SCHEMA = {
  type: ["array", "null"],
  items: { type: "integer", minimum: 1 },
  maxItems: MAX_PROJECT_LIST,
  uniqueItems: true,
} as const;

/** The per-project git identity override; `null` clears it. */
interface GitIdentityBody {
  name: string;
  email: string;
}

const GIT_IDENTITY_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["name", "email"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: GIT_IDENTITY_FIELD_MAX },
    email: { type: "string", minLength: 1, maxLength: GIT_IDENTITY_FIELD_MAX },
  },
} as const;

/** Issue #2241 — what the API accepts for `placementConstraints`. */
interface PlacementConstraintsBody {
  platform?: PlacementPlatform[];
  allowBurst?: boolean;
  capabilities?: PlacementCapability[];
}

/** Issue #2241 — a project's placement steering flags (see schema.ts). */
const PLACEMENT_CONSTRAINTS_SCHEMA = {
  type: ["object", "null"],
  additionalProperties: false,
  // Replaced wholesale on PATCH, so a caller must state the platform and burst
  // fields: a partial object would silently reset the other one. `capabilities`
  // (issue #2306) is optional so a client that predates it keeps working; an
  // omitted list reads as none.
  required: ["platform", "allowBurst"],
  properties: {
    // An allow-list; empty = any platform.
    platform: {
      type: "array",
      items: { type: "string", enum: [...PLACEMENT_PLATFORMS] },
      maxItems: PLACEMENT_PLATFORMS.length,
      uniqueItems: true,
    },
    allowBurst: { type: "boolean" },
    // Host capabilities the project requires; empty = none.
    capabilities: {
      type: "array",
      items: { type: "string", enum: [...PLACEMENT_CAPABILITIES] },
      maxItems: PLACEMENT_CAPABILITIES.length,
      uniqueItems: true,
    },
  },
} as const;

/** What the API accepts for `preProvision` (see pre-provision.ts). */
const PRE_PROVISION_SCHEMA = {
  anyOf: [
    { type: "null" },
    { type: "string", enum: ["none", "all"] },
    {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 128 },
      maxItems: MAX_HOST_CWDS,
      uniqueItems: true,
    },
  ],
} as const;

interface CreateProjectBody {
  name: string;
  cwd: string;
  hostId?: string;
  // Issue #1723 / roadmap 8.9 — the placement opt-in: "auto" lets each of
  // this project's sessions land on an eligible host of its own; absent means
  // the column's "pinned" default (every session on the project's own host).
  placement?: PlacementMode;
  // Issue #1724 / roadmap 8.10 — where this project lives on OTHER hosts, as
  // `{ "<hostId>": "<absolute path>" }`. A host with no entry does not have the
  // project, so it is not a placement candidate. Absent means "this project
  // lives on its own host and nowhere else".
  hostCwds?: Record<string, string> | null;
  // Issue #2241 — placement steering flags; see PLACEMENT_CONSTRAINTS_SCHEMA.
  placementConstraints?: PlacementConstraintsBody | null;
  // Checkouts to clone ahead of the first placement: "none" (default), "all", or host ids.
  preProvision?: PreProvision | null;
  gitIdentity?: GitIdentityBody | null;
  // Confirm-first directory creation (leaf-only — see project-dir.ts):
  // the initial POST without this flag 400s with code PROJECT_DIR_MISSING
  // when `cwd` doesn't exist yet; the modal re-submits with `createDir:
  // true` once the user confirms.
  createDir?: boolean;
  // Only applied when this request actually created the directory
  // (createDir + a fresh dir, not an already-existing one).
  gitInit?: boolean;
  // Issue #2231 — skip the same-repo duplicate check (409 DUPLICATE_PROJECT).
  allowDuplicate?: boolean;
}

interface UpdateProjectBody {
  name?: string;
  cwd?: string;
  // Bare port ("5173") or a full "scheme://host:port" URL — see schema.ts.
  // `null` clears a previously-set value.
  devServerUrl?: string | null;
  // Per-project auto-fetch override — null means "inherit from global setting"
  // (src/plugins/git-fetcher.ts). The GET /api/projects response already
  // includes this column via the project row spread.
  autoFetch?: boolean | null;
  // Phase 6 Task Master (6.2/#215) — per-project override of
  // launchers.defaultAgent / the optional advisory review agent. `null`
  // clears a previously-set value (falls back to the next precedence
  // tier — see task-agent-resolve.ts).
  defaultAgent?: string | null;
  defaultReviewAgent?: string | null;
  // Issue #2245 — the setup recipe (a shell command string) run in a fresh
  // worktree or clone; `null` clears it.
  setupRecipe?: string | null;
  // Issue #1723 / roadmap 8.9 — the placement mode: "pinned" (the default —
  // every session runs on the project's own host) or "auto" (an eligible
  // host is chosen per session; see services/placement.ts). The opt-in is
  // explicit and per project: nothing changes until someone sets it.
  placement?: PlacementMode;
  // Issue #1724 / roadmap 8.10 — where this project lives on OTHER hosts, as
  // `{ "<hostId>": "<absolute path>" }`. `null` clears the map (the project
  // lives on its own host and nowhere else). The paths are ABSOLUTE paths ON
  // THAT HOST — the same directory the session will be spawned in.
  hostCwds?: Record<string, string> | null;
  // Issue #2241 — placement steering flags; `null` clears them.
  placementConstraints?: PlacementConstraintsBody | null;
  // Checkouts to clone ahead of the first placement: "none" (default), "all", or host ids.
  preProvision?: PreProvision | null;
  gitIdentity?: GitIdentityBody | null;
  // Per-project only, no install-wide tier — same posture as
  // defaultReviewAgent above. `null`/`false` = off; default-off matters,
  // see schema.ts's own doc comment on these two columns.
  mergeOnApprove?: boolean | null;
  autoApprove?: boolean | null;
  // Issue #2110 — this project's sessions may spawn children in other
  // projects. Per-project, `null`/`false` = off (the default).
  allowCrossProjectSpawn?: boolean | null;
  // Issue #2123 — the projects a coordinator may reach; `null` or empty = all.
  crossProjectTargets?: number[] | null;
  // Issue #2124 — whether other projects' coordinators may start children here:
  // `any` (default, `null`), `listed` (only `acceptsChildrenFromList`) or `none`.
  acceptsChildrenFrom?: AcceptsChildrenFrom | null;
  acceptsChildrenFromList?: number[] | null;
  // Issue #2270 — whether other projects' coordinators may message a running
  // session here: `none` (the default, `null`), `listed` or `any`.
  acceptsMessagesFrom?: AcceptsChildrenFrom | null;
  acceptsMessagesFromList?: number[] | null;
  // #756 — per-project override of the resolved auto-return round cap.
  // `null` clears it (falls back to the install-wide
  // taskMaster.maxAutoReturnRounds setting via resolveMaxAutoReturnRounds in
  // task-reconciler.ts); `0` means unlimited — unlike mergeOnApprove/autoApprove above, this HAS
  // an install-wide default that works for every project, so a global
  // fallback tier is useful here where it wasn't for those two.
  maxAutoReturnRounds?: number | null;
  // #761 — per-project only, no install-wide tier — same posture as
  // mergeOnApprove/autoApprove above: whether this repo's commit history
  // follows Conventional Commits is a property of that repo, not a
  // Mullion-wide default.
  conventionalCommitTitles?: boolean | null;
  // #744 — per-project only, no install-wide tier, same posture as
  // conventionalCommitTitles above.
  autoTagRelease?: boolean | null;
  // Issue #884 — per-project override of settings.sessions.injectAgentGuide/
  // injectProjectBriefing. `null` clears it (falls back to the global
  // setting) — same nullable-override shape as autoFetch above.
  injectAgentGuide?: boolean | null;
  injectProjectBriefing?: boolean | null;
  // Issue #937 — per-project override of whether the GLOBAL
  // settings.sessions.workflowConventionsText text gets injected into this
  // project's sessions. `null` clears it (falls back to `true`, i.e.
  // inject) — same nullable-override shape as injectAgentGuide/
  // injectProjectBriefing above. Unlike those two, there is no matching
  // global BOOLEAN setting to fall back to — the global tier here is the
  // text itself (settings.ts), which has its own independent "empty means
  // nothing to inject" gate.
  injectWorkflowConventions?: boolean | null;
  // Issue #1208 — a SECOND, independent opt-out from injectWorkflowConventions
  // above. That flag means "my AGENTS.md is authoritative instead" and feeds
  // text resolution (resolveWorkflowConventionsText); this one means "the
  // committed AGENTS.md already carries this install's text, don't deliver
  // it a second way per-session" and touches only session-lifecycle.ts's
  // injection gate — never conventionsDrifted or any resolver. See the
  // schema column's own doc comment for the full invariant.
  suppressConventionsInjectionAfterScaffold?: boolean | null;
  // Same confirm-first contract as CreateProjectBody, above.
  createDir?: boolean;
  gitInit?: boolean;
  // Same contract as CreateProjectBody.allowDuplicate.
  allowDuplicate?: boolean;
}

interface DiscoveredProject extends DiscoveredCandidate {
  isRegistered: boolean;
  // Issue #2231 — the existing project this candidate is a checkout of, when
  // its path or git origin matches one. The UI offers "Add as checkout of".
  // `hostId` is the project's own host: a candidate on that host is a second
  // clone there, which cannot be attached (only created separately).
  matchedProject?: { id: number; name: string; hostId: string; reason: RepoMatchReason };
}

/**
 * The per-host cwd map's keys must name hosts we KNOW about.
 *
 * A typo in a host id would sit in the map forever: the host it names
 * would never become a placement candidate (so the map would look like it
 * did nothing), and if a host with that id were ever registered, it would
 * silently start being one — with a path meant for something else.
 *
 * Returns the offending host id, or null when the map is fine.
 */
/**
 * Whether a host is somewhere a project can be pinned: reachable, or an
 * outbound-only agent (#2636) with a machine identity that is between
 * connections. The same set the project modal offers.
 */
function isHostRegistered(
  app: FastifyInstance,
  host: { id: string; baseUrl: string | null; hasMachineIdentity: boolean },
): boolean {
  return host.hasMachineIdentity || hasReachablePath(app, host);
}

function unknownHostInCwds(
  app: FastifyInstance,
  map: Record<string, string> | null | undefined,
): string | null {
  if (map === null || map === undefined) return null;
  // A pending host (no address, no channel, no machine identity yet) is not
  // somewhere a session can run, so a cwd keyed to one is as wrong as a typo.
  const known = new Set(
    listHosts(app)
      .filter((host) => host.id === LOCAL_HOST_ID || isHostRegistered(app, host))
      .map((host) => host.id),
  );
  for (const hostId of Object.keys(map)) {
    if (!known.has(hostId)) return hostId;
  }
  return null;
}

/** The 400 text for a host id `unknownHostInCwds` rejected: pending or unknown. */
function unknownHostMessage(app: FastifyInstance, hostId: string): string {
  const row = getHostRow(app, hostId);
  return row
    ? `hostCwds names host ${row.name}, which hasn't registered yet`
    : `hostCwds names an unknown host: ${hostId}`;
}

/**
 * Issue #2231 — the existing project (other than `excludeProjectId`) that a
 * create/edit would duplicate: any of the given (host, path) checkouts is
 * already that project's, or has its git origin (compared against local
 * projects only: saving never waits on another host).
 */
async function findDuplicateProject(
  app: FastifyInstance,
  checkouts: { hostId: string; cwd: string }[],
  excludeProjectId?: number,
) {
  const originIndexRef = {};
  const rows = listProjects(app);
  for (const c of checkouts) {
    const match = await findProjectByRepoIdentity(app, {
      ...c,
      projects: rows,
      excludeProjectId,
      originIndexRef,
      localOnly: true,
    });
    if (match) return match.project;
  }
  return null;
}

// What the caller can do next, per route: the same 409 reads differently for
// a create, an edit and an attach.
const DUPLICATE_HINTS = {
  create:
    "Attach this checkout to it, or send allowDuplicate: true to create a separate project anyway.",
  update: "Send allowDuplicate: true to save this change anyway.",
  attach: "That path belongs to it already; a path can only belong to one project.",
} as const;

function duplicateProjectReply(
  reply: FastifyReply,
  existing: { id: number; name: string; hostId: string },
  context: keyof typeof DUPLICATE_HINTS,
) {
  return reply.code(409).send({
    statusCode: 409,
    error: "Conflict",
    message: `This repository already has a project: ${existing.name}. ${DUPLICATE_HINTS[context]}`,
    code: "DUPLICATE_PROJECT",
    existingProjectId: existing.id,
    existingName: existing.name,
    existingHostId: existing.hostId,
  });
}

const createProjectSchema = {
  body: {
    type: "object",
    required: ["name", "cwd"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      hostId: { type: "string", minLength: 1 },
      // Issue #1723 / roadmap 8.9 — "auto" opts the project into automatic
      // placement; absent means the column's "pinned" default. The modes
      // come from PLACEMENT_MODES, the shared declaration.
      placement: { type: "string", enum: [...PLACEMENT_MODES] },
      // Issue #1724 — the per-host cwd map. An object of ABSOLUTE paths, one
      // per host; `null` means "this project lives on its own host only".
      //
      // The paths are absolute because they become a session's working
      // directory on THAT host: a relative one would resolve against
      // whatever the agent's cwd happened to be.
      hostCwds: {
        type: ["object", "null"],
        additionalProperties: { type: "string", minLength: 1, pattern: "^/" },
        maxProperties: MAX_HOST_CWDS,
      },
      placementConstraints: PLACEMENT_CONSTRAINTS_SCHEMA,
      preProvision: PRE_PROVISION_SCHEMA,
      gitIdentity: GIT_IDENTITY_SCHEMA,
      createDir: { type: "boolean" },
      gitInit: { type: "boolean" },
      allowDuplicate: { type: "boolean" },
    },
  },
};

const updateProjectSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1 },
      // Issue #1723 / roadmap 8.9 — the placement opt-in; see the column's
      // own comment in schema.ts.
      placement: { type: "string", enum: [...PLACEMENT_MODES] },
      // Issue #1724 — the per-host cwd map; see the column's own comment.
      hostCwds: {
        type: ["object", "null"],
        additionalProperties: { type: "string", minLength: 1, pattern: "^/" },
        maxProperties: MAX_HOST_CWDS,
      },
      placementConstraints: PLACEMENT_CONSTRAINTS_SCHEMA,
      preProvision: PRE_PROVISION_SCHEMA,
      gitIdentity: GIT_IDENTITY_SCHEMA,
      devServerUrl: { type: ["string", "null"], minLength: 1 },
      autoFetch: { type: ["boolean", "null"] },
      defaultAgent: { type: ["string", "null"], enum: [...KNOWN_AGENTS, null] },
      // `hermes` is the external reviewer (#2369) — not a CLI, so not in
      // KNOWN_AGENTS (CLI detection, host placement).
      defaultReviewAgent: {
        type: ["string", "null"],
        enum: [...KNOWN_AGENTS, HERMES_REVIEW_AGENT, null],
      },
      setupRecipe: { type: ["string", "null"], maxLength: SETUP_RECIPE_MAX_LENGTH },
      mergeOnApprove: { type: ["boolean", "null"] },
      autoApprove: { type: ["boolean", "null"] },
      allowCrossProjectSpawn: { type: ["boolean", "null"] },
      crossProjectTargets: PROJECT_ID_LIST_SCHEMA,
      acceptsChildrenFrom: { type: ["string", "null"], enum: [...ACCEPTS_CHILDREN_FROM, null] },
      acceptsChildrenFromList: PROJECT_ID_LIST_SCHEMA,
      acceptsMessagesFrom: { type: ["string", "null"], enum: [...ACCEPTS_CHILDREN_FROM, null] },
      acceptsMessagesFromList: PROJECT_ID_LIST_SCHEMA,
      maxAutoReturnRounds: { type: ["integer", "null"], minimum: 0 },
      conventionalCommitTitles: { type: ["boolean", "null"] },
      autoTagRelease: { type: ["boolean", "null"] },
      injectAgentGuide: { type: ["boolean", "null"] },
      injectProjectBriefing: { type: ["boolean", "null"] },
      injectWorkflowConventions: { type: ["boolean", "null"] },
      suppressConventionsInjectionAfterScaffold: { type: ["boolean", "null"] },
      createDir: { type: "boolean" },
      gitInit: { type: "boolean" },
      allowDuplicate: { type: "boolean" },
    },
  },
};

const mergeProjectSchema = {
  body: {
    type: "object",
    required: ["into"],
    additionalProperties: false,
    properties: {
      into: { type: "integer", minimum: 1 },
    },
  },
};

const hostCheckoutSchema = {
  body: {
    type: "object",
    required: ["hostId", "cwd"],
    additionalProperties: false,
    properties: {
      hostId: { type: "string", minLength: 1 },
      cwd: { type: "string", minLength: 1, pattern: "^/" },
    },
  },
};

// Maps a ProjectDirError's discriminator to the 400 body's machine-readable
// `code` — the frontend keys its "Create folder" affordance off exactly
// PROJECT_DIR_MISSING (see CreateProjectModal.tsx) so a parent-missing typo
// is a dead end in the UI rather than offering to build a directory tree.
const PROJECT_DIR_ISSUE_CODES: Record<ProjectDirIssue, string> = {
  missing: "PROJECT_DIR_MISSING",
  "parent-missing": "PROJECT_PARENT_MISSING",
  "not-a-directory": "PROJECT_PATH_NOT_A_DIRECTORY",
  "parent-not-a-directory": "PROJECT_PARENT_NOT_A_DIRECTORY",
  symlink: "PROJECT_PATH_IS_SYMLINK",
  unreadable: "PROJECT_DIR_UNREADABLE",
  "create-failed": "PROJECT_DIR_CREATE_FAILED",
};

function projectDirErrorBody(err: ProjectDirError) {
  return {
    statusCode: 400,
    error: "Bad Request",
    message: err.message,
    code: PROJECT_DIR_ISSUE_CODES[err.issue],
  };
}

// Issue #28's per-project dev-server field — the authoritative, manually-set
// fallback the preview proxy resolves against (auto-discovery, a later
// phase, only ever pre-fills this; it never overrides it). Accepts either a
// bare port, since "the project's dev server" is usually all a user actually
// knows, or a full URL for the uncommon case (non-default host/path). This
// only checks shape (a well-formed port/URL) — it deliberately does not
// reject a host component like "http://localhost:5173" for a remote-hosted
// project, because that host is never actually used for one: the preview
// proxy forces the connection to the owning agent's own loopback and only
// forwards the port/path from here (see schema.ts's devServerUrl comment).
const DEV_SERVER_PORT_ONLY = /^\d{1,5}$/;

/** The single shape parser both isValidDevServerUrl (write-time, below) and
 * dev-server-status's remote branch (read-time — resolving what to forward
 * to the agent) build on. Hermes review, PR #533: one implementation is what
 * stops the two from drifting apart, which is exactly what happened before
 * this PR (the write-time validator never range-checked a full URL's port;
 * the read-time need introduced here does). Accepts a bare port or a full
 * http(s) URL, range-checking the port either way; returns null for
 * anything that parses as neither shape. The host is deliberately dropped
 * from the return value: for a remote-hosted project the agent always
 * probes its own loopback, never a caller-supplied host (see
 * dev-server-status's own comment, and schema.ts's devServerUrl comment —
 * "only the port is forwarded, never the host"). */
function parseDevServerTarget(value: string): { port: number; scheme: "http" | "https" } | null {
  if (DEV_SERVER_PORT_ONLY.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535 ? { port, scheme: "http" } : null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = portFromUrl(url);
    if (port < 1 || port > 65535) return null;
    return { port, scheme: url.protocol === "https:" ? "https" : "http" };
  } catch {
    return null;
  }
}

// Exported for routes/sessions.ts's dev-server accept route (issue #404),
// which patches this same column via the same validation rule.
export function isValidDevServerUrl(value: string): boolean {
  return parseDevServerTarget(value) !== null;
}

// Issue #442 — the two primary-side guards that run BEFORE delegating to a
// SessionBackend's deleteBranch/removeListedWorktree: both need the DB
// (tasks, sessions) and, for the live-session guard, app.pty — neither of
// which git-branch-delete.ts/git-worktree.ts have access to (deliberately
// kept DB-free and unit-testable standalone — see the plan's binding
// decision on why these guards live in the route, not the service).

/**
 * #490b — `enableWebhooks` only ever registers a hook for the projects
 * that exist at the moment it's called; a project added afterward gets no
 * hook and nothing detects it until the periodic reconciler's next pass
 * (up to `RECONCILE_INTERVAL_MS` later — see webhook-reconciler.ts). This
 * closes the common case immediately: called from the create/update
 * handlers below, a no-op whenever webhooks aren't enabled or the token/
 * secret aren't both available. Best-effort by design — `registerProjectWebhook`
 * itself never throws, logging and recording the failure instead (see its
 * own doc comment), so this never blocks the project create/update
 * response on a GitHub round trip failing.
 */
async function maybeRegisterProjectWebhook(
  app: FastifyInstance,
  row: { id: number; cwd: string; hostId: string },
): Promise<void> {
  try {
    if (!getIntegration(app).webhookEnabled) return;
    const token = getToken(app);
    const secret = getWebhookSecret(app);
    if (!token || !secret) return;

    const webhookUrl = buildWebhookUrl(app);
    // A cwd change can point this project at a different repo than the one
    // it was last registered against. Capture the old registration first —
    // if the repo really did change, its hook is now orphaned (still live
    // on GitHub, still delivering events, but for a repo nothing here
    // tracks anymore) and needs tearing down once the new repo is handled.
    const previous = getWebhookRegistration(app, row.id);

    await registerProjectWebhook(app, row, token, webhookUrl, secret);

    if (previous?.hookId) {
      const current = getWebhookRegistration(app, row.id);
      if (current && (current.owner !== previous.owner || current.repo !== previous.repo)) {
        await unregisterHook(token, previous.owner, previous.repo, webhookUrl).catch((err) => {
          app.log.warn(
            { err, projectId: row.id, owner: previous.owner, repo: previous.repo },
            "Could not unregister webhook for project's previous repo",
          );
        });
      }
    }
  } catch (err) {
    // Genuinely best-effort (see this function's own doc comment above):
    // a project create/update must never fail because the GitHub
    // integration subsystem is in a bad state.
    app.log.warn({ err, projectId: row.id }, "Could not register webhook for project");
  }
}

const DUPLICATE_PRIME_DELAY_MS = 30_000;

export async function projectsRoute(app: FastifyInstance) {
  // #2321 — who is acting decides the identity: a click by the user runs as
  // their connected account, never silently as the GitHub App. The App stays
  // with Task Master and unattended work (`resolveGitHubToken`).
  // detectedDevServerPort is derived, not persisted (see dev-server-detect.ts):
  // a project's own devServerUrl column is the sole authoritative value, this
  // is only ever a suggestion the frontend may offer to pre-fill it with.
  // Batched as one extra query across every returned project's active dock
  // sessions, rather than one query per project — this list is polled on
  // every dashboard refresh, so an N+1 here would cost real latency for a
  // feature nobody may even be using.
  //
  // currentBranch (issue #96) rides along on this same response rather than
  // a per-project fetch — it's cheap for a local project (git-branch.ts's
  // pure HEAD read) and, for a remote one, no worse than one extra
  // /internal/git-branch round trip per project on an already-polled list.
  // A single unreachable remote host degrades that project's own
  // currentBranch to null rather than failing the whole list — the same
  // "widget just doesn't render" posture as the /github and /git-status
  // routes below, just without a status code to express it through here.
  // Shared by GET /api/projects and GET /api/projects/:id so the two can never
  // drift: a single-project read is byte-for-byte a list row.
  async function serializeProjectRows(rows: ProjectRow[]) {
    // Phase 3 (drift detection, issue #1205, follow-up to #1201) — this install's own
    // conventions text, read ONCE for the whole list rather than per row:
    // it's install-wide, not per-project, so re-reading settings inside
    // the row loop below would just be N redundant reads of the same
    // value. Per-row resolution still differs by each project's own
    // injectWorkflowConventions opt-out — resolveWorkflowConventionsText
    // (the same pure function routes/project-setup.ts's own scaffold
    // resolution uses) applies that per row.
    const globalConventionsText = getStoredSettings(app.db).sessions.workflowConventionsText;

    const dockSessionIdsForProject = dockSessionIdsByProject(app);

    return Promise.all(
      rows.map(async (row) => {
        let currentBranch: string | null;
        // Issue #431 — the sidebar's rule-file indicator (which of
        // CLAUDE.md/AGENTS.md/AGENTS.override.md this project actually has
        // — issue #977: GEMINI.md dropped, agy's project-scope file is
        // AGENTS.md too), same "ride along on this already-polled list"
        // reasoning as currentBranch immediately above. A local project
        // does the cheap existsSync-only check directly; a remote one hits
        // the dedicated /internal/agent-rules/exists endpoint (Hermes
        // review, PR #458) — NOT /internal/agent-rules, which inlines full
        // content for all 12 targets (up to 512KB each) and would ship an
        // entire CLAUDE.md body on every sidebar mount for a names-only
        // need. A single unreachable remote host degrades that project's
        // own ruleFiles to an empty array, same "widget just doesn't
        // render" posture as currentBranch.
        let ruleFiles: string[];
        if (row.hostId === LOCAL_HOST_ID) {
          currentBranch = readGitBranch(row.cwd);
          ruleFiles = listExistingProjectRuleFileNames(row.cwd);
        } else {
          // Hermes review, PR #458 — these two used to await in series,
          // doubling this row's own latency even though the outer
          // Promise.all already runs every OTHER row concurrently. Each
          // keeps its own independent try/catch (a host failing one must
          // not also fail the other) via .catch() instead of a shared one.
          //
          // getRemoteHostClient() itself throws SYNCHRONOUSLY for a missing
          // host row or a null baseUrl (round 5 review caught this: it had
          // been hoisted out here, so that throw rejected this row's whole
          // map callback and 500'd the entire GET /api/projects instead of
          // just this project's own currentBranch/ruleFiles degrading) — so
          // it needs its own try/catch too, not just the two requests.
          try {
            const client = getRemoteHostClient(app, row.hostId);
            [currentBranch, ruleFiles] = await Promise.all([
              client.resolveGitBranch(row.cwd).catch((err: unknown) => {
                app.log.warn(
                  { hostId: row.hostId, projectId: row.id, err },
                  "host unreachable, currentBranch unavailable",
                );
                return null;
              }),
              // Names-only — see remote-host-client.ts's own doc comment on
              // resolveExistingRuleFileNames for why this isn't
              // resolveAgentRules (full content, up to 512KB x 12 targets).
              client.resolveExistingRuleFileNames(row.cwd).catch((err: unknown) => {
                app.log.warn(
                  { hostId: row.hostId, projectId: row.id, err },
                  "host unreachable, ruleFiles unavailable",
                );
                return [];
              }),
            ]);
          } catch (err) {
            app.log.warn(
              { hostId: row.hostId, projectId: row.id, err },
              "could not resolve remote host client, currentBranch/ruleFiles unavailable",
            );
            currentBranch = null;
            ruleFiles = [];
          }
        }
        // Phase 3 (drift detection) — three states, never a fourth:
        // `null` conventionsHash means "never scaffolded" (a project that
        // was never scaffolded is not "drifted," it's simply unscaffolded
        // — a distinct state the UI must not conflate with staleness).
        // Otherwise, compare the stamped hash against what this install's
        // CURRENT settings would produce for this project right now,
        // through the exact same resolveWorkflowConventionsText +
        // hashWorkflowConventionsSection pair /setup/apply itself used to
        // stamp it — reusing both functions is what keeps this comparison
        // from ever silently diverging from what was actually committed.
        //
        // Hermes review, PR #1206 round 1 — an opted-out project
        // (`injectWorkflowConventions === false`) must never report
        // drifted, full stop, regardless of what its stamped hash happens
        // to be. That flag's own documented meaning is "this project's own
        // AGENTS.md is authoritative instead" — it has explicitly stopped
        // tracking this install's global text, so comparing its hash
        // against that text is comparing against a value it no longer
        // claims to follow. Without this short-circuit, a project scaffolded
        // while opted IN (real global text committed, hash stamped from
        // that text) and later opted OUT — by any path, not just a
        // since-removed one-click toggle — would flip to a false-positive
        // "drifted" the moment resolveWorkflowConventionsText starts
        // resolving it to "" instead: the stamped hash (of the real text)
        // would stop matching hash("") forever, and the drift banner's own
        // "re-run Preview and Apply" suggestion would then silently
        // overwrite that real, previously-committed text with the generic
        // SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS stub on the next apply — a
        // data-loss bug. Gating on the opt-out flag here removes the
        // signal that would ever prompt that re-apply for such a project.
        const conventionsDrifted =
          (row.injectWorkflowConventions ?? true) &&
          row.conventionsHash !== null &&
          row.conventionsHash !==
            hashWorkflowConventionsSection(
              resolveWorkflowConventionsText(row.injectWorkflowConventions, globalConventionsText),
            );
        return {
          ...row,
          // Issue #1724 — the per-host cwd map, as an OBJECT on the way out
          // (the column holds JSON; the API speaks the same shape it
          // accepts, so the client never has to know the column's
          // encoding).
          hostCwds: { ...parseHostCwds(row.hostCwds) },
          // Issue #2090 — which entries were auto-detected, which hosts the
          // operator declined: an OBJECT on the way out, like hostCwds.
          hostCwdsMeta: parseHostCwdsMeta(row.hostCwdsMeta),
          placementConstraints: parsePlacementConstraints(row.placementConstraints),
          preProvision: parsePreProvision(row.preProvision),
          gitIdentity: parseProjectGitIdentity(row.gitIdentity) ?? null,
          ...crossProjectFieldsOut(row),
          currentBranch,
          ruleFiles,
          conventionsDrifted,
          // Remote-hosted projects are skipped outright, not just "usually
          // null": app.pty only tracks sessions spawned/attached by this
          // same process, and a remote project's dock session lives in its
          // owning agent's own PtyManager instead — see dev-server-detect.ts's
          // own comment.
          detectedDevServerPort:
            row.hostId === LOCAL_HOST_ID
              ? detectDevServerPortForSessionIds(app, dockSessionIdsForProject.get(row.id) ?? [])
              : null,
        };
      }),
    );
  }

  app.get("/api/projects", async () => {
    const rows = listProjectsByName(app);
    return serializeProjectRows(rows);
  });

  // One project, same serializer as a GET /api/projects row (issue #2148) — for
  // callers that need to re-read a single project without the list's per-row
  // work across every other project.
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
    const row = getProjectById(app, projectId);
    if (!row) return reply.notFound("Project not found");
    const [serialized] = await serializeProjectRows([row]);
    return serialized;
  });

  // A real filesystem scan (readdirSync + existsSync per candidate), so
  // rate-limited more tightly than the app-wide default in security.ts —
  // both apply (this doesn't disable the global one, just tightens it for
  // this specific route). CodeQL's js/missing-rate-limiting query flagged
  // this route as unprotected before this was added — a genuine false
  // positive (the global limiter already covered it, confirmed live: 429s
  // kicked in past RATE_LIMIT_MAX on a real running instance) since the
  // query can't trace a rate limiter registered globally from a separate
  // plugin file back to this handler, but an explicit route-level limit
  // both satisfies that check directly and is independently reasonable
  // given the cost of this specific handler.
  app.get<{ Querystring: { hostId?: string } }>(
    "/api/projects/discover",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const hostId = request.query.hostId ?? LOCAL_HOST_ID;

      let candidates: DiscoveredCandidate[];
      if (hostId === LOCAL_HOST_ID) {
        candidates = discoverCandidates(resolveProjectRoots(app));
      } else {
        if (!getHostRow(app, hostId)) return reply.notFound(`Unknown host ${hostId}`);
        try {
          candidates = await getRemoteHostClient(app, hostId).discover();
        } catch (err) {
          app.log.warn({ hostId, err }, "host unreachable, discovery unavailable");
          return reply.serviceUnavailable(`Host ${hostId} is unreachable`);
        }
      }

      // Discovery is per-host (issue #26): a cwd on one host registering
      // as "already added" must never match a same-path project on a
      // different host, so the match key is (hostId, cwd), not cwd alone.
      const registeredCwds = new Set(listProjectCwdsOnHost(app, hostId));
      // Issue #2231 — a path mapped in ANOTHER project's hostCwds is
      // registered too, and a candidate whose path or origin matches a project
      // is reported with that project so the UI can attach instead of add.
      const allProjects = listProjects(app);
      const originIndexRef = {};

      const discovered: DiscoveredProject[] = [];
      for (const c of candidates) {
        const mapped = allProjects.some((p) => projectHasPath(p, hostId, c.cwd));
        const match = await findProjectByRepoIdentity(app, {
          hostId,
          cwd: c.cwd,
          origin: c.origin ?? null,
          originIndexRef,
          projects: allProjects,
        });
        discovered.push({
          ...c,
          isRegistered: registeredCwds.has(c.cwd) || mapped,
          ...(match
            ? {
                matchedProject: {
                  id: match.project.id,
                  name: match.project.name,
                  hostId: match.project.hostId,
                  reason: match.reason,
                },
              }
            : {}),
        });
      }
      return discovered;
    },
  );

  // Issue #2090 — where does THIS project already have a clone on other hosts?
  // Read-only: it only suggests (the Edit project dialog's "Detected: <path>
  // · Use"); nothing is written. Asks each eligible host's discovery once, so
  // it shares the discover route's tight rate limit.
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/host-suggestions",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectById(app, projectId);
      if (!project) return reply.notFound();
      return { hosts: await detectCheckouts(app, project) };
    },
  );

  // ---------------------------------------------------------------------------
  // The placement PREVIEW — issue #1726 / roadmap 8.12.
  // ---------------------------------------------------------------------------
  //
  // "Where would a new session land right now, and why?" — the question a
  // user has to be able to answer before they turn automatic placement on.
  //
  // It runs the SAME decision function the spawn path uses
  // (services/placement.ts's previewPlacement, which is the one
  // resolvePlacement also calls), so the preview cannot drift from what
  // would actually happen. It differs only in that it announces nothing
  // (no "placement: chose a host" line — no placement happened) and in
  // that it writes nothing at all: it is a read.
  //
  // Two routes, one decision:
  //   - GET  /api/projects/:id/placement-preview — an existing project. The
  //     mode may be overridden with ?placement=…, because the question a UI
  //     asks is "what would happen if this project were AUTO?", which is
  //     usually NOT the mode the project is stored as (turning the mode ON
  //     is the whole point of the control). Without the override the answer
  //     would be about the stored mode — the opposite of what the user is
  //     asking.
  //   - POST /api/projects/placement-preview    — a project that does not
  //     exist yet (the create-project modal asks BEFORE the row is saved),
  //     with the would-be host and mode in the body.
  //
  // The answer is a NOW reading: load moves between the preview and the
  // spawn, so the UI labels it as such.
  app.get<{ Params: { id: string }; Querystring: { placement?: string; command?: string } }>(
    "/api/projects/:id/placement-preview",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        querystring: {
          type: "object",
          properties: {
            // The shared mode vocabulary — the same enum the project's own
            // create/PATCH schemas use, so a preview can never be asked
            // about a mode the project could not actually be set to.
            placement: { type: "string", enum: [...PLACEMENT_MODES] },
            // Issue #2240 — the launch command the preview is for, so a host
            // without its agent CLI is shown as excluded.
            command: { type: "string", maxLength: 4096 },
          },
        },
      },
    },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = getProjectById(app, projectId);
      if (!project) return reply.notFound();

      // The mode ASKED about — the picked one when the caller says so, the
      // project's own when it does not.
      const placement = (request.query.placement ?? project.placement) as PlacementMode;
      const decision = previewPlacement(app, {
        // Issue #1724 — the project's own path and its per-host map travel
        // with the question: a host the project is not on cannot host a
        // session for it, so the preview has to know WHERE the project is
        // to answer the same thing the spawn path would.
        project: {
          hostId: project.hostId,
          placement,
          cwd: project.cwd,
          hostCwds: project.hostCwds,
          placementConstraints: project.placementConstraints,
        },
        requiredAgent:
          request.query.command === undefined
            ? undefined
            : (commandAgentBin(request.query.command) ?? undefined),
      });
      return { placement, ...decision };
    },
  );

  app.post<{ Body: { hostId: string; placement?: PlacementMode } }>(
    "/api/projects/placement-preview",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["hostId"],
          properties: {
            hostId: { type: "string" },
            // The shared mode vocabulary — the same enum the project's own
            // create/PATCH schemas use, so a preview can never be asked
            // about a mode the project could not actually be set to.
            placement: { type: "string", enum: [...PLACEMENT_MODES] },
          },
        },
      },
    },
    async (request, reply) => {
      const { hostId } = request.body;
      // A preview for a host that is not registered would answer a question
      // about a machine Mullion does not know — say so rather than guess.
      if (!getHostRow(app, hostId)) return reply.notFound(`Unknown host ${hostId}`);
      const placement = request.body.placement ?? "pinned";
      // Issue #1724 — a project that does not exist yet has no per-host map:
      // it lives on the host it is being created on, and nowhere else. That
      // is the honest answer for a would-be project, and it is the same one
      // the spawn path will give once the row is saved.
      const decision = previewPlacement(app, { project: { hostId, placement } });
      return { placement, ...decision };
    },
  );

  // Merged launcher list for this project — see project-config.ts for the
  // precedence rules (package.json scripts / tasks.json / .crs/actions.json
  // layered over the global shell/agent/config presets from GET
  // /api/actions). Read-only: launching one of these is just the existing
  // POST /api/sessions using its `command` (and `id` as a stable label).
  app.get<{ Params: { id: string } }>("/api/projects/:id/actions", async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

    const project = getProjectById(app, projectId);
    if (!project) return reply.notFound();

    if (project.hostId === LOCAL_HOST_ID) {
      const globalPresets = await resolveGlobalPresets(app);
      return resolveProjectActions(project.cwd, globalPresets);
    }
    // Global presets (installed CLIs, global .crs/actions.json) come from
    // the remote agent's own host, not this process — see
    // remote-host-client.ts's resolveActions and routes/internal.ts's
    // /internal/actions, which resolves both halves host-side already.
    try {
      return await getRemoteHostClient(app, project.hostId).resolveActions(project.cwd);
    } catch (err) {
      app.log.warn({ hostId: project.hostId, err }, "host unreachable, actions unavailable");
      return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
    }
  });

  // Dock controls for this project — persistent monitors (dev server, git
  // status, logs), distinct from one-shot launchers above. Read-only config;
  // turning one "on" is just POST /api/sessions with kind: "dock" (see
  // sessions.ts) using this control's own id/command/cwd.
  //
  // Issue #73 — for a local-host project, merges in a control per
  // discovered Docker Compose service, UNDER whatever `.crs/dock.json`
  // already configures (configured wins on an `id` collision — the issue's
  // "manual overrides win"). Local-host only: resolveProjectDock,
  // /internal/dock, and RemoteHostClient.resolveDock are untouched, so a
  // remote-hosted project simply never sees discovered controls (same
  // posture as dev-server port detection — docs/dock.md).
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/dock",
    // This route now shells out to `docker` for a local-host project, so it
    // gets its OWN rate-limit bucket rather than the app-wide default (a
    // route-level `config.rateLimit` replaces the global limiter for that
    // route entirely — @fastify/rate-limit's `onRoute` hook gives a route
    // either the global hook or its own, never both). Sized for the
    // frontend's 15s-per-column poll (Dock.tsx): 120/min covers ~30 columns
    // continuously polling from one IP, comfortably above any real
    // dashboard's column count, while the backend's own 10s discovery cache
    // (docker-service-detect.ts) means the actual `docker ps` cost per poll
    // stays flat regardless.
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const project = getProjectById(app, projectId);
      if (!project) return reply.notFound();

      if (project.hostId === LOCAL_HOST_ID) {
        const configured = resolveProjectDock(project.cwd, app.config.CRS_CONFIG_DIR);
        if (!getStoredSettings(app.db).dock.dockerServices) return configured;

        const discovered = await discoveredServicesForProject(app, project);
        const discoveredControls = await toDockControls(discovered);
        const merged = new Map<
          string,
          (typeof discoveredControls)[number] | (typeof configured)[number]
        >();
        for (const control of discoveredControls) merged.set(control.id, control);
        for (const control of configured) merged.set(control.id, control);
        return [...merged.values()];
      }
      try {
        return await getRemoteHostClient(app, project.hostId).resolveDock(project.cwd);
      } catch (err) {
        app.log.warn({ hostId: project.hostId, err }, "host unreachable, dock unavailable");
        return reply.serviceUnavailable(`Host ${project.hostId} is unreachable`);
      }
    },
  );

  await projectDockerRoute(app);

  await projectGitHubRoute(app);

  await projectGitRoute(app);

  await projectGitWritesRoute(app);

  // A project that appears, changes (cwd, host checkouts), disappears or merges
  // can change which projects share an origin: refresh the duplicate check.
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode >= 300 || !["POST", "PATCH", "PUT", "DELETE"].includes(request.method))
      return;
    if (/^\/api\/projects(\/\d+(\/merge)?)?$/.test(request.url.split("?")[0])) {
      refreshDuplicateGroupsInBackground(app);
    }
  });

  app.post<{ Body: CreateProjectBody }>(
    "/api/projects",
    { schema: createProjectSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const {
        name,
        cwd,
        createDir,
        gitInit,
        placement,
        hostCwds,
        placementConstraints,
        preProvision,
        gitIdentity,
        allowDuplicate,
      } = request.body;
      const unknownHost = unknownHostInCwds(app, hostCwds);
      if (unknownHost !== null) {
        return reply.badRequest(unknownHostMessage(app, unknownHost));
      }
      const hostId = request.body.hostId ?? LOCAL_HOST_ID;
      const targetHost = hostId !== LOCAL_HOST_ID ? getHostRow(app, hostId) : undefined;
      if (hostId !== LOCAL_HOST_ID && !targetHost) {
        return reply.badRequest(`Unknown hostId ${hostId}`);
      }
      // A host added without a Base URL is still waiting for its agent: there
      // is nowhere to run the project yet.
      if (
        targetHost &&
        !isHostRegistered(app, {
          id: targetHost.id,
          baseUrl: targetHost.baseUrl,
          hasMachineIdentity: targetHost.machineCredentialEnc !== null,
        })
      ) {
        return reply.badRequest(`Host ${targetHost.name} hasn't registered yet`);
      }
      // A remote project's directory lives on the agent's own filesystem,
      // not this process's — validating/creating it here against the
      // *primary's* disk would be actively wrong. Out of scope until a
      // dedicated /internal/* agent endpoint exists.
      if (createDir && hostId !== LOCAL_HOST_ID) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: `Mullion can't create a directory on host ${hostId} — create it there and try again.`,
          code: "PROJECT_DIR_REMOTE_UNSUPPORTED",
        });
      }
      // gitInit only has an effect when createDir also creates the
      // directory (see the block below) — without this, `gitInit: true`
      // alone silently does nothing and the response omits
      // `gitInitialized` entirely, giving the caller neither an error nor
      // a result to act on.
      if (gitInit && !createDir) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "gitInit requires createDir.",
          code: "PROJECT_GIT_INIT_WITHOUT_CREATE_DIR",
        });
      }
      // The create-project modal's own placeholder is a literal `~/...`
      // path (ported from the design) — expand it the same way
      // PROJECTS_ROOTS/CRS_CONFIG_DIR already are, so a session spawned
      // against this project's cwd doesn't fail to resolve it. Only for
      // "local": a remote project's cwd expands against the *agent's* own
      // home dir, not this process's — see host-registry.ts/issue #26's
      // landmine #3 — so it's stored/forwarded raw instead.
      const resolvedCwd = hostId === LOCAL_HOST_ID ? path.resolve(expandHome(cwd)) : cwd;

      // Issue #2231 — refuse a second project for a repo that already has one,
      // BEFORE any directory is created. `allowDuplicate` is the deliberate
      // opt-out (a second checkout on the same host, a fork under one name).
      if (!allowDuplicate) {
        const duplicate = await findDuplicateProject(app, [
          { hostId, cwd: resolvedCwd },
          ...Object.entries(hostCwds ?? {}).map(([h, c]) => ({ hostId: h, cwd: c })),
        ]);
        if (duplicate) return duplicateProjectReply(reply, duplicate, "create");
      }

      // Validate (and, if confirmed, create) the directory BEFORE the row
      // is inserted, so a rejected/failed create never leaves an orphan
      // project row. CodeQL flags the mkdir this feeds as js/path-injection
      // since resolvedCwd derives from request.body.cwd — dismissed as a
      // false positive at this boundary, same as before: /api/projects is
      // the authenticated-primary boundary, and a caller who can reach it
      // can already spawn a session against an arbitrary cwd (full code
      // execution), which is strictly more powerful than mkdir on the same
      // path. Same trust model as internal.ts's resolveWithinRoots
      // docstring for session-spawn cwd. What's new is leaf-only creation
      // and pre-planted-symlink hardening — see project-dir.ts.
      let dirCreated = false;
      let gitInitialized = false;
      if (hostId === LOCAL_HOST_ID) {
        try {
          assertProjectDir(resolvedCwd);
        } catch (err) {
          if (!(err instanceof ProjectDirError)) throw err;
          if (err.issue !== "missing" || !createDir) {
            return reply.code(400).send(projectDirErrorBody(err));
          }
          try {
            dirCreated = createProjectDir(resolvedCwd);
          } catch (createErr) {
            if (!(createErr instanceof ProjectDirError)) throw createErr;
            return reply.code(400).send(projectDirErrorBody(createErr));
          }
          if (gitInit && dirCreated) {
            const result = await runGitInit(resolvedCwd);
            gitInitialized = result.success;
            if (!result.success) {
              app.log.warn({ cwd: resolvedCwd, err: result.error }, "git init failed");
            }
          }
        }
      }

      const created = insertProject(app, {
        name,
        cwd: resolvedCwd,
        hostId,
        // Issue #1724 — the per-host cwd map, serialized. Null/empty means
        // "this project lives on its own host and nowhere else".
        hostCwds: serializeHostCwds(hostCwds),
        // Issue #2241 — the steering flags; null/default flags store as null.
        placementConstraints: serializePlacementConstraints(placementConstraints),
        preProvision: serializePreProvision(preProvision),
        gitIdentity: serializeProjectGitIdentity(gitIdentity),
        // Issue #1723 / roadmap 8.9 — absent means "pinned" (the
        // column's default), so an existing project is untouched.
        ...(placement === undefined ? {} : { placement }),
      });
      await maybeRegisterProjectWebhook(app, created);
      // Runs after the webhook registration above (order doesn't matter
      // between the two — independent GitHub round trips, both best-effort)
      // so a fresh project whose repo already has release-please configured
      // gets Conventional Commits titles on from its very first task,
      // instead of everyone finding out only after a bad squash-merge title
      // silently drops out of a changelog. See project-release-please.ts's
      // own doc comment for the one-shot/human-wins contract.
      const withReleasePleaseDefault = await maybeAutoEnableConventionalTitles(app, created);
      reply.code(201);
      // Issue #1724 — the per-host cwd map, as an OBJECT (the column holds
      // JSON; the API speaks the shape it accepts, so the client never has
      // to know the encoding).
      const response = {
        ...withReleasePleaseDefault,
        hostCwds: { ...parseHostCwds(withReleasePleaseDefault.hostCwds) },
        hostCwdsMeta: parseHostCwdsMeta(withReleasePleaseDefault.hostCwdsMeta),
        placementConstraints: parsePlacementConstraints(
          withReleasePleaseDefault.placementConstraints,
        ),
        preProvision: parsePreProvision(withReleasePleaseDefault.preProvision),
        gitIdentity: parseProjectGitIdentity(withReleasePleaseDefault.gitIdentity) ?? null,
        ...crossProjectFieldsOut(withReleasePleaseDefault),
      };
      return createDir ? { ...response, dirCreated, gitInitialized } : response;
    },
  );

  // Issue #2232 — projects that share one origin, oldest first as the survivor.
  // Served from a cache that project create/edit/delete/merge invalidate;
  // `?refresh=1` (the Check button) forces a fresh read.
  app.get<{ Querystring: { refresh?: string } }>(
    "/api/projects/duplicates",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => ({
      groups: await getDuplicateGroups(app, { refresh: request.query.refresh === "1" }),
    }),
  );

  // Merge this project (the duplicate) into `into` (the survivor). Both must
  // resolve to the same origin key the create gate uses.
  app.post<{ Params: { id: string }; Body: { into: number } }>(
    "/api/projects/:id/merge",
    { schema: mergeProjectSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const duplicateId = Number(request.params.id);
      if (!Number.isInteger(duplicateId)) return reply.badRequest("Invalid project id");
      const survivorId = request.body.into;
      const pair = getProjectsByIds(app, [duplicateId, survivorId]);
      const duplicate = pair.find((p) => p.id === duplicateId);
      const survivor = pair.find((p) => p.id === survivorId);
      if (!duplicate || !survivor) return reply.notFound("Project not found");
      if (duplicate.id !== survivor.id) {
        const index = await buildOriginIndex(app, { projects: [duplicate, survivor] });
        const key = index.get(survivor.id);
        if (!key || key !== index.get(duplicate.id)) {
          return reply.code(409).send({
            statusCode: 409,
            error: "Conflict",
            message: "These projects do not share a readable origin, so they are not duplicates.",
            code: "NOT_SAME_REPO",
          });
        }
      }
      const result = mergeProjects(app, { survivorId, duplicateId });
      if (!result.ok) {
        return reply.code(result.refusal.code === "NOT_FOUND" ? 404 : 409).send({
          statusCode: result.refusal.code === "NOT_FOUND" ? 404 : 409,
          error: result.refusal.code === "NOT_FOUND" ? "Not Found" : "Conflict",
          message: result.refusal.message,
          code: `MERGE_${result.refusal.code}`,
        });
      }
      const row = getProjectOrThrow(app, survivorId);
      return {
        survivor: {
          ...row,
          hostCwds: { ...parseHostCwds(row.hostCwds) },
          hostCwdsMeta: parseHostCwdsMeta(row.hostCwdsMeta),
          placementConstraints: parsePlacementConstraints(row.placementConstraints),
          preProvision: parsePreProvision(row.preProvision),
          gitIdentity: parseProjectGitIdentity(row.gitIdentity) ?? null,
          ...crossProjectFieldsOut(row),
        },
        counts: result.counts,
      };
    },
  );

  // Issue #2231 — attach a checkout on ANOTHER host to an existing project
  // (what "Add as checkout of <project>" does) instead of creating a duplicate.
  app.post<{ Params: { id: string }; Body: { hostId: string; cwd: string } }>(
    "/api/projects/:id/host-checkouts",
    { schema: hostCheckoutSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const { hostId, cwd } = request.body;
      // Positively validate the request's host before anything is keyed by it.
      if (hostId !== LOCAL_HOST_ID && !getHostRow(app, hostId)) {
        return reply.badRequest(`Unknown hostId ${hostId}`);
      }
      if (!isStorablePath(cwd)) {
        return reply.badRequest("cwd must be an absolute path without '..' segments");
      }
      // The path must not already belong to ANOTHER project: attaching it
      // would create exactly the duplicate this feature prevents.
      const owner = findOtherProject(app, projectId, (p) => projectHasPath(p, hostId, cwd));
      if (owner) return duplicateProjectReply(reply, owner, "attach");
      const result = attachHostCheckout(app, projectId, hostId, cwd);
      if (result === "not-found") return reply.notFound();
      if (result === "own-host") {
        return reply.badRequest(
          "That is the project's own host — create a separate project instead.",
        );
      }
      if (result === "mapped") {
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message:
            "This project already has a different path on that host — edit it in Edit project.",
          code: "HOST_PATH_ALREADY_MAPPED",
        });
      }
      if (result === "limit") {
        return reply.badRequest(`A project can map at most ${MAX_HOST_CWDS} hosts.`);
      }
      const row = getProjectOrThrow(app, projectId);
      return {
        ...row,
        hostCwds: { ...parseHostCwds(row.hostCwds) },
        hostCwdsMeta: parseHostCwdsMeta(row.hostCwdsMeta),
        placementConstraints: parsePlacementConstraints(row.placementConstraints),
        preProvision: parsePreProvision(row.preProvision),
        gitIdentity: parseProjectGitIdentity(row.gitIdentity) ?? null,
        ...crossProjectFieldsOut(row),
      };
    },
  );

  // Lazy checkout materialization: the state of the clone job for a project on
  // a host (what the launcher polls after a 202 from POST /api/sessions). A host
  // the project already has a path on reads as `done`; a host nothing was
  // started for reads as `idle`.
  app.get<{ Params: { id: string; hostId: string } }>(
    "/api/projects/:id/host-checkouts/:hostId/materialize",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const { hostId } = request.params;
      const row = getProjectById(app, projectId);
      if (!row) return reply.notFound();
      const job = getMaterializeJob(projectId, hostId);
      if (job) {
        return { state: job.state, cwd: job.cwd, reason: job.reason, detail: job.detail };
      }
      const mapped = parseHostCwds(row.hostCwds)[hostId];
      if (hostId === row.hostId) return { state: "done", cwd: row.cwd };
      if (mapped !== undefined) return { state: "done", cwd: mapped };
      return { state: "idle" };
    },
  );

  // Starts (or joins) the clone job explicitly — the same job a placement
  // starts. Answers 202 with the job state; poll the GET above.
  app.post<{ Params: { id: string; hostId: string } }>(
    "/api/projects/:id/host-checkouts/:hostId/materialize",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const { hostId } = request.params;
      if (hostId !== LOCAL_HOST_ID && !getHostRow(app, hostId)) {
        return reply.badRequest(`Unknown hostId ${hostId}`);
      }
      const row = getProjectById(app, projectId);
      if (!row) return reply.notFound();
      // A new request is a retry: a failure already shown is not replayed.
      takeFailedMaterialize(projectId, hostId);
      const job = startMaterialize(app, projectId, hostId);
      reply.code(202);
      return { state: job.state, cwd: job.cwd, reason: job.reason, detail: job.detail };
    },
  );

  // Partial update — a project's own edit modal reuses CreateProjectModal
  // pre-filled, submitting whichever of name/cwd changed. Applies the same
  // expandHome() tilde-expansion POST already does, so re-pointing a
  // project at a literal `~/...` path via edit resolves the same way an
  // initial create does, rather than silently producing an unspawnable cwd.
  app.patch<{ Params: { id: string }; Body: UpdateProjectBody }>(
    "/api/projects/:id",
    { schema: updateProjectSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const existing = getProjectById(app, projectId);
      if (!existing) return reply.notFound();

      const {
        name,
        cwd,
        devServerUrl,
        autoFetch,
        defaultAgent,
        defaultReviewAgent,
        setupRecipe,
        placement,
        mergeOnApprove,
        autoApprove,
        allowCrossProjectSpawn,
        crossProjectTargets,
        acceptsChildrenFrom,
        acceptsChildrenFromList,
        acceptsMessagesFrom,
        acceptsMessagesFromList,
        maxAutoReturnRounds,
        conventionalCommitTitles,
        autoTagRelease,
        injectAgentGuide,
        injectProjectBriefing,
        injectWorkflowConventions,
        suppressConventionsInjectionAfterScaffold,
        createDir,
        gitInit,
        hostCwds,
        placementConstraints,
        preProvision,
        gitIdentity,
        allowDuplicate,
      } = request.body;
      // #2369 — naming Hermes as the default reviewer needs it set up first; the
      // resolver re-checks whenever a review agent is picked, since the setting
      // can change afterwards.
      const hermesRefusal = hermesReviewAgentRefusal(app, defaultReviewAgent);
      if (hermesRefusal) return reply.badRequest(hermesRefusal);
      // Issues #2123 / #2124 — the project lists must name real projects, and a
      // "listed" consent needs somebody on the list (an empty "listed" would be
      // "none" under another name).
      const referenced = [
        ...(crossProjectTargets ?? []),
        ...(acceptsChildrenFromList ?? []),
        ...(acceptsMessagesFromList ?? []),
      ];
      if (referenced.length > 0) {
        const known = new Set(listProjectIds(app));
        const unknown = referenced.find((id) => !known.has(id));
        if (unknown !== undefined) return reply.badRequest(`unknown project ${unknown}`);
        // A project's own id means nothing in either list (same-project children
        // never consult the rule), and would let "listed" pass its non-empty check
        // while accepting nobody.
        if (referenced.includes(projectId)) {
          return reply.badRequest("a project cannot list itself");
        }
      }
      const effectiveConsent =
        acceptsChildrenFrom === undefined ? existing.acceptsChildrenFrom : acceptsChildrenFrom;
      const effectiveConsentList =
        acceptsChildrenFromList === undefined
          ? parseProjectIdList(existing.acceptsChildrenFromList)
          : acceptsChildrenFromList;
      if (effectiveConsent === "listed" && (effectiveConsentList ?? []).length === 0) {
        return reply.badRequest("'listed' needs at least one project in acceptsChildrenFromList");
      }
      const effectiveMessages =
        acceptsMessagesFrom === undefined ? existing.acceptsMessagesFrom : acceptsMessagesFrom;
      const effectiveMessagesList =
        acceptsMessagesFromList === undefined
          ? parseProjectIdList(existing.acceptsMessagesFromList)
          : acceptsMessagesFromList;
      if (effectiveMessages === "listed" && (effectiveMessagesList ?? []).length === 0) {
        return reply.badRequest("'listed' needs at least one project in acceptsMessagesFromList");
      }
      const unknownHost = unknownHostInCwds(app, hostCwds);
      if (unknownHost !== null) {
        return reply.badRequest(unknownHostMessage(app, unknownHost));
      }
      if (
        devServerUrl !== undefined &&
        devServerUrl !== null &&
        !isValidDevServerUrl(devServerUrl)
      ) {
        return reply.badRequest("devServerUrl must be a 1-65535 port or a valid http(s) URL");
      }
      // Same rationale as POST's own gitInit-requires-createDir guard.
      if (gitInit && !createDir) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "gitInit requires createDir.",
          code: "PROJECT_GIT_INIT_WITHOUT_CREATE_DIR",
        });
      }
      if (createDir && cwd === undefined) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "createDir requires cwd.",
          code: "PROJECT_DIR_FLAG_WITHOUT_CWD",
        });
      }
      if (createDir && existing.hostId !== LOCAL_HOST_ID) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: `Mullion can't create a directory on host ${existing.hostId} — create it there and try again.`,
          code: "PROJECT_DIR_REMOTE_UNSUPPORTED",
        });
      }
      // The schema's `minProperties: 1` only guarantees the body isn't
      // completely empty — it doesn't guarantee it contains a field that
      // actually maps to a column. The two guards above already reject a
      // *truthy* createDir/gitInit with nothing else to act on; this catches
      // what's left — `{"createDir": false}` (or `{"gitInit": false}`)
      // alone, which is falsy and so skips both — before it can fall
      // through to `.update(projects).set({})` with an empty object (every
      // spread below is conditional on an undefined field), which
      // the query builder throws on ("No values to set") — a 500, not a 400.
      if (
        name === undefined &&
        cwd === undefined &&
        devServerUrl === undefined &&
        autoFetch === undefined &&
        defaultAgent === undefined &&
        defaultReviewAgent === undefined &&
        setupRecipe === undefined &&
        placement === undefined &&
        hostCwds === undefined &&
        placementConstraints === undefined &&
        preProvision === undefined &&
        gitIdentity === undefined &&
        mergeOnApprove === undefined &&
        autoApprove === undefined &&
        allowCrossProjectSpawn === undefined &&
        crossProjectTargets === undefined &&
        acceptsChildrenFrom === undefined &&
        acceptsChildrenFromList === undefined &&
        acceptsMessagesFrom === undefined &&
        acceptsMessagesFromList === undefined &&
        maxAutoReturnRounds === undefined &&
        conventionalCommitTitles === undefined &&
        autoTagRelease === undefined &&
        injectAgentGuide === undefined &&
        injectProjectBriefing === undefined &&
        injectWorkflowConventions === undefined &&
        suppressConventionsInjectionAfterScaffold === undefined
      ) {
        return reply.badRequest(
          "At least one of name, cwd, devServerUrl, autoFetch, defaultAgent, defaultReviewAgent, setupRecipe, placement, hostCwds, placementConstraints, preProvision, gitIdentity, mergeOnApprove, autoApprove, allowCrossProjectSpawn, crossProjectTargets, acceptsChildrenFrom, acceptsChildrenFromList, acceptsMessagesFrom, acceptsMessagesFromList, maxAutoReturnRounds, conventionalCommitTitles, autoTagRelease, injectAgentGuide, injectProjectBriefing, injectWorkflowConventions, or suppressConventionsInjectionAfterScaffold must be provided.",
        );
      }

      const resolvedCwd =
        cwd !== undefined && existing.hostId === LOCAL_HOST_ID
          ? path.resolve(expandHome(cwd))
          : cwd;

      // Issue #2231 — same duplicate check as POST, only for what actually
      // changes (the Edit modal always resends `cwd`), excluding this project.
      if (!allowDuplicate) {
        const changed: { hostId: string; cwd: string }[] = [];
        if (resolvedCwd !== undefined && resolvedCwd !== existing.cwd) {
          changed.push({ hostId: existing.hostId, cwd: resolvedCwd });
        }
        if (hostCwds) {
          const before = parseHostCwds(existing.hostCwds);
          for (const [h, c] of Object.entries(hostCwds)) {
            if (before[h] !== c) changed.push({ hostId: h, cwd: c });
          }
        }
        const duplicate = await findDuplicateProject(app, changed, projectId);
        if (duplicate) return duplicateProjectReply(reply, duplicate, "update");
      }

      // Validate/create BEFORE the row is updated — same ordering rationale
      // as POST. Skipped entirely when the cwd isn't actually changing: the
      // Edit modal always sends `cwd`, even when only the name changed, and
      // a project whose directory was since deleted must still be
      // renamable rather than getting stuck unable to save any edit.
      let dirCreated = false;
      let gitInitialized = false;
      if (
        cwd !== undefined &&
        existing.hostId === LOCAL_HOST_ID &&
        resolvedCwd !== undefined &&
        resolvedCwd !== existing.cwd
      ) {
        try {
          assertProjectDir(resolvedCwd);
        } catch (err) {
          if (!(err instanceof ProjectDirError)) throw err;
          if (err.issue !== "missing" || !createDir) {
            return reply.code(400).send(projectDirErrorBody(err));
          }
          try {
            dirCreated = createProjectDir(resolvedCwd);
          } catch (createErr) {
            if (!(createErr instanceof ProjectDirError)) throw createErr;
            return reply.code(400).send(projectDirErrorBody(createErr));
          }
          if (gitInit && dirCreated) {
            const result = await runGitInit(resolvedCwd);
            gitInitialized = result.success;
            if (!result.success) {
              app.log.warn({ cwd: resolvedCwd, err: result.error }, "git init failed");
            }
          }
        }
      }

      const updated = updateProject(app, projectId, {
        ...(name !== undefined ? { name } : {}),
        ...(cwd !== undefined ? { cwd: resolvedCwd } : {}),
        ...(devServerUrl !== undefined ? { devServerUrl } : {}),
        ...(autoFetch !== undefined ? { autoFetch } : {}),
        ...(defaultAgent !== undefined ? { defaultAgent } : {}),
        ...(defaultReviewAgent !== undefined ? { defaultReviewAgent } : {}),
        // A blank recipe is "none": stored as null so nothing runs.
        ...(setupRecipe !== undefined ? { setupRecipe: setupRecipe?.trim() || null } : {}),
        // Issue #1723 / roadmap 8.9 — the placement opt-in.
        ...(placement !== undefined ? { placement } : {}),
        // Issue #2241 — the steering flags. `null` (or default flags) clears them.
        ...(placementConstraints !== undefined
          ? { placementConstraints: serializePlacementConstraints(placementConstraints) }
          : {}),
        // Pre-provisioned checkouts. `null` (or "none") clears them.
        ...(preProvision !== undefined
          ? { preProvision: serializePreProvision(preProvision) }
          : {}),
        // The git identity override. `null` clears it.
        ...(gitIdentity !== undefined
          ? { gitIdentity: serializeProjectGitIdentity(gitIdentity) }
          : {}),
        // Issue #1724 — the per-host cwd map. `null` clears it.
        ...(hostCwds !== undefined
          ? {
              hostCwds: serializeHostCwds(hostCwds),
              // Issue #2090 — saving the map is the operator's decision: a
              // removed host is declined (auto-detect never re-adds it),
              // every kept one stops being "auto-detected".
              hostCwdsMeta: serializeHostCwdsMeta(
                metaAfterOperatorSave(
                  { hostCwds: existing.hostCwds, meta: existing.hostCwdsMeta },
                  hostCwds ?? {},
                  new Set(listHosts(app).map((h) => h.id)),
                ),
              ),
            }
          : {}),
        ...(mergeOnApprove !== undefined ? { mergeOnApprove } : {}),
        ...(autoApprove !== undefined ? { autoApprove } : {}),
        ...(allowCrossProjectSpawn !== undefined ? { allowCrossProjectSpawn } : {}),
        ...(crossProjectTargets !== undefined
          ? { crossProjectTargets: serializeProjectIdList(crossProjectTargets) }
          : {}),
        ...(acceptsChildrenFrom !== undefined
          ? { acceptsChildrenFrom: acceptsChildrenFrom === "any" ? null : acceptsChildrenFrom }
          : {}),
        ...(acceptsChildrenFromList !== undefined
          ? { acceptsChildrenFromList: serializeProjectIdList(acceptsChildrenFromList) }
          : {}),
        // Issue #2270 — "none" is the default for messages, so it is stored as null.
        ...(acceptsMessagesFrom !== undefined
          ? { acceptsMessagesFrom: acceptsMessagesFrom === "none" ? null : acceptsMessagesFrom }
          : {}),
        ...(acceptsMessagesFromList !== undefined
          ? { acceptsMessagesFromList: serializeProjectIdList(acceptsMessagesFromList) }
          : {}),
        ...(maxAutoReturnRounds !== undefined ? { maxAutoReturnRounds } : {}),
        // A human PATCHing this field — on, or explicitly back off — is a
        // deliberate decision that must permanently outrank the
        // release-please auto-enable sweep (project-release-please.ts),
        // including when it hasn't run for this project yet: without
        // stamping conventionalCommitTitlesResolvedAt here too, an
        // explicit `false` set before the sweep's first pass would look
        // identical to "never decided," and the next reconciler tick
        // would silently flip it back on. See that column's own doc
        // comment in schema.ts.
        ...(conventionalCommitTitles !== undefined
          ? { conventionalCommitTitles, conventionalCommitTitlesResolvedAt: new Date() }
          : {}),
        ...(autoTagRelease !== undefined ? { autoTagRelease } : {}),
        ...(injectAgentGuide !== undefined ? { injectAgentGuide } : {}),
        ...(injectProjectBriefing !== undefined ? { injectProjectBriefing } : {}),
        ...(injectWorkflowConventions !== undefined ? { injectWorkflowConventions } : {}),
        ...(suppressConventionsInjectionAfterScaffold !== undefined
          ? { suppressConventionsInjectionAfterScaffold }
          : {}),
      });
      if (!updated) return reply.notFound();
      // #490b — a cwd change can point this project at a different repo
      // (or a repo for the first time), so re-run registration the same
      // way create does. `registerProjectWebhook`'s own PATCH-on-conflict
      // behavior (github-webhook.ts) means re-registering an unchanged
      // repo is a harmless no-op, not a duplicate hook.
      if (cwd !== undefined) await maybeRegisterProjectWebhook(app, updated);
      // Issue #1724 — the per-host cwd map, as an OBJECT (see the create
      // handler's own comment).
      const response = {
        ...updated,
        hostCwds: { ...parseHostCwds(updated.hostCwds) },
        hostCwdsMeta: parseHostCwdsMeta(updated.hostCwdsMeta),
        placementConstraints: parsePlacementConstraints(updated.placementConstraints),
        preProvision: parsePreProvision(updated.preProvision),
        gitIdentity: parseProjectGitIdentity(updated.gitIdentity) ?? null,
        ...crossProjectFieldsOut(updated),
      };
      return createDir ? { ...response, dirCreated, gitInitialized } : response;
    },
  );

  // Fully terminates every session under this project (master + program,
  // not just our tracked attach-client — see PtyManager.terminate()) before
  // the row delete, whose ON DELETE CASCADE only removes the DB rows.
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const projectId = Number(request.params.id);
    if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

    const project = getProjectById(app, projectId);
    if (!project) return reply.notFound();

    const projectSessions = listSessionsForProject(app, projectId);
    const backend = resolveBackend(app, project.hostId);
    await Promise.all(
      projectSessions.map((session) =>
        backend.terminate(String(session.id)).catch((err) => {
          // Best-effort, same as hosts.ts's cascade delete: an unreachable
          // host can't be told to terminate anything, and that must not
          // block deleting the (now orphaned-on-that-host) project row.
          app.log.warn(
            { hostId: project.hostId, sessionId: session.id, err },
            "project delete: best-effort session terminate failed",
          );
        }),
      ),
    );

    // #490b — best-effort: tear down this project's own webhook before
    // the row (and its cascade-deleted webhook_registrations record) is
    // gone. Reads owner/repo from the registration row itself, not a
    // fresh resolveRepoRef(project.cwd) — the project may already be
    // mid-delete on disk, and the registered repo is the one that
    // actually has the hook regardless of what the cwd resolves to now.
    const registration = getWebhookRegistration(app, projectId);
    // #2251 — unregisterHook deletes every Mullion hook on the repo, so it must
    // not run while another project on the same repo (compared lower-cased)
    // still relies on it. The deleted project's registration row cascades away
    // with the project either way.
    let hookShared = false;
    if (registration?.hookId) {
      const sharedKey = repoKey(registration);
      const others = listOtherProjectLocations(app, projectId);
      const keys = await resolveRepoKeys(app, others);
      // Fails closed: a project whose repo can't be resolved right now (host
      // unreachable, even past the import deferral window) may share the hook,
      // so it keeps the hook alive.
      hookShared = others.some((p) => {
        const r = keys.get(p.id);
        return !r || r.unresolved || r.key === sharedKey;
      });
      if (hookShared) {
        app.log.info(
          { projectId, owner: registration.owner, repo: registration.repo },
          "project delete: webhook kept, another project uses the same repo",
        );
      }
    }
    if (registration?.hookId && !hookShared) {
      const token = getToken(app);
      if (token) {
        await unregisterHook(
          token,
          registration.owner,
          registration.repo,
          buildWebhookUrl(app),
        ).catch((err) => {
          app.log.warn(
            { err, projectId, owner: registration.owner, repo: registration.repo },
            "project delete: best-effort webhook unregister failed",
          );
        });
      }
    }

    if (!deleteProject(app, projectId)) return reply.notFound();
    reply.code(204);
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/dev-server-status",
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectById(app, projectId);
      if (!project) return reply.notFound("Project not found");

      if (!project.devServerUrl) {
        return { online: false };
      }

      if (project.hostId !== LOCAL_HOST_ID) {
        // Only the port (+ scheme) is resolved and forwarded — never the
        // full URL or host — so a remote-hosted project can't turn this
        // route into a TCP-connect probe of arbitrary hosts reachable from
        // the agent. Same rule preview-proxy.ts already applies to remote
        // previews (portFromUrl, imported above).
        const target = parseDevServerTarget(project.devServerUrl);
        if (!target) return { online: false };
        try {
          return await getRemoteHostClient(app, project.hostId).getDevServerStatus(
            target.port,
            target.scheme,
          );
        } catch (err) {
          // This route's whole contract is a boolean, so an unreachable
          // agent or a version-skewed one rejecting the (new) query-param
          // shape both collapse to "not online" rather than a 500 — same
          // "never propagate a proxy failure as this route's own 500"
          // posture as the currentBranch/ruleFiles remote lookups above,
          // just returning false here instead of omitting a field, since
          // there's no partial-response shape for a single boolean. Logged
          // distinctly (Hermes review, PR #533) so "agent never responded"
          // is still distinguishable from "agent responded and rejected."
          const message =
            err instanceof HostRequestError
              ? "agent rejected dev-server-status request, reporting offline"
              : "host unreachable, reporting dev-server-status offline";
          app.log.warn({ hostId: project.hostId, projectId, err }, message);
          return { online: false };
        }
      }

      // Local: a bare port means "this same machine" (isValidDevServerUrl's
      // own comment) — pingDevServer needs a real URL, so resolve it the
      // same way preview-proxy.ts's resolveUpstreamBase does for a local
      // target. A full URL is honored as-is, including its own host (this
      // process trusts itself, same admin-trust level as hosts.ts's own
      // baseUrl) — only the remote branch above restricts to a bare
      // port/scheme, never a caller-supplied host.
      const localUrl = DEV_SERVER_PORT_ONLY.test(project.devServerUrl)
        ? `http://127.0.0.1:${project.devServerUrl}`
        : project.devServerUrl;
      const online = await pingDevServer(localUrl);
      return { online };
    },
  );

  // Production only (like system-resources' warm-up): prime the duplicate
  // cache a little after start, so remote hosts have connected and their
  // origins are readable, and a pre-existing duplicate rings the bell once.
  if (app.config.NODE_ENV === "production") {
    app.addHook("onReady", async () => {
      refreshDuplicateGroupsInBackground(app, DUPLICATE_PRIME_DELAY_MS);
    });
  }
  app.addHook("onClose", async () => cancelDuplicateRefresh(app));
}

export function pingDevServer(urlStr: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
      const host = url.hostname || "localhost";
      const socket = net.connect({ host, port, timeout: timeoutMs }, () => {
        // For HTTP URLs, send a HEAD request to verify the server is
        // responding to HTTP, not just accepting TCP connections.
        // For HTTPS, TLS makes an inline request unworkable without the
        // tls module, so fall back to TCP-level only.
        if (url.protocol === "https:") {
          socket.end();
          resolve(true);
          return;
        }
        socket.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let responded = false;
      socket.on("data", (chunk: Buffer) => {
        if (responded) return;
        const text = chunk.toString("utf8");
        if (text.startsWith("HTTP/")) {
          responded = true;
          socket.end();
          resolve(true);
        }
      });
      socket.on("error", () => {
        if (!responded) resolve(false);
      });
      socket.on("close", () => {
        if (!responded) resolve(false);
      });
      socket.on("timeout", () => {
        socket.destroy();
        if (!responded) resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}
