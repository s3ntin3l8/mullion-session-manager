import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType, FunctionComponent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { TerminalPane } from "../TerminalPane.js";
import type { TerminalPaneParams } from "../TerminalPane.js";
import { GitHubPanel } from "../GitHubPanel.js";
import type { GitHubPanelParams } from "../GitHubPanel.js";
import { GitPanel } from "../GitPanel.js";
import type { GitPanelParams } from "../GitPanel.js";
import { AgentRulesPanel } from "../AgentRulesPanel.js";
import type { AgentRulesPanelParams } from "../AgentRulesPanel.js";
import { ProjectBriefingPanel } from "../ProjectBriefingPanel.js";
import type { ProjectBriefingPanelParams } from "../ProjectBriefingPanel.js";
import { ProjectSetupPanel } from "../ProjectSetupPanel.js";
import type { ProjectSetupPanelParams } from "../ProjectSetupPanel.js";
import { DockConfigPanel } from "../DockConfigPanel.js";
import type { DockConfigPanelParams } from "../DockConfigPanel.js";
import { SkillsPanel } from "../SkillsPanel.js";
import type { SkillsPanelParams } from "../SkillsPanel.js";
import type { BrowserPanelParams } from "../BrowserPanel.js";
import type { BrowserPaneParams } from "../BrowserPane.js";
import { SessionTimeline } from "../SessionTimeline.js";
import type { SessionTimelineParams } from "../SessionTimeline.js";
import { TasksPanelRedirect } from "../TasksPanelRedirect.js";
import { TaskDetail } from "../TaskDetail.js";
import type { TaskDetailParams } from "../TaskDetail.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { PaneTab } from "../PaneTab.js";
import { Spinner } from "../ui/Spinner.js";
import { useDashboardStore } from "../store/index.js";
import type { Session } from "../api/index.js";
import { formatPaneTitle } from "../paneTitle.js";
import { openSessionPanel } from "../panelUtils.js";
import { useLayoutContext } from "../lib/layoutTier.js";

// B2 — code-split the substantial, not-always-needed-on-first-paint dockview
// panels (the two browser/preview panes and the Kanban board) out of the
// initial bundle via React.lazy. dockview and xterm+webgl stay eager — a
// terminal pane is what the app shows first, so splitting those would only
// move the cost, not remove it. Each import() resolves `{ default }` because
// these modules use named exports, not a default export. (Settings.tsx is
// also lazy-loaded but stays in App.tsx — it's a modal, not a dockview
// panel, so it doesn't belong in this panel-registration module.)
const LazyUnifiedBoard = lazy(() =>
  import("../UnifiedBoard.js").then((m) => ({ default: m.UnifiedBoard })),
);
const LazyBrowserPanel = lazy(() =>
  import("../BrowserPanel.js").then((m) => ({ default: m.BrowserPanel })),
);
const LazyBrowserPane = lazy(() =>
  import("../BrowserPane.js").then((m) => ({ default: m.BrowserPane })),
);

// Shared Suspense fallback for the lazy dockview panels above (the Browser
// panel/pane and the Kanban board overlay, all absolutely-positioned within
// their container) — reuses the existing terminal-connecting spinner
// vocabulary (`ui/Spinner.tsx`'s SpinnerIcon + .terminal-status-spinner's
// cmuxSpin keyframe, styles.css) instead of inventing a second loading
// affordance.
function LazyPanelFallback() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Spinner variant="connecting" />
    </div>
  );
}

// Every dockview panel wrapper below (plus the Kanban board overlay, which
// isn't a dockview panel but follows the identical crash-isolation pattern)
// owns one of these, bumped by its ErrorBoundary's "Reload pane" — a class
// component's own error state has no way to retry the exact subtree that
// threw, so the fix is remounting a fresh child under a new `key` instead.
// Centralized here so the 12 wrappers that need it don't each hand-roll
// `useState(0)` + an inline bump callback.
function useResetKey(): [number, () => void] {
  const [resetKey, setResetKey] = useState(0);
  return [resetKey, () => setResetKey((k) => k + 1)];
}

interface MakePanelWrapperOptions<
  // Mirrors dockview-core's own `IDockviewPanelProps<T extends { [index:
  // string]: any }>` constraint verbatim — the `any` isn't ours, it's
  // upstream's, and a narrower bound here would just fail to satisfy theirs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends { [index: string]: any },
  ExtraProps extends object,
> {
  // Wraps the rendered panel in Suspense with the shared LazyPanelFallback —
  // for panels built on a lazy()-loaded component.
  suspense?: boolean;
  // Derives any props the wrapped component needs beyond `params` (e.g.
  // dockview's `api`) straight from the incoming dockview panel props. Kept
  // as a plain function (no hooks) so it can be evaluated inline in the
  // generated wrapper without touching hook-call ordering.
  extraProps?: (props: IDockviewPanelProps<Params>) => ExtraProps;
}

// The one dedup this PR is actually for: wraps a panel component that only
// needs `params` (plus, optionally, a couple of props derivable without
// hooks) in the same ErrorBoundary+resetKey+optional-Suspense shell that
// used to be hand-rolled per panel. Panels whose wrapper needs its own
// hooks (a store selector, a memoized callback, an effect) stay written out
// below instead — forcing those into a shared callback shape would mean
// calling hooks from inside a plain (non-component, non-"use*") function,
// which trips `react-hooks/rules-of-hooks`.
// Exported (only) so registry.test.tsx can exercise its remount-key
// semantics directly against a throwaway dummy component, rather than
// indirectly through one of the real panels above — same
// react-refresh/only-export-components trade-off as the `components`/
// `tabComponents` maps below, for the same reason.
// eslint-disable-next-line react-refresh/only-export-components
export function makePanelWrapper<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Params extends { [index: string]: any },
  ExtraProps extends object = Record<string, never>,
>(
  Component: ComponentType<{ params: Params } & ExtraProps>,
  options: MakePanelWrapperOptions<Params, ExtraProps> = {},
): FunctionComponent<IDockviewPanelProps<Params>> {
  return function PanelWrapper(props: IDockviewPanelProps<Params>) {
    const [resetKey, resetPanel] = useResetKey();
    const extra = options.extraProps ? options.extraProps(props) : ({} as ExtraProps);
    const content = <Component key={resetKey} params={props.params} {...extra} />;
    return (
      <ErrorBoundary onReset={resetPanel}>
        {options.suspense ? (
          // LazyPanelFallback is `position: absolute; inset: 0` (see its own
          // comment) — that only resolves correctly against a positioned
          // ancestor. Neither dockview's own panel host (.dv-react-part) nor
          // ErrorBoundary (which renders children directly, no wrapping div)
          // establishes one, so without this host the fallback fell back to
          // dockview's .dv-view instead: ~35px too tall, covering that
          // group's tab strip (and swallowing clicks on it) for as long as
          // the lazy chunk takes to load.
          <div style={{ position: "relative", width: "100%", height: "100%" }}>
            <Suspense fallback={<LazyPanelFallback />}>{content}</Suspense>
          </div>
        ) : (
          content
        )}
      </ErrorBoundary>
    );
  };
}

// Workspace-autosave rate-limit-storm fix — an agent CLI's terminal title
// carries a live elapsed-second counter while it's working (Claude Code's
// `✳ Thinking… (23s · ...)`, Codex/opencode equivalents), so raw OSC title
// events arrive roughly once a second. dockview-core wires a panel's TITLE
// change into the same emitter that backs onDidLayoutChange, so an
// unthrottled setTitle call here was the actual source of the per-second
// `PATCH /api/workspaces/:id` storm (see panelUtils.ts's
// stripSessionPanelTitles for the persistence-side half of this fix, and
// that function's own comment for the full trace). A title repainting
// faster than the eye can read isn't worth a tab repaint either, so this is
// a UX throttle as much as a network one — issue #69's live-title behavior
// stays intact, it just doesn't repaint on every single OSC frame.
const OSC_TITLE_THROTTLE_MS = 1000;

// Wrapped per-panel (not once around the whole dockview area) so a crash in
// one session's terminal can't take out sibling panes too.
function TerminalPanelWrapper(props: IDockviewPanelProps<TerminalPaneParams>) {
  const [resetKey, resetPanel] = useResetKey();
  const sessionId = props.params.sessionId;
  const highlightedPanelId = useDashboardStore((s) => s.highlightedPanelId);
  const panelId = `session-${sessionId}`;
  // Real-time tab title tracking (issue #69): TerminalPane stays dockview-
  // agnostic (see its own header comment) and just reports the raw OSC
  // title string up; this wrapper is where props.api.setTitle actually lives.
  // Reads sessions/projects fresh via getState() at call time (rather than
  // useDashboardStore selectors + a dep-array effect) so the always-current
  // nameLocked flag gates every OSC event without re-subscribing TerminalPane
  // on every store change.
  const applyTitle = useCallback(
    (oscTitle: string) => {
      const { sessions, projects } = useDashboardStore.getState();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session || session.nameLocked) return; // pinned by an explicit rename
      const projectName = projects.find((p) => p.id === session.projectId)?.name;
      props.api.setTitle(formatPaneTitle(oscTitle, projectName));
      lastAppliedAtRef.current = Date.now();
    },
    [props.api, sessionId],
  );
  // Trailing-edge throttle: the first title in any OSC_TITLE_THROTTLE_MS
  // window applies immediately (lastAppliedAtRef starts at 0, so the very
  // first call in this panel's lifetime is always instant — no delay before
  // a freshly-opened terminal shows a real title). Every title that arrives
  // inside that window overwrites `pendingTitleRef` rather than scheduling
  // its own timer, so a burst of OSC events collapses to exactly one
  // trailing apply carrying the LATEST title, not the first-in-window one.
  const lastAppliedAtRef = useRef(0);
  const pendingTitleRef = useRef<string | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTitleChange = useCallback(
    (oscTitle: string) => {
      const elapsed = Date.now() - lastAppliedAtRef.current;
      if (elapsed >= OSC_TITLE_THROTTLE_MS) {
        if (throttleTimerRef.current) {
          clearTimeout(throttleTimerRef.current);
          throttleTimerRef.current = null;
        }
        applyTitle(oscTitle);
        return;
      }
      pendingTitleRef.current = oscTitle;
      if (throttleTimerRef.current) return; // already scheduled for this window
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null;
        const latest = pendingTitleRef.current;
        pendingTitleRef.current = null;
        if (latest !== null) applyTitle(latest);
      }, OSC_TITLE_THROTTLE_MS - elapsed);
    },
    [applyTitle],
  );
  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    };
  }, []);
  // U7 — same api.onDidActiveChange subscription PaneTab.tsx already uses
  // for its own badge logic (see that component's own comment on why the
  // useState initializer, not the effect, is what makes an already-active
  // tab at mount — e.g. the default tab on first load — read correctly).
  // TerminalPane itself stays dockview-agnostic (see its own header
  // comment), so this wrapper is where the dockview panel API lives and
  // where the resulting plain boolean gets threaded down.
  const [isActive, setIsActive] = useState(props.api.isActive);
  useEffect(() => {
    const disposable = props.api.onDidActiveChange((e) => setIsActive(e.isActive));
    return () => disposable.dispose();
  }, [sessionId, props.api]);
  return (
    <div
      className={highlightedPanelId === panelId ? "panel-body-highlight" : ""}
      // position: relative anchors .panel-body-highlight::after's absolute
      // overlay (see styles.css) — the highlight itself is drawn as a sibling
      // overlay on top of this div's content, not an inset shadow on this div
      // directly, since TerminalPane's own inner container (issue #132's
      // opaque background) would otherwise paint straight over an inset
      // shadow here.
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      <ErrorBoundary onReset={resetPanel}>
        <TerminalPane
          key={resetKey}
          params={props.params}
          onTitleChange={onTitleChange}
          active={isActive}
        />
      </ErrorBoundary>
    </div>
  );
}

// A crash here is much lower-stakes than a terminal pane (a static status
// fetch, not a live WS/xterm connection), but wrapped the same way for the
// same reason: one project's GitHub panel misbehaving shouldn't blank the
// whole dashboard.
const GitHubPanelWrapper = makePanelWrapper<GitHubPanelParams>(GitHubPanel);

// Same reasoning as GitHubPanelWrapper above. Resolves onOpenSession via
// props.containerApi rather than needing App()'s own onOpenSession closure
// threaded down, same shape as TaskDetailWrapper below.
function GitPanelWrapper(props: IDockviewPanelProps<GitPanelParams>) {
  const [resetKey, resetPanel] = useResetKey();
  const projects = useDashboardStore((s) => s.projects);
  const layout = useLayoutContext();
  return (
    <ErrorBoundary onReset={resetPanel}>
      <GitPanel
        key={resetKey}
        params={props.params}
        onOpenSession={(session) => {
          openSessionPanel(props.containerApi, session, layout, projects);
        }}
      />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above — a crashing agent-rules fetch
// shouldn't blank the whole dashboard either.
const AgentRulesPanelWrapper = makePanelWrapper<AgentRulesPanelParams>(AgentRulesPanel);

// Same reasoning as GitHubPanelWrapper above — a crashing project-briefing
// fetch shouldn't blank the whole dashboard either.
const ProjectBriefingPanelWrapper =
  makePanelWrapper<ProjectBriefingPanelParams>(ProjectBriefingPanel);

// Same reasoning as GitHubPanelWrapper above — a crashing setup-preview
// fetch shouldn't blank the whole dashboard either.
const ProjectSetupPanelWrapper = makePanelWrapper<ProjectSetupPanelParams>(ProjectSetupPanel);

// Same reasoning as GitHubPanelWrapper above — a crashing dock-config fetch
// shouldn't blank the whole dashboard either.
const DockConfigPanelWrapper = makePanelWrapper<DockConfigPanelParams>(DockConfigPanel);

// Same reasoning as GitHubPanelWrapper above — a crashing skills fetch
// shouldn't blank the whole dashboard either.
const SkillsPanelWrapper = makePanelWrapper<SkillsPanelParams>(SkillsPanel);

// Same reasoning as GitHubPanelWrapper above — a crashing iframe/preview
// fetch shouldn't blank the whole dashboard either.
const BrowserPanelWrapper = makePanelWrapper<
  BrowserPanelParams,
  { api: IDockviewPanelProps<BrowserPanelParams>["api"] }
>(LazyBrowserPanel, { suspense: true, extraProps: (props) => ({ api: props.api }) });

// Same reasoning as GitHubPanelWrapper above — a stream-parsing/canvas
// crash shouldn't blank the whole dashboard either. Reports the Playwright
// page's title up via props.api.setTitle, same shape as
// TerminalPanelWrapper's onTitleChange but simpler (no nameLocked/rename
// concept for this panel type yet).
function BrowserPaneWrapper(props: IDockviewPanelProps<BrowserPaneParams>) {
  const [resetKey, resetPanel] = useResetKey();
  const onTitleChange = useCallback(
    (pageTitle: string) => {
      props.api.setTitle(pageTitle ? `Agent Browser: ${pageTitle}` : "Agent Browser");
    },
    [props.api],
  );
  return (
    <ErrorBoundary onReset={resetPanel}>
      {/* Same host-div fix as makePanelWrapper's own suspense branch above —
          see its comment. */}
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <Suspense fallback={<LazyPanelFallback />}>
          <LazyBrowserPane key={resetKey} params={props.params} onTitleChange={onTitleChange} />
        </Suspense>
      </div>
    </ErrorBoundary>
  );
}

// B2 — the Kanban board overlay (not a dockview panel, see its render site's
// own "overlay, not a conditionally-mounted replacement" comment for why
// dockview stays untouched underneath). Same ErrorBoundary+resetKey pattern
// as the panel wrappers above, kept as its own component (rather than inline
// JSX in App's render) purely so it can own that local resetKey — App's
// render body has no natural per-mount slot for it.
export function KanbanBoardOverlay(props: {
  onOpenSession: (session: Session) => void;
  onSessionEnded: (session: Session) => void;
}) {
  const [resetKey, resetPanel] = useResetKey();
  return (
    <div className="kanban-board-overlay" style={{ position: "absolute", inset: 0 }}>
      <ErrorBoundary onReset={resetPanel}>
        <Suspense fallback={<LazyPanelFallback />}>
          <LazyUnifiedBoard
            key={resetKey}
            onOpenSession={props.onOpenSession}
            onSessionEnded={props.onSessionEnded}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

// Same reasoning as GitHubPanelWrapper above — SessionTimeline reads
// straight off the store, no fetch of its own, but a bad event payload
// shouldn't blank the whole dashboard either.
const SessionTimelineWrapper = makePanelWrapper<SessionTimelineParams>(SessionTimeline);

// The task board (formerly TasksPanel.tsx, this "tasks" panel's own
// component) is now the unified Kanban view (UnifiedBoard.tsx) — this
// wrapper renders TasksPanelRedirect.tsx's explanatory stub instead, kept
// registered so an already-saved workspace layout referencing "tasks"
// doesn't throw on restore (see TasksPanelRedirect.tsx's own header comment,
// and the restore effect's closeLegacyPanels call in App.tsx, which
// self-heals a restored "tasks" panel away).
function TasksPanelRedirectWrapper(props: IDockviewPanelProps<Record<string, never>>) {
  const [resetKey, resetPanel] = useResetKey();
  const setViewMode = useDashboardStore((s) => s.setViewMode);
  return (
    <ErrorBoundary onReset={resetPanel}>
      <TasksPanelRedirect
        key={resetKey}
        onOpenBoard={() => {
          setViewMode("kanban");
          props.api.close();
        }}
      />
    </ErrorBoundary>
  );
}

// Same reasoning as GitHubPanelWrapper above. Resolves onOpenSession via
// props.containerApi rather than needing App()'s own onOpenSession closure
// threaded down. Kept registered (see TasksPanelRedirectWrapper above) even
// though task detail now normally opens as an inline drawer inside
// UnifiedBoard.tsx — a saved workspace layout can still contain a
// `task-detail-<id>` panel id.
function TaskDetailWrapper(props: IDockviewPanelProps<TaskDetailParams>) {
  const [resetKey, resetPanel] = useResetKey();
  const projects = useDashboardStore((s) => s.projects);
  const layout = useLayoutContext();
  return (
    <ErrorBoundary onReset={resetPanel}>
      <TaskDetail
        key={resetKey}
        params={props.params}
        onOpenSession={(session) => {
          openSessionPanel(props.containerApi, session, layout, projects);
        }}
      />
    </ErrorBoundary>
  );
}

// Dockview looks up a panel's renderer by the `component` key on the panel
// it's given (App.tsx's openSessionPanel/openTimelinePanel/etc. calls, plus
// whatever a persisted `workspaces.layout` blob names). These keys are
// persisted — do not rename any of them, that would silently break every
// already-saved layout.
//
// react-refresh/only-export-components flags these two object exports
// (below) because they sit in a file that also exports components — usually
// the fix is splitting data from components into separate files (see
// kanban.ts's own header comment for that general pattern). Deliberately
// not done here: this map's whole reason to exist is to stay in lockstep
// with the wrapper components above it, and splitting it out is exactly the
// "lift the wrapper registrations" this file is for undone. Fast Refresh
// degrading to a full reload on a panel-registration edit (rare, and this
// file's own edits are rare) is an acceptable trade for keeping the map and
// its wrappers colocated.
// eslint-disable-next-line react-refresh/only-export-components
export const components = {
  terminal: TerminalPanelWrapper,
  github: GitHubPanelWrapper,
  git: GitPanelWrapper,
  "agent-rules": AgentRulesPanelWrapper,
  "project-briefing": ProjectBriefingPanelWrapper,
  "project-setup": ProjectSetupPanelWrapper,
  "dock-config": DockConfigPanelWrapper,
  skills: SkillsPanelWrapper,
  browser: BrowserPanelWrapper,
  browserPane: BrowserPaneWrapper,
  timeline: SessionTimelineWrapper,
  tasks: TasksPanelRedirectWrapper,
  "task-detail": TaskDetailWrapper,
};

// The custom tab component (PaneTab) carries the redesign's most important
// distinction — close-pane (detach) vs. kill-session (guarded, ends the
// program) — so it only applies to "terminal" panels; "github"/"browser"/
// "browserPane" have no session to kill (browserPane's underlying Chromium
// is owned by BrowserManager, not this panel — closing the pane doesn't
// kill it, same "detach only" model as terminal), so they fall back to
// dockview's own default tab (title + plain close), same as this repo's
// other non-terminal panel types would.
// eslint-disable-next-line react-refresh/only-export-components
export const tabComponents = { terminal: PaneTab };
