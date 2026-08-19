import type {
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  Position,
  SerializedDockview,
} from "dockview";
import type { Task, Workspace } from "./api/index.js";
import { positionToDirection } from "dockview";
import type { Session } from "./api/index.js";
import { initialPaneTitle } from "./paneTitle.js";

// Mirrors App.tsx's own MOBILE_BREAKPOINT_QUERY (kept private there) —
// openTimelinePanel below is called from PaneTab.tsx's overflow menu, which
// has no access to App.tsx's live `isMobile` React state (it isn't threaded
// through dockview's tab `params`, which must stay JSON-serializable for
// workspace layout persistence — a callback/boolean prop can't survive
// that). A live matchMedia() check at call time is just as correct as a
// stale-by-one-render boolean would be, without new plumbing.
const MOBILE_BREAKPOINT_QUERY = "(max-width: 699px)";

// U9 — App.tsx's global Escape handler's own action list, extracted here
// (App.tsx itself can only export components — react-refresh/only-export-
// components) so it's directly unit-testable: App.tsx pulls in real
// dockview/xterm/WS machinery App.test.tsx never had to mock before, so
// mounting the whole component just to exercise a keydown handler isn't
// this codebase's existing pattern (see App.test.tsx's absence). App.tsx's
// effect calls this directly, so this IS the real code path, not a
// parallel reimplementation of it. `clearSplitRequest` closing a
// split-triggered palette (not just a plain-opened one — see App.tsx's own
// `paletteOpen`'s `palette.open || (splitRequest !== null && ...)`
// computation) is the actual U9 fix; `clearPalette`/`closeSettings` were
// already correct.
export function handleGlobalEscape(actions: {
  clearPalette: () => void;
  closeSettings: () => void;
  clearSplitRequest: () => void;
}): void {
  actions.clearPalette();
  actions.closeSettings();
  actions.clearSplitRequest();
}

// A workspace's `layout` is an opaque dockview blob — this walks it
// generically looking for any `sessionId` value, without assuming dockview's
// exact panel-tree shape.
export function extractSessionIds(layout: Record<string, unknown> | null): Set<number> {
  const ids = new Set<number>();
  if (!layout) return ids;

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (key === "sessionId" && typeof val === "number") ids.add(val);
        // Phase 6 (6.5/#218) — SessionTimeline's params carry `sessionIds`
        // (plural, an array) since its own prop was widened to support a
        // task's multiple sessions (worker + optional review). Matched here
        // too so a workspace's timeline panel still counts toward
        // findSessionWorkspace/cross-workspace lookups.
        else if (key === "sessionIds" && Array.isArray(val)) {
          for (const v of val) if (typeof v === "number") ids.add(v);
        } else visit(val);
      }
    }
  };
  visit(layout);
  return ids;
}

export function findSessionWorkspace(sessionId: number, workspaces: Workspace[]): number | null {
  for (const ws of workspaces) {
    if (extractSessionIds(ws.layout).has(sessionId)) return ws.id;
  }
  return null;
}

// Issue #95 prerequisite — this app has no client-side router (no router
// dependency, no history.pushState/hash usage anywhere in frontend/src),
// and src/plugins/static.ts serves the built frontend with no SPA rewrite,
// so a path segment like /session/3 would 404 while /?session=3 is still
// "/". This is the minimum viable deep-link scheme: a push notification's
// notificationclick handler (or any external link) can point at "/" plus
// this query param to have App.tsx open a specific session on load. Pure
// parse, no DOM/location access, so it's unit-testable without mounting App.
export function parseDeepLinkSessionId(search: string): number | null {
  const raw = new URLSearchParams(search).get("session");
  if (raw === null) return null;
  // Number()'s grammar accepts hex/octal/binary/scientific-notation strings
  // (e.g. "0x2A", "1e2") — restrict to plain decimal digits so a deep link
  // can't silently resolve to a different-looking session id.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  // isSafeInteger, not isInteger: a 20+ digit string still passes the
  // decimal-only regex above but Number() silently rounds it to an
  // imprecise float once it exceeds 2^53 — isSafeInteger rejects that
  // rather than returning a session id that doesn't match what was typed.
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Resolves which project a dockview `activePanelId` string belongs to —
// there's no other "currently selected project" concept in the sidebar
// (issue #433's Source Control section). Mirrors BrowserPanel.tsx's own
// `activeSessionId` regex for the session-scoped panel ids (session/
// timeline/browserPane), plus the project-scoped ones (git/github/
// agent-rules/dock-config) that App.tsx opens with a bare `-<projectId>`
// suffix.
export function resolveActiveProjectId(
  activePanelId: string | null,
  sessions: Session[],
): number | null {
  if (!activePanelId) return null;
  const projectMatch = activePanelId.match(/^(?:git|github|agent-rules|dock-config)-(\d+)$/);
  if (projectMatch) return parseInt(projectMatch[1], 10);
  const sessionMatch = activePanelId.match(/^(?:session|timeline|browserPane)-(\d+)$/);
  if (sessionMatch) {
    const sessionId = parseInt(sessionMatch[1], 10);
    return sessions.find((s) => s.id === sessionId)?.projectId ?? null;
  }
  return null;
}

export interface DropTarget {
  group: DockviewGroupPanel | undefined;
  location: "tab" | "header_space" | "content" | "edge";
  position: Position;
}

// Floating panels report `location.type === "floating"`; everything actually
// placed in the grid (including edge/split groups) reports "grid". Shared by
// hasTiledPanels/maximizeIfTiled below and App.tsx's tiledPaneCount/
// mobilePanels (Hermes review, PR #727 — those two used to each inline this
// same `p.api.location.type === "grid"` check).
export function isTiledPanel(panel: Pick<IDockviewPanel, "api">): boolean {
  return panel.api.location.type === "grid";
}

// A panel opened from the sidebar/launcher should only ever *peek* (float)
// when there's already a tiled layout to peek across — the first panel in an
// empty workspace should dock full-screen instead (issue #121). Checking
// live `panel.api.location` rather than a cached count keeps this correct as
// panels are closed/docked/floated during the session.
export function hasTiledPanels(api: DockviewApi): boolean {
  return api.panels.some(isTiledPanel);
}

// Bug fix (independent review) — this used to walk `group.panels` on the
// theory that DockviewGroupPanel had no direct location accessor of its
// own. Verified against the installed dockview-core:
// `DockviewGroupPanelApiImpl.get location()` reads `this._group.model.
// location` directly off the group, and `DockviewPanelApiImpl.get
// location()` (a panel's own) just proxies `this.group.api.location` right
// back — the group-level value was always the source of truth. That matters
// for `onDidAddGroup`: `DockviewComponent._doAddPanel` fires
// `_onDidAddGroup` immediately after `createGroup`/`createGroupAtLocation`,
// *before* `group.model.openPanel(...)` ever attaches a panel — so
// `group.panels` was reliably `[]` at the exact moment
// useMobileLayout.ts's onDidAddGroup handler read it, making the old
// `isTiledGroup` return `false` unconditionally for every brand-new group,
// tiled or floating. Reading `group.api.location.type` directly is correct
// at that same moment, since the group's location is set at creation time.
export function isTiledGroup(group: Pick<DockviewGroupPanel, "api">): boolean {
  return group.api.location.type === "grid";
}

// Bug fix (independent review) — every open-or-focus-by-stable-id helper
// below (and usePanelOpener.ts's onOpenBrowserUrl/onOpenBlankBrowser) calls
// `api.maximizeGroup(panel)` on mobile, same as applyMobilePresentation
// used to before its own fix — and the same throw applies here: an
// "existing" panel being refocused may have floated on desktop before a
// breakpoint change into mobile (applyMobilePresentation deliberately never
// re-tiles a floating panel), and even a freshly-added panel with no
// explicit position lands in `api.activeGroup` (verified in dockview-core's
// `_doAddPanel`), which is itself a floating group whenever the *previously*
// active panel was one (e.g. a workspace with no tiled panels at all).
// Mirrors applyMobilePresentation's own floating-skip rather than crashing.
export function maximizeIfTiled(
  api: DockviewApi,
  panel: ReturnType<DockviewApi["getPanel"]> | undefined,
): void {
  if (panel && isTiledPanel(panel)) api.maximizeGroup(panel);
}

// dockview's own DEFAULT_FLOATING_GROUP_POSITION is a bare 300x300
// (constants.js) — comfortably enough for chrome-only panels, but a
// terminal panel's xterm instance fits inside that at well under
// pty-manager.ts's MIN_TERMINAL_COLS/ROWS floor (40x10) even at the
// terminal settings' default fontSize (14px, AppearanceSection.tsx), and
// gets worse at any larger size the fontSize slider allows (10-20px). Below
// that floor the pty keeps running at the floored size regardless — see
// GeometryMessage's own doc comment (ws-protocol.ts) — so the visible
// xterm grid silently drifts from what the pty is actually drawing, and
// input from a viewport smaller than that grid reads as "the terminal
// stopped responding" (issue: small panes/floating windows ignoring
// input). 720x460 clears 40x10 with margin at every allowed fontSize.
// Applied to every panel kind opened via desktopPositioning below, not
// just terminal ones — a GitHub/timeline/task-detail panel squeezed into
// 300x300 is unusable too, even though only a terminal pane is actually
// broken by it.
const DEFAULT_FLOATING_PANEL_SIZE = { width: 720, height: 460 };

// The float-if-tiled-else-dock desktop positioning shared by every
// open-or-focus-by-stable-id helper below (openSessionPanel,
// openTimelinePanel, openBrowserPanePanel, openTaskDetailPanel, and
// openOrFocusProjectPanel via its own applyDesktopPositioning gate): float
// only when there's a tiled panel to peek across, giving the floating group
// an explicit size (see DEFAULT_FLOATING_PANEL_SIZE above) rather than
// dockview's cramped default; otherwise dock into the grid via `position:
// { direction: "right" }` (see openSessionPanel's own comment on why this
// is needed even without an existing floating group — a bare `addPanel`
// would land back inside one).
function desktopPositioning(
  api: DockviewApi,
): { floating: { width: number; height: number } } | { position: { direction: "right" } } {
  return hasTiledPanels(api)
    ? { floating: DEFAULT_FLOATING_PANEL_SIZE }
    : { position: { direction: "right" } };
}

// A dockview panel's `params` is untyped (Parameters = Record<string,
// unknown> | undefined) from the group/board's point of view — only a
// `terminal` component panel's params are actually `{ sessionId: number }`;
// a sibling panel could in principle be a GitHubPanel/GitPanel/BrowserPanel
// with no sessionId at all, so every caller must guard rather than assume.
// Shared by PaneTab.tsx (the tab-group attention accent) and App.tsx's
// mobile pane bar (item A.5 of the mobile UI/UX overhaul) so the two don't
// carry two copies of the same narrowing.
export function panelSessionId(panel: IDockviewPanel): number | undefined {
  const id = panel.params?.sessionId;
  return typeof id === "number" ? id : undefined;
}

// #98 item 4's auto-focus-on-attention effect (App.tsx) — which panel ids
// should be brought into view for a live-refresh poll tick, given the set
// of session ids that already had `attention` the *previous* tick (so this
// only fires on the transition, not every tick attention stays true — same
// shape as the existing seenAttentionRef/seenExitedRef notification
// effects). Pulled out as its own pure function (rather than inlined in the
// effect, like those two are) so the transition logic itself — independent
// of the separate Settings gate and the dockviewApi.getPanel/setActive
// calls, both of which need a live DockviewApi to test — has a unit test
// that doesn't need to mount App.tsx's dockview tree. Panel ids are
// deterministic (`session-${id}`, matching openSessionPanel above).
export function attentionTransitionPanelIds(
  sessions: Pick<Session, "id" | "attention">[],
  previouslyAttention: ReadonlySet<number>,
): string[] {
  return sessions
    .filter((s) => s.attention && !previouslyAttention.has(s.id))
    .map((s) => `session-${s.id}`);
}

// Phase 5 (Track B, issue #194 5.4) — same shape as attentionTransitionPanelIds
// above: a pure "what's new since last tick" detector, so the transition
// logic (which live children have just appeared) is unit-testable without a
// live DockviewApi. Only LIVE children (parentSessionId set, status
// "active") are candidates — a child that appeared and was already killed
// between poll ticks has nothing worth opening a panel for.
export function newChildSessionIds(
  sessions: Pick<Session, "id" | "parentSessionId" | "status">[],
  previouslySeen: ReadonlySet<number>,
): number[] {
  return sessions
    .filter((s) => s.parentSessionId !== null && s.status === "active" && !previouslySeen.has(s.id))
    .map((s) => s.id);
}

// Given a live DockviewApi and a child session's parentSessionId, returns
// the dockview `position` for opening the child's NEW panel next to its
// parent's — the same reference-panel placement App.tsx's split-launch
// effect already uses (`position: { referencePanel, direction }`), not a
// new `addGroup`-based layout engine. Returns undefined when the parent's
// own panel isn't part of the CURRENT dockview instance (a different or
// inactive workspace, or a parent the user never opened) — the caller must
// skip auto-opening entirely in that case rather than falling back to a
// position-less addPanel(), which would silently land the child's terminal
// in whatever group is currently active (independent review finding, PR #430).
export function childPanelPosition(
  api: DockviewApi,
  parentSessionId: number,
): { referencePanel: IDockviewPanel; direction: "right" } | undefined {
  const referencePanel = api.getPanel(`session-${parentSessionId}`);
  return referencePanel ? { referencePanel, direction: "right" } : undefined;
}

// Pure gate for the auto-open-child-panel effect (App.tsx) — pulled out so
// each of its five independent conditions has its own unit test without a
// live DockviewApi (there is no App.test.tsx in this codebase). `restoring`
// is the fix for a same-tick workspace-switch race: `workspaceRestored`
// (computed by the caller) can read true for one render before that same
// workspace-restore effect's own `restoringRef.current` flips to false
// (deferred via setTimeout) — a child arriving in that exact tick would
// otherwise get its panel opened right before the restore's own autosave
// effect discards the change as the restore's "echo", so it never persists.
// Blocking here is safe to no-op: the caller only marks a child "seen" from
// inside its own gated branch, so a child skipped by `restoring` is still
// correctly detected as new the next tick once restoring flips false.
export function shouldAutoOpenChildPanels(input: {
  workspaceRestored: boolean;
  hasDockviewApi: boolean;
  autoOpenChildPanels: boolean;
  sessionsLoaded: boolean;
  restoring: boolean;
}): boolean {
  return (
    input.workspaceRestored &&
    input.hasDockviewApi &&
    input.autoOpenChildPanels &&
    input.sessionsLoaded &&
    !input.restoring
  );
}

export function openSessionPanel(
  api: DockviewApi,
  session: Session,
  isMobile: boolean,
  projects: { id: number; name: string | null }[],
): void {
  const panelId = `session-${session.id}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    if (isMobile) maximizeIfTiled(api, existing);
    return;
  }

  const projectName = projects.find((p) => p.id === session.projectId)?.name ?? undefined;
  // Desktop: see desktopPositioning's own comment for the float-vs-dock
  // choice and floating size. Mobile keeps its existing bare add +
  // maximizeGroup — it never has floating groups and relies on the
  // single-group + mobile-tabs model, which an explicit position would break.
  const panel = api.addPanel({
    id: panelId,
    component: "terminal",
    tabComponent: "terminal",
    title: initialPaneTitle(session, projectName),
    params: { sessionId: session.id },
    ...(!isMobile && desktopPositioning(api)),
  });
  if (isMobile) maximizeIfTiled(api, panel);
}

// Self-contained variant of openSessionPanel for callers without `isMobile`
// threaded through React state (e.g. PaneActionsMenu.tsx's promote flow,
// which — like openTimelinePanel/openBrowserPanePanel below — has no access
// to App.tsx's live `isMobile` state) — same live matchMedia() rationale as
// those two.
export function openOrFocusSessionPanel(
  api: DockviewApi,
  session: Session,
  projects: { id: number; name: string | null }[],
): void {
  openSessionPanel(api, session, window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches, projects);
}

// Issue #212 — opens (or focuses) a session's structured-event timeline
// panel (SessionTimeline.tsx). Same open-or-focus-by-stable-id and
// float-if-tiled-else-dock shape as openSessionPanel above, just a distinct
// `timeline-<id>` panel id/component so it can coexist with that session's
// own terminal panel (and be opened/closed independently of it).
export function openTimelinePanel(api: DockviewApi, session: Session): void {
  const panelId = `timeline-${session.id}`;
  const existing = api.getPanel(panelId);
  const isMobile = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  if (existing) {
    existing.api.setActive();
    if (isMobile) maximizeIfTiled(api, existing);
    return;
  }

  const panel = api.addPanel({
    id: panelId,
    component: "timeline",
    title: `Timeline: ${session.name || session.command}`,
    params: { sessionIds: [session.id] },
    ...(!isMobile && desktopPositioning(api)),
  });
  if (isMobile) maximizeIfTiled(api, panel);
}

// Phase 3 (#181) — opens (or focuses) a session's CDP-controlled browser
// pane (BrowserPane.tsx, distinct from the iframe-based BrowserPanel/
// `browser` component above). Same open-or-focus-by-stable-id and
// float-if-tiled-else-dock shape as openTimelinePanel above; a `browserPane-
// <sessionId>` panel id lets it coexist with that session's own terminal
// and timeline panels. The pane connects over /ws/browser/:sessionId
// (routes/browser.ts, #180), which resolves the session's *project*
// browser — there's no separate project lookup needed here.
export function openBrowserPanePanel(api: DockviewApi, session: Session): void {
  const panelId = `browserPane-${session.id}`;
  const existing = api.getPanel(panelId);
  const isMobile = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  if (existing) {
    existing.api.setActive();
    if (isMobile) maximizeIfTiled(api, existing);
    return;
  }

  const panel = api.addPanel({
    id: panelId,
    component: "browserPane",
    title: `Agent Browser: ${session.name || session.command}`,
    params: { sessionId: session.id },
    ...(!isMobile && desktopPositioning(api)),
  });
  if (isMobile) maximizeIfTiled(api, panel);
}

// Phase 6 (6.5/#218) — opens (or focuses) a task's detail panel
// (TaskDetail.tsx) as a dockview panel. Since the Kanban/TaskPanel merge,
// task detail normally opens as an inline drawer inside UnifiedBoard.tsx
// instead (TaskDetail.tsx renders standalone there, with no panel involved)
// — this function's only current callers are its own tests, and the
// "task-detail" dockview component it targets stays registered so an
// already-saved workspace layout referencing a `task-detail-<id>` panel id
// still restores correctly (same "opaque blob" concern as
// TasksPanelRedirect.tsx's own header comment). Kept exported as a ready
// building block for a future "pop this drawer out to a panel" action.
export function openTaskDetailPanel(api: DockviewApi, task: Task): void {
  const panelId = `task-detail-${task.id}`;
  const existing = api.getPanel(panelId);
  const isMobile = window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  if (existing) {
    existing.api.setActive();
    if (isMobile) maximizeIfTiled(api, existing);
    return;
  }

  const panel = api.addPanel({
    id: panelId,
    component: "task-detail",
    title: `Task: ${task.title}`,
    params: { taskId: task.id },
    ...(!isMobile && desktopPositioning(api)),
  });
  if (isMobile) maximizeIfTiled(api, panel);
}

// PR 34h of the hook-extraction series — App.tsx used to declare six
// near-identical `onOpen*` callbacks inline (GitHub, Git, Agent Rules, Dock
// Config, Skills, Browser), each opening (or focusing) a single project-
// scoped tooling panel: same open-or-focus-by-`<kind>-<projectId>` shape as
// openSessionPanel/openTimelinePanel/openBrowserPanePanel/openTaskDetailPanel
// above, just keyed by project id instead of session/task id, and with a
// project-derived title instead of a session/task-derived one. Generalized
// here (usePanelOpener.ts, hooks/usePanelOpener.ts, wraps each call in its
// own useCallback) rather than six separate copies.
export interface ProjectPanelKindConfig {
  // Both the dockview panel-id prefix (`<kind>-<projectId>`) and the
  // registered `component` name in panels/registry.tsx — identical for
  // every one of these six panel kinds today, so one field covers both.
  kind: string;
  // Prefixed to the matching project's name for the panel's title (e.g.
  // "GitHub" -> "GitHub: my-project"), and used verbatim as the title when
  // no matching project is found (deleted project, or a stale/racing
  // lookup) — every one of the six original callbacks used the identical
  // label for both cases (e.g. onOpenGitHub: `GitHub: ${project.name}` /
  // "GitHub"), so a single field covers both rather than two.
  titleLabel: string;
  // Whether to apply the float-if-tiled-else-dock desktop positioning
  // (desktopPositioning above) when creating a NEW panel. True for every kind except
  // `browser`: App.tsx's pre-existing onOpenBrowser never carried this
  // spread — a genuine asymmetry from the other five, not an oversight in
  // this generalization — so usePanelOpener.ts's onOpenBrowser passes
  // `false` here specifically to preserve that exact (surprising but
  // load-bearing "zero behavior change") quirk. See that hook's own
  // onOpenBrowser doc comment.
  applyDesktopPositioning: boolean;
}

export function openOrFocusProjectPanel(
  api: DockviewApi,
  projectId: number,
  projects: { id: number; name: string | null }[],
  isMobile: boolean,
  config: ProjectPanelKindConfig,
): void {
  const project = projects.find((p) => p.id === projectId);
  const panelId = `${config.kind}-${projectId}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    if (isMobile) maximizeIfTiled(api, existing);
    return;
  }

  const panel = api.addPanel({
    id: panelId,
    component: config.kind,
    title: project ? `${config.titleLabel}: ${project.name}` : config.titleLabel,
    params: { projectId },
    ...(config.applyDesktopPositioning && !isMobile ? desktopPositioning(api) : {}),
  });
  if (isMobile) maximizeIfTiled(api, panel);
}

function buildPanelBase(session: Session, projects: { id: number; name: string | null }[]) {
  const projectName = projects.find((p) => p.id === session.projectId)?.name ?? undefined;
  return {
    id: `session-${session.id}`,
    component: "terminal" as const,
    tabComponent: "terminal" as const,
    title: initialPaneTitle(session, projectName),
    params: { sessionId: session.id },
  };
}

export function dropSessionPanel(
  api: DockviewApi,
  session: Session,
  projects: { id: number; name: string | null }[],
  target: DropTarget | null,
): void {
  const panelId = `session-${session.id}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    return;
  }

  const panelBase = buildPanelBase(session, projects);

  // Drag-and-drop always docks (issue #121) — the previous no-target branch
  // floated, which meant a drag onto empty space (or onto a floating group,
  // which reports no usable grid target) could never build a tiled layout.
  // Only treat the target group as a real drop target when it's actually in
  // the grid; a floating group's own quadrant target isn't one.
  if (target && target.group && isTiledGroup(target.group)) {
    if (target.location === "edge") {
      api.addPanel({
        ...panelBase,
        position: {
          referenceGroup: target.group,
          direction: positionToDirection(target.position),
        },
      });
    } else {
      api.addPanel({
        ...panelBase,
        position: { referenceGroup: target.group, direction: "within" },
      });
    }
  } else {
    api.addPanel({ ...panelBase, position: { direction: "right" } });
  }
}

function collectFloatingPanelIds(
  floatingGroups: NonNullable<SerializedDockview["floatingGroups"]>,
): Set<string> {
  const ids = new Set<string>();
  for (const fg of floatingGroups) {
    if (fg.data) {
      if (fg.data.activeView) ids.add(fg.data.activeView);
      for (const v of fg.data.views) ids.add(v);
    }
    if (fg.grid) {
      const walk = (node: { type: string; data: unknown }): string[] => {
        if (node.type === "leaf") {
          const d = node.data as { views?: string[]; activeView?: string };
          return [...(d?.views ?? []), ...(d?.activeView ? [d.activeView] : [])];
        }
        if (node.type === "branch" && Array.isArray(node.data)) {
          return node.data.flatMap((child) => walk(child as { type: string; data: unknown }));
        }
        return [];
      };
      for (const id of walk(fg.grid.root as { type: string; data: unknown })) ids.add(id);
    }
  }
  return ids;
}

// Panel ids whose dockview component is now only a deserialization stub (see
// TasksPanelRedirect.tsx's own header comment on why that stub can't just be
// deleted once blobs look clean) — kept registered purely so a saved
// workspace layout referencing them doesn't throw on restore, with nothing
// left to actually show. closeLegacyPanels below is the self-heal half: it
// closes any of these found in a *live*, already-restored dockview instance,
// so an activated workspace's blob gets rewritten (via the caller's own
// post-restore scheduleSave) instead of carrying the id forever.
export const LEGACY_PANEL_IDS = ["tasks"] as const;

// Returns true if it closed anything, so the caller (App.tsx's restore
// effect) knows to persist the cleaned layout — same shape as its existing
// closedKilledPanels flag, kept separate from it since the two sweeps close
// panels for unrelated reasons.
export function closeLegacyPanels(api: DockviewApi): boolean {
  let closed = false;
  for (const id of LEGACY_PANEL_IDS) {
    const panel = api.getPanel(id);
    if (panel) {
      panel.api.close();
      closed = true;
    }
  }
  return closed;
}

export function stripFloatingPanels(serialized: SerializedDockview): SerializedDockview {
  if (!serialized.floatingGroups || serialized.floatingGroups.length === 0) return serialized;

  const floatingIds = collectFloatingPanelIds(serialized.floatingGroups);
  const panels: Record<string, (typeof serialized.panels)[string]> = {};
  for (const [id, panel] of Object.entries(serialized.panels)) {
    if (!floatingIds.has(id)) panels[id] = panel;
  }

  const { floatingGroups: _fg, activeGroup, ...rest } = serialized;
  return {
    ...rest,
    panels,
    ...(typeof activeGroup === "string" && !floatingIds.has(activeGroup) ? { activeGroup } : {}),
  } as unknown as SerializedDockview;
}

// Issue #85 — dockview-core persists which group is maximized as
// `grid.maximizedNode` inside the serialized layout (Gridview.serialize(),
// dockview-core's own runtime), even though SerializedDockview["grid"]'s
// *declared* type omits it (root/height/width/orientation only) — a
// type/runtime mismatch, hence the local widened type below rather than a
// direct property access. Left unstripped, this means whichever side
// (desktop or mobile) happened to save last determines whether the OTHER
// side restores maximized — mobile's own maximizeGroup calls poison a
// desktop's saved layout, and vice versa. The fix is to treat maximization
// as pure viewport presentation that must never round-trip through
// persistence: strip it here, and let applyMobilePresentation below
// re-derive it live from the current breakpoint on every restore/resize.
type SerializedGridWithMaximized = SerializedDockview["grid"] & {
  maximizedNode?: unknown;
};

export function stripMaximizedNode(serialized: SerializedDockview): SerializedDockview {
  const grid = serialized.grid as SerializedGridWithMaximized;
  if (!grid || !("maximizedNode" in grid)) return serialized;
  const { maximizedNode: _maximizedNode, ...rest } = grid;
  return { ...serialized, grid: rest };
}

// Mobile UI/UX overhaul (see .claude/plans/we-need-to-work-iterative-planet.md,
// item A.2/A.3) — mirrors stripMaximizedNode's own reasoning one field over.
// applyMobilePresentation below sets `group.header.hidden` so dockview's own
// tab strip doesn't render a second, duplicate pane switcher underneath
// App.tsx's `.mobile-tabs` bar. dockview-core serializes that as `hideHeader`
// on each leaf group node inside `grid.root` (DockviewGroupPanelModel.toJSON,
// confirmed in the installed package) — left unstripped, mobile's hide would
// poison a desktop restore exactly the way unstripped maximization did before
// stripMaximizedNode existed. The `dockview` package this file imports from
// doesn't re-export the GroupPanelViewState/SerializedGridObject names its
// own SerializedDockview type is built from, so this walks the tree with a
// minimal structural type rather than importing them by name.
interface GridTreeNode {
  type: "leaf" | "branch";
  data: unknown;
  size?: number;
  visible?: boolean;
}

function stripHiddenHeadersNode(node: GridTreeNode): GridTreeNode {
  if (node.type === "branch" && Array.isArray(node.data)) {
    return { ...node, data: (node.data as GridTreeNode[]).map(stripHiddenHeadersNode) };
  }
  if (node.data && typeof node.data === "object" && "hideHeader" in node.data) {
    const { hideHeader: _hideHeader, ...rest } = node.data as Record<string, unknown>;
    return { ...node, data: rest };
  }
  return node;
}

export function stripHiddenHeaders(serialized: SerializedDockview): SerializedDockview {
  const root = serialized.grid?.root as GridTreeNode | undefined;
  if (!root) return serialized;
  return {
    ...serialized,
    grid: {
      ...serialized.grid,
      root: stripHiddenHeadersNode(root) as SerializedDockview["grid"]["root"],
    },
  };
}

// Single choke point for both save paths (App.tsx's flushPendingSave and
// scheduleSave) so they can't drift — flushPendingSave previously wrote raw
// api.toJSON() with neither strip applied, leaking floating panels AND
// maximization through every workspace switch.
export function serializeForPersist(api: DockviewApi): SerializedDockview {
  return stripHiddenHeaders(
    stripMaximizedNode(stripFloatingPanels(api.toJSON() as SerializedDockview)),
  );
}

// Issue #85 — the single entry point for mobile's "single active pane"
// presentation. Called from both the workspace-restore effect and the
// breakpoint-change effect in App.tsx, so it has to be idempotent and safe
// to call redundantly: hasMaximizedGroup() makes both the maximize and the
// exit branches no-ops when already in the target state. `activePanel` (not
// "the first panel" or "the last panel") is used as the maximize target
// because after fromJSON() it's the panel the restored layout itself
// designates as focused — the same one the mobile tab bar renders as active
// (see App.tsx's panel.id === activePanelId check) — so picking a different
// panel would show one pane while highlighting a different tab.
//
// Mobile UI/UX overhaul, item A.2 — also syncs every group's `header.hidden`
// to the current breakpoint, so dockview's own tab strip doesn't render
// underneath App.tsx's `.mobile-tabs` bar (the reported "doubled" pane
// switcher). Every group, not just the one about to be (de)maximized: a
// workspace restored from a desktop-authored layout can have several groups,
// and only one of them becomes the maximized/visible one here — the rest
// must still not show a header once they're switched to later (e.g. a
// direct `dockviewApi.maximizeGroup()` call elsewhere, which fires
// `onDidMaximizedGroupChange` — see App.tsx's own listener for that path).
// Setting `.hidden` directly toggles `display:none` on dockview's internal
// tabsContainer element (confirmed in the installed package) inside the
// group's own flex layout, which the browser reflows on its own — no
// separate dockview relayout call needed, and TerminalPane's existing
// ResizeObserver → refit picks up the resulting size change.
// Bug fix (independent code review): `api.activePanel`/`api.panels[0]` can
// be a FLOATING panel (desktopPositioning floats every panel opened once a
// tiled one already exists — panelUtils.ts's own desktopPositioning) —
// `api.maximizeGroup()` on one throws, verified against the installed
// dockview-core: `Gridview.maximizeView` calls `getGridLocation(view.
// element)`, which walks DOM ancestry looking for a `dv-grid-view` class and
// throws "Invalid grid element" once it runs off the top, which is exactly
// what a floating group's element does (it isn't in the grid tree). That
// throw used to escape mid-function, AFTER the header.hidden loop below had
// already run — leaving every header hidden with nothing maximized. Now:
// only tiled groups ever get their header hidden or get passed to
// maximizeGroup; a workspace with only floating panels maximizes nothing
// (there is nothing tiled to show single-pane) rather than crashing.
//
// The header.hidden sync itself is deliberately asymmetric: only TILED
// groups are ever hidden entering mobile, but EVERY group (tiled or
// floating) is restored to visible leaving it. A floating group's header is
// its only drag handle and close button — hiding it was never done to begin
// with (the loop below only touches tiled groups going in) — but the
// restore direction has to cover both anyway, otherwise a group that was
// tiled while its header got hidden and then dragged into a floating
// position before the next breakpoint change would leave mobile with a
// hidden header and no way to undo it.
export function applyMobilePresentation(api: DockviewApi, isMobile: boolean): void {
  for (const group of api.groups) {
    if (!isMobile || isTiledGroup(group)) group.header.hidden = isMobile;
  }
  if (!isMobile) {
    if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
    return;
  }
  if (api.hasMaximizedGroup()) return;
  const panel =
    api.activePanel && isTiledPanel(api.activePanel)
      ? api.activePanel
      : api.panels.find(isTiledPanel);
  if (!panel) return;
  api.maximizeGroup(panel);
}
