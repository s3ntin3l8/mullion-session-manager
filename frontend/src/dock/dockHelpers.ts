import type { DockControl, DockerServiceInfo, Session } from "../api/index.js";

// Pure helpers for Dock.tsx's monitor rendering — split out (Wave 5 / PR 28
// of .claude/plans/can-we-do-a-warm-cocke.md) for the same
// react-refresh/only-export-components reason kanban.ts and tasksBoard.ts
// document, so they're directly unit-testable without mounting anything.
// (They were previously indirectly covered only through Dock.test.tsx's
// full-component renders — that coverage is unaffected by this move, this
// file's own dockHelpers.test.ts adds direct coverage on top.)

/** Last path segment, then the tag after its final `:` — "latest" when the
 * ref carries no explicit tag (compose's own default). A `name@sha256:...`
 * digest reference is handled first (Hermes review — splitting on `:`
 * alone would wrongly return the bare string "sha256" for one), shown as a
 * short digest prefix instead. Not exhaustive beyond that (doesn't handle a
 * registry host with a literal port, e.g. "host:5000/repo" with no tag),
 * but good enough for a compact pill; the full ref is always available via
 * the pill's own title attribute. */
export function imageTag(imageRef: string): string {
  const lastSegment = imageRef.split("/").pop() ?? imageRef;
  const atIndex = lastSegment.indexOf("@");
  if (atIndex !== -1) {
    const digest = lastSegment.slice(atIndex + 1);
    return digest.length > 19 ? digest.slice(0, 19) : digest; // "sha256:" + 12 hex chars
  }
  const colonIndex = lastSegment.lastIndexOf(":");
  return colonIndex === -1 ? "latest" : lastSegment.slice(colonIndex + 1);
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

// Maps the aggregate CI read (src/services/github.ts's computeCiStatus) to
// the same 3-color dot language GitHubPanel.tsx's Actions section uses
// (issue #27 phase 5) — `null` (Actions disabled/no runs) renders nothing
// at all, not a neutral dot, so this is only called when non-null.
export function ciDotClass(
  status: "success" | "failure" | "in_progress",
): "good" | "bad" | "pending" {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  return "pending";
}

// Mirrors src/services/git-worktree.ts's isDockPreviewWorktree/
// DOCK_PREVIEW_PREFIX — keep the two in sync. A dock preview worktree is
// transient and checked out with a DETACHED HEAD (PR #341 review), so
// listWorktrees reports its `branch` as null, meaning it no longer gets
// filtered out of the branch dropdown's own "<branch> (preview)" options
// (correct — that entry must stay available) but WOULD otherwise show up a
// second time in the worktree options, labeled with its raw path. Filtering
// it out here also closes a pre-existing gap: selecting a preview worktree
// by path created a session with a plain `cwd` and no `worktree` intent, so
// the backend never tracked it for sync/cleanup.
export function isDockPreviewPath(worktreePath: string): boolean {
  return (worktreePath.split("/").pop() ?? "").startsWith("dock-preview-");
}

/**
 * Resolves which option value a monitor's worktree/branch `<select>` should
 * show. The result is always a member of `optionValues` when one exists at
 * all — a dock-preview worktree is deliberately absent from those options
 * (see `isDockPreviewPath`), so naively preferring a running session's raw
 * `cwd` would render the select blank whenever that cwd happens to be a
 * preview path. Order of preference:
 *
 * 1. A running preview session's `previewBranch`, re-expressed as the
 *    `branch:<name>` option value — the only way to resolve a running
 *    preview session back to an option, since its `cwd` is never one.
 * 2. A running session's `cwd`, when that cwd matches a real option (the
 *    common case: running in the main checkout or a real worktree).
 * 3. The user's last manual selection, when it still matches an option.
 * 4. An escape hatch for the moment right after a launch, before
 *    `refreshGitRefs` has picked up a brand-new worktree/branch — but never
 *    for a dock-preview path, which must never be the select's value.
 * 5. The main checkout, then the control's own configured cwd, then "".
 */
export function resolveSelectedValue(params: {
  running: Session | undefined;
  storedValue: string | undefined;
  optionValues: Set<string>;
  mainCheckoutPath: string | undefined;
  controlCwd: string | undefined;
}): string {
  const { running, storedValue, optionValues, mainCheckoutPath, controlCwd } = params;

  const previewValue = running?.previewBranch ? `branch:${running.previewBranch}` : null;
  if (previewValue && optionValues.has(previewValue)) return previewValue;

  if (running?.cwd && optionValues.has(running.cwd)) return running.cwd;

  if (storedValue && optionValues.has(storedValue)) return storedValue;

  if (running?.cwd && !isDockPreviewPath(running.cwd)) return running.cwd;
  if (storedValue && !storedValue.startsWith("branch:") && !isDockPreviewPath(storedValue)) {
    return storedValue;
  }

  return mainCheckoutPath ?? controlCwd ?? "";
}

/**
 * A stable session identity for a discovered Docker log-stream control,
 * persisted as the session's own `name` (PR3 of
 * .claude/plans/can-you-investigate-our-silly-lark.md). `control.command`
 * is reconstructed fresh from live container labels on every discovery poll
 * (composeContextFlags in docker-service-detect.ts) — it can change text
 * between polls (a different config-file resolution, a fallback path
 * kicking in) without the underlying service having changed at all, which
 * would silently orphan a running log session if matched by command string
 * alone. `containerName` is compose's own deterministic
 * `<project>-<service>-<replica>` and survives a container recreation with
 * the same service definition, so it's the stabler key. Returns `null` for
 * a non-docker (dock.json) control, which has no such identity yet and
 * keeps matching by command string (see `runningFor` below).
 */
export function dockerSessionIdentity(control: DockControl): string | null {
  return control.docker ? `docker-logs:${control.docker.containerName}` : null;
}

/**
 * Resolves the live session (if any) for a dock control. Prefers matching
 * by `dockerSessionIdentity` for a docker-sourced control — stable across a
 * re-synthesized `command` string — falling back to the original
 * command-string match, which is still the only association a non-docker
 * (dock.json) control has.
 */
export function runningSessionFor(
  control: DockControl,
  dockSessions: readonly Session[],
): Session | undefined {
  const identity = dockerSessionIdentity(control);
  if (identity !== null) {
    const byIdentity = dockSessions.find((s) => s.name === identity);
    if (byIdentity) return byIdentity;
  }
  return dockSessions.find((s) => s.command === control.command);
}

// A stack-wide action's own ephemeral DockControl (POST .../docker/{update,
// stack/restart,stack/apply,stack/rebuild,stack/stop}'s response — see
// startStackSession/the docker/update route in src/routes/projects.ts) has
// no `docker` field, only an id of `<actionId>:<composeProject>`. This is
// the fixed set of actionId prefixes those five routes ever emit — kept in
// sync with them by hand, not derived, since the frontend has no other
// reachable source of truth for it.
const EPHEMERAL_STACK_ACTION_PREFIXES: readonly string[] = [
  "docker-update",
  "docker-restart",
  "docker-apply",
  "docker-rebuild",
  "docker-stop",
];

/**
 * The compose project a Dock control belongs to, for grouping every
 * service/ephemeral belonging to the same `docker compose` stack under one
 * header (issue #73 follow-up — "one stack action menu per stack" rather
 * than the stack-wide actions repeating on every service row). A
 * `docker`-bearing control (a discovered service) answers directly; an
 * ephemeral stack-action control is parsed against the known id prefixes
 * above. Returns `null` for anything else — a plain dock.json control, or
 * an ephemeral control this function doesn't recognize — which callers
 * must NOT fold into a group (see groupDockerControls's `ungrouped`).
 */
export function composeProjectForControl(control: DockControl): string | null {
  if (control.docker) return control.docker.composeProject;
  const colonIndex = control.id.indexOf(":");
  if (colonIndex === -1) return null;
  const prefix = control.id.slice(0, colonIndex);
  if (!EPHEMERAL_STACK_ACTION_PREFIXES.includes(prefix)) return null;
  const composeProject = control.id.slice(colonIndex + 1);
  return composeProject.length > 0 ? composeProject : null;
}

export interface DockerStackGroup {
  composeProject: string;
  /** Render order within the group: ephemerals first (their own arrival
   * order), then discovered services — same order groupDockerControls's
   * caller passed in. */
  controls: DockControl[];
  /** Representative control for the stack-wide actions that apply to ANY
   * service regardless of registry-vs-build (restart/apply/stop) — every
   * stack-wide route resolves its compose context from whichever
   * controlId it's given (composeContextArgs in
   * src/services/docker-service-detect.ts), so any member works. `null`
   * only when the group has no docker-bearing control at all (ephemerals
   * only) — a group in that state renders its label with no kebab. */
  anyRep: DockControl | null;
  /** Representative for POST .../docker/update — that route 400s on a
   * build-only service (src/routes/projects.ts), so this is `null` unless
   * at least one service in the group has a registry image. */
  pullRep: DockControl | null;
  /** Representative for POST .../docker/stack/rebuild — the mirror-image
   * guard requires buildOnly === true, so this is `null` unless at least
   * one service in the group is build-only. A MIXED stack (one registry
   * image, one build-only) gets both pullRep and rebuildRep non-null,
   * which is intentional — see the group's own PR description: this is a
   * pure regrouping, not a new aggregate policy, so a shape that offered
   * both actions per-row before still offers both after, just once. */
  rebuildRep: DockControl | null;
}

/**
 * From a group's docker-bearing controls, the ones a hoisted stack kebab
 * fires against. Prefers a RUNNING container — a dead one's own labels are
 * what composeContextArgs reads to reconstruct compose's `-f`/
 * `--project-directory` flags, so a stopped container is a worse source of
 * truth than a running sibling in the same stack — then breaks ties by
 * service name for a deterministic pick across polls/reorders.
 */
function selectRepresentatives(controls: readonly DockControl[]): {
  anyRep: DockControl | null;
  pullRep: DockControl | null;
  rebuildRep: DockControl | null;
} {
  const withDocker = controls.filter(
    (c): c is DockControl & { docker: DockerServiceInfo } => c.docker !== undefined,
  );
  const sorted = [...withDocker].sort((a, b) => {
    const aRunning = a.docker.state === "running" ? 0 : 1;
    const bRunning = b.docker.state === "running" ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    // Plain ordinal comparison, not localeCompare — this pick must be
    // deterministic across polls/reorders (see this function's own doc
    // comment), and localeCompare's result can vary by the runtime's
    // default locale/ICU data for names differing only in case/punctuation.
    return a.docker.service < b.docker.service ? -1 : a.docker.service > b.docker.service ? 1 : 0;
  });
  return {
    anyRep: sorted[0] ?? null,
    pullRep: sorted.find((c) => !c.docker.buildOnly) ?? null,
    rebuildRep: sorted.find((c) => c.docker.buildOnly) ?? null,
  };
}

/**
 * Splits Dock's docker-sourced controls (discovered services + any live
 * ephemeral stack-action monitors) into one `DockerStackGroup` per compose
 * project — sorted by project name so a poll reordering the underlying
 * array can't visually reorder the columns — plus an `ungrouped` list for
 * anything composeProjectForControl can't place. Derived fresh from
 * whatever `controls` the caller currently has on every call; never
 * memoized across polls, so a container that disappears or a group that
 * empties out just stops appearing on the next render.
 */
export function groupDockerControls(controls: readonly DockControl[]): {
  groups: DockerStackGroup[];
  ungrouped: DockControl[];
} {
  const byProject = new Map<string, DockControl[]>();
  const ungrouped: DockControl[] = [];
  for (const control of controls) {
    const composeProject = composeProjectForControl(control);
    if (composeProject === null) {
      ungrouped.push(control);
      continue;
    }
    const existing = byProject.get(composeProject);
    if (existing) existing.push(control);
    else byProject.set(composeProject, [control]);
  }
  const groups = [...byProject.entries()]
    // Plain ordinal comparison, not localeCompare — see selectRepresentatives'
    // own comment above for why: this order must be stable across polls
    // regardless of the runtime's default locale.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([composeProject, groupControls]) => ({
      composeProject,
      controls: groupControls,
      ...selectRepresentatives(groupControls),
    }));
  return { groups, ungrouped };
}
