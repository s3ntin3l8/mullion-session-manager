import type { DockControl, DockerServiceInfo, Session } from "../api/index.js";

// Pure helpers for Dock.tsx's monitor rendering — split out (Wave 5 / PR 28
// of .claude/plans/can-we-do-a-warm-cocke.md) for the same
// react-refresh/only-export-components reason kanban.ts and tasksBoard.ts
// document, so they're directly unit-testable without mounting anything.
// (They were previously indirectly covered only through Dock.test.tsx's
// full-component renders — that coverage is unaffected by this move, this
// file's own dockHelpers.test.ts adds direct coverage on top.)

const DIGEST_PREFIX_LENGTH = 19; // "sha256:" + 12 hex chars

/** Truncates a `sha256:<hex>` digest to a short, legible prefix — shared by
 * both branches below that can hand `imageTag` a full 64-char digest. */
function shortenDigest(digest: string): string {
  return digest.length > DIGEST_PREFIX_LENGTH ? digest.slice(0, DIGEST_PREFIX_LENGTH) : digest;
}

/** Last path segment, then the tag after its final `:` — "latest" when the
 * ref carries no explicit tag (compose's own default). A `name@sha256:...`
 * digest reference is handled first (Hermes review — splitting on `:`
 * alone would wrongly return the bare string "sha256" for one), shown as a
 * short digest prefix instead — and so is a BARE `sha256:<64 hex>` ref with
 * no name/tag at all (Hermes review, issue #1221's own PR): without this,
 * a service whose container reports a bare digest — build-only or not,
 * e.g. a registry image that's since been pruned locally too — showed the
 * full, unshortened 64-char hash in the pill. Not exhaustive beyond that
 * (doesn't handle a registry host with a literal port, e.g.
 * "host:5000/repo" with no tag), but good enough for a compact pill; the
 * full ref is always available via the pill's own title attribute. */
export function imageTag(imageRef: string): string {
  const lastSegment = imageRef.split("/").pop() ?? imageRef;
  const atIndex = lastSegment.indexOf("@");
  if (atIndex !== -1) {
    return shortenDigest(lastSegment.slice(atIndex + 1));
  }
  if (/^sha256:[0-9a-f]{64}$/i.test(lastSegment)) {
    return shortenDigest(lastSegment);
  }
  const colonIndex = lastSegment.lastIndexOf(":");
  return colonIndex === -1 ? "latest" : lastSegment.slice(colonIndex + 1);
}

/** A bare `sha256:<64 hex>` digest, no repo path or tag at all — imageTag()
 * doesn't special-case this shape (only the `name@sha256:...` digest-
 * reference form above), so it falls through to returning the full 64-char
 * digest untruncated. This is exactly what a build-only service's own
 * container reports once its old, default-named image (still shaped
 * `<composeProject>-<service>`) has been superseded by a later build and
 * pruned — issue #1221. */
function isBareDigestRef(imageRef: string): boolean {
  return /^sha256:[0-9a-f]{64}$/i.test(imageRef);
}

/** Pill text for a service's image: imageTag()'s tag/digest-prefix by
 * default, but compose's own default build-image name
 * (`<composeProject>-<service>`) for a build-only service whose `imageRef`
 * has degraded to a bare digest — a far more legible label than a raw hash,
 * and still correct (it's the name the service would carry again the next
 * time it's rebuilt). The full `imageRef` stays available either way via
 * the pill's own `title` attribute (DockMonitor.tsx). */
export function imagePillLabel(
  docker: Pick<DockerServiceInfo, "composeProject" | "service" | "buildOnly" | "imageRef">,
): string {
  if (docker.buildOnly && isBareDigestRef(docker.imageRef)) {
    return `${docker.composeProject}-${docker.service}`;
  }
  return imageTag(docker.imageRef);
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

// Issue #1112 (folded into the dock log-streaming resize fix) — a stack-wide
// action's own ephemeral DockControl (POST .../docker/{update,
// stack/restart,stack/apply,stack/rebuild,stack/stop}'s response — see
// startStackSession/the docker/update route in src/routes/projects.ts) now
// carries `composeProject` as a real field, so composeProjectForControl
// below no longer needs to parse it back out of `id`. This fallback list
// stays only for a control from before this field existed (a stale
// optimistic control still sitting in Dock.tsx's own `ephemeralControls`
// state across a hot-reload, or a caller this repo doesn't control) — the
// fixed set of actionId prefixes those five routes ever emit, kept in sync
// with them by hand.
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
 * than the stack-wide actions repeating on every service row). Prefers the
 * real `composeProject` field (issue #1112) when present — set on every
 * ephemeral stack-action control the backend emits, and on every control
 * reconstructed from a live `docker-stack:<composeProject>` session
 * (Dock.tsx, dock log-streaming resize fix symptom 3) — falling back to
 * `docker.composeProject` for a discovered service, then to parsing the
 * legacy `<actionId>:<composeProject>` id shape for a control from before
 * either field existed. Returns `null` for anything else — a plain
 * dock.json control, or an ephemeral control this function doesn't
 * recognize — which callers must NOT fold into a group (see
 * groupDockerControls's `ungrouped`).
 */
export function composeProjectForControl(control: DockControl): string | null {
  if (control.composeProject) return control.composeProject;
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
 *
 * `heldIds` (PR2b) excludes a held control from candidacy entirely, not just
 * from winning the sort: a held control's `docker.state` is frozen at
 * whatever it was before it vanished from discovery (holdVanishedDockerControls'
 * own doc comment), so a stale "running" must never outrank a genuinely
 * running sibling, and a group where every service happens to be held must
 * fall through to the same all-null result as an ephemerals-only group —
 * not a representative computed from stale state, which the backend can no
 * longer resolve against live discovery anyway.
 */
function selectRepresentatives(
  controls: readonly DockControl[],
  heldIds: ReadonlySet<string>,
): {
  anyRep: DockControl | null;
  pullRep: DockControl | null;
  rebuildRep: DockControl | null;
} {
  const withDocker = controls.filter(
    (c): c is DockControl & { docker: DockerServiceInfo } =>
      c.docker !== undefined && !heldIds.has(c.id),
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
 *
 * `heldIds` (PR2b, default empty) marks a control as present in `controls`
 * for rendering/sizing purposes — a held control's ROW must not disappear,
 * which is the whole point of holding it — while excluding it from
 * `selectRepresentatives`' candidate pool, since its `docker.state` is
 * stale. Callers that never hold anything (there is no PR2b caller today
 * outside Dock.tsx) can omit the argument entirely.
 */
export function groupDockerControls(
  controls: readonly DockControl[],
  heldIds: ReadonlySet<string> = new Set(),
): {
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
      ...selectRepresentatives(groupControls, heldIds),
    }));
  return { groups, ungrouped };
}

/**
 * Holds a discovered docker-sourced control across a brief discovery gap —
 * discovery is `docker ps -a`-driven (docker-service-detect.ts's
 * probeComposeServices), not compose-config-driven, so a `compose up -d`
 * recreate genuinely deletes a service's old container before creating the
 * new one, and the service is legitimately absent from one or two polls
 * mid-rebuild. Without this, a compose group's control count — and
 * therefore its `flexGrow` share of the column (Dock.tsx) — drops and rises
 * once per service on every recreate, resizing every OTHER monitor in the
 * group each time (issue: rebuilding a stack makes the whole dock resize
 * repeatedly).
 *
 * Re-inserts a vanished control at its previous index (relative to `next`,
 * clamped to the current length) so a held row doesn't visually jump to the
 * end of its group while it's held. Only a `source: "docker"` control is
 * ever held — a `dock.json` control's presence is config, not container
 * state, so it's never "vanished" in the sense this guards against.
 *
 * Fully pure — `vanishedAt` (id -> the timestamp it was first observed
 * missing) is read-only in, a fresh Map out, never mutated. Dock.tsx calls
 * this from its OWN render body (not an effect): a passive effect's
 * `setState` only takes effect on the NEXT commit, after the browser has
 * already painted the current one — for a compose group whose only control
 * just vanished, that stale commit has already dropped the group's `&lt;div&gt;`
 * (and its `TerminalPane` child) by the time the correction lands, i.e. the
 * exact unmount/remount flicker this function exists to prevent. Rendering
 * from a mutated-in-place Map would reintroduce the same class of bug one
 * level down — React's dev-only StrictMode double-invokes a component's
 * render body, and the SECOND invocation would then read back the FIRST
 * invocation's mutations as its own "previous" state, computing a wrong
 * diff. Returning a new Map keeps every render (however many times React
 * calls it) a pure function of the STATE it's given, which is what makes
 * comparing against `useState`-held previous values (see Dock.tsx's own
 * call site) safe under that double-invoke.
 *
 * An id present in `next` always drops out of the returned map (real
 * re-appearance, or the grace expiring on some earlier tick, both end the
 * hold the same way), and an id absent for `graceMs` or more is dropped
 * rather than held forever, so a service actually removed via
 * `compose down` still disappears from the Dock promptly.
 */
export function holdVanishedDockerControls(
  prev: readonly DockControl[],
  next: readonly DockControl[],
  vanishedAt: ReadonlyMap<string, number>,
  now: number,
  graceMs: number,
): { controls: DockControl[]; heldIds: Set<string>; vanishedAt: Map<string, number> } {
  const nextIds = new Set(next.map((c) => c.id));
  const nextVanishedAt = new Map(vanishedAt);
  for (const id of nextIds) nextVanishedAt.delete(id);

  const merged = [...next];
  const heldIds = new Set<string>();
  prev.forEach((control, prevIndex) => {
    if (control.source !== "docker") return;
    if (nextIds.has(control.id)) return;
    const firstMissingAt = nextVanishedAt.get(control.id) ?? now;
    nextVanishedAt.set(control.id, firstMissingAt);
    if (now - firstMissingAt >= graceMs) {
      nextVanishedAt.delete(control.id);
      return;
    }
    heldIds.add(control.id);
    merged.splice(Math.min(prevIndex, merged.length), 0, control);
  });
  return { controls: merged, heldIds, vanishedAt: nextVanishedAt };
}

// PR3 (.claude/plans/this-is-how-pocket-partitioned-mountain.md), Hermes
// review round 2 — the CSS `.dock-monitor { min-width: 364px }` floor
// (empty-states.css) is derived at the DEFAULT 14px fontSize / 4px padding
// only; both are user-configurable (AppearanceSection, 10-20px / 0-16px),
// and at larger values 364px stops holding pty-manager.ts's
// MIN_TERMINAL_COLS (40) at any font size, leaving dock terminals back in
// TerminalPane's permanent-shrink regime the static number was meant to
// fix. This recomputes the SAME derivation from the user's actual live
// settings instead — Dock.tsx applies it as an inline `minWidth` style,
// which naturally overrides the CSS class's static value (higher
// specificity) for every user, not just one at defaults.
//
// `PX_PER_COL_AT_14PX = 8.4` is the one real, measured data point this
// whole floor is built on (see the CSS comment's own derivation for how it
// was obtained — a live xterm pane's own
// `term._core._renderService.dimensions.css.cell.width` at Geist Mono
// 14px, not a guessed advance-width ratio). Scaling it linearly by
// `fontSize / 14` is standard for a monospace font — glyph advance width
// scales with em size — and is a materially better approximation than the
// rejected blind ratio guess, since it's anchored to one precisely
// measured point rather than assumed from nothing.
const PX_PER_COL_AT_14PX = 8.4;
const BASELINE_FONT_SIZE_PX = 14;
// @xterm/addon-fit's own fixed reserve (its `proposeDimensions()`
// subtracts `terminal.options.overviewRuler?.width || 14` whenever
// `scrollback !== 0`, which this repo's terminals always have) — see the
// CSS comment for the full trace through addon-fit's source.
const ADDON_FIT_RESERVE_PX = 14;
const DOCK_MONITOR_BORDER_PX = 2;
const MIN_TERMINAL_COLS = 40;
// Cross-platform font-hinting/subpixel margin the single (Chrome) cell-
// width measurement can't rule out on other engines — matches the CSS
// comment's own margin at the 14px baseline.
const CROSS_PLATFORM_MARGIN_PX = 4;

export function dockMonitorMinWidthPx(fontSize: number, padding: number): number {
  const cellWidth = PX_PER_COL_AT_14PX * (fontSize / BASELINE_FONT_SIZE_PX);
  const xtermContentWidth = MIN_TERMINAL_COLS * cellWidth + ADDON_FIT_RESERVE_PX;
  return Math.ceil(
    xtermContentWidth + padding * 2 + DOCK_MONITOR_BORDER_PX + CROSS_PLATFORM_MARGIN_PX,
  );
}

// Dock log-streaming resize fix — every dock monitor was permanently below
// pty-manager.ts's MIN_TERMINAL_ROWS (10), on ANY dock height, because
// nothing derived a floor for the vertical axis the way dockMonitorMinWidthPx
// above does for the horizontal one. Confirmed live: a real dock monitor's
// own GeometryMessage echo read `{"cols":63,"rows":10,"minCols":40,
// "minRows":10}` — rows floored exactly at the minimum — which latches
// TerminalPane's `cappedBelowFloor` permanently true, which in turn skips
// `applyClampedFit()` on every subsequent resize (see that function's own
// comment for why), leaving the terminal's real rendered grid larger than
// its clipped container instead of ever being re-fit down to it.
//
// `PX_PER_ROW_AT_14PX` is, like PX_PER_COL_AT_14PX above, anchored to a real
// measured data point — a live xterm pane's own
// `term._core._renderService.dimensions.css.cell` at Geist Mono 14px read
// `{ width: 8, height: 18 }` together, on the same uncapped pane, in the
// same session. That `width: 8` doesn't match PX_PER_COL_AT_14PX's own 8.4
// (a different session's measurement, on whatever engine/DPI produced it —
// review caught this discrepancy uncaught in an earlier version of this
// comment, which wrongly claimed the two were consistent). Rather than
// picking one session's width over the other — and since
// PX_PER_COL_AT_14PX is load-bearing for dockMonitorMinWidthPx's own
// dockHelpers.test.ts-pinned 364px result, so it can't just be swapped for
// this session's `8` — this scales the height/width RATIO measured
// together in this one session (18 / 8 = 2.25) onto the already-pinned 8.4
// baseline: 8.4 * 2.25 = 18.9. That keeps the width and height derivations
// internally consistent with each other (same font, same ratio) without
// silently changing the width floor's own pinned number.
const PX_PER_ROW_AT_14PX = 18.9;
// pty-manager.ts's own MIN_TERMINAL_ROWS — hand-synced the same way
// MIN_TERMINAL_COLS above is; the frontend has no build-time import for it
// (see pty-manager.ts's own comment on why only MAX_TERMINAL_COLS/ROWS are
// genuinely shared).
const MIN_TERMINAL_ROWS = 10;
// .dock-monitor-header's own fixed CSS height (empty-states.css).
const DOCK_MONITOR_HEADER_HEIGHT_PX = 28;

/**
 * The pixel height a dock monitor's TERMINAL BODY must be at least, so a
 * dock terminal can hold pty-manager.ts's MIN_TERMINAL_ROWS at the user's
 * live font settings — the vertical counterpart to dockMonitorMinWidthPx
 * above. See that function's own doc comment for why a STATIC floor isn't
 * enough (font size/padding are user-configurable) and this one's own
 * comment above for the measurement and mechanism this fixes.
 *
 * Unlike the width derivation, this needs no addon-fit reserve:
 * FitAddon.proposeDimensions() only subtracts its fixed overview-ruler
 * reserve from the WIDTH measurement, never from the height one (see that
 * addon's own source, quoted in dockMonitorMinWidthPx's own doc comment's
 * referenced CSS derivation) — there is no vertical analogue to reserve
 * space for.
 *
 * This is the BODY-only floor — see dockMonitorFullMinHeightPx below for
 * why the header has to be added on top of it, and why that combined total,
 * not this one alone, is what actually goes on the DOM.
 */
export function dockMonitorMinHeightPx(fontSize: number, padding: number): number {
  const cellHeight = PX_PER_ROW_AT_14PX * (fontSize / BASELINE_FONT_SIZE_PX);
  const xtermContentHeight = MIN_TERMINAL_ROWS * cellHeight;
  return Math.ceil(xtermContentHeight + padding * 2 + CROSS_PLATFORM_MARGIN_PX);
}

/**
 * The full `.dock-monitor` element's own minimum height — header
 * (DOCK_MONITOR_HEADER_HEIGHT_PX) + terminal body floor
 * (dockMonitorMinHeightPx) + border (DOCK_MONITOR_BORDER_PX) — and the value
 * that actually has to be applied to `.dock-monitor` itself, NOT
 * `.dock-monitor-body`. Review caught a real bug in an earlier version of
 * this fix that applied the body-only floor to `.dock-monitor-body` alone:
 * `.dock-monitor` has `overflow: hidden` (empty-states.css), and per CSS
 * Flexbox §4.5 `overflow: hidden` zeroes a flex item's AUTOMATIC minimum
 * size — so `.dock-monitor`, stretched by `.dock-body`'s row layout, never
 * grew to accommodate its child's new min-height at all; the overflow was
 * clipped silently INSIDE `.dock-monitor`'s own boundary, one level deeper
 * than before, and `.dock-body` itself never saw the overflow, so its own
 * `overflow-y: auto` (dock.css) never engaged either. An EXPLICIT min-height
 * (not the automatic kind `overflow: hidden` zeroes) on `.dock-monitor`
 * itself is what actually forces it past its stretch-fit size when the dock
 * region is too short — the same mechanism `.dock-monitor`'s own
 * `min-width: 364px` already uses on the horizontal axis, just on the
 * cross axis here instead of the main one. Confirmed live: applying this
 * combined value as `.dock-monitor`'s own min-height, not the body's, is
 * what makes `.dock-body`'s `scrollHeight` actually exceed its
 * `clientHeight` — the precondition for its `overflow-y: auto` to do
 * anything at all.
 */
export function dockMonitorFullMinHeightPx(fontSize: number, padding: number): number {
  return (
    dockMonitorMinHeightPx(fontSize, padding) +
    DOCK_MONITOR_HEADER_HEIGHT_PX +
    DOCK_MONITOR_BORDER_PX
  );
}
