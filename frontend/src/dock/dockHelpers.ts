import type { DockControl, Session } from "../api/index.js";

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
