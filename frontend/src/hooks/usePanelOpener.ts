import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DockviewApi } from "dockview-react";
import type { Project, Session, Workspace } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";
import { randomPanelId } from "../random-id.js";
import {
  findSessionWorkspace,
  maximizeIfTiled,
  openOrFocusProjectPanel,
  openSessionPanel,
  openTimelinePanel,
} from "../panelUtils.js";
import type { ProjectPanelKindConfig } from "../panelUtils.js";

// The six near-identical project-scoped panel kinds (GitHub, Git, Agent
// Rules, Dock Config, Skills, Browser) — see openOrFocusProjectPanel's own
// header comment in panelUtils.ts for the shared open-or-focus shape these
// configs drive. Module-level (not created per-render) so each is a stable
// object identity, same as any other constant App.tsx or its hooks close
// over — this is what lets onOpenGitHub/onOpenGit/etc. below list only the
// values that can actually change (dockviewApi/projects/isMobile/
// setSidebarOpen) in their own useCallback dependency arrays, with no need
// to also list the config object itself.
const GITHUB_CONFIG: ProjectPanelKindConfig = {
  kind: "github",
  titleLabel: "GitHub",
  applyDesktopPositioning: true,
};
const GIT_CONFIG: ProjectPanelKindConfig = {
  kind: "git",
  titleLabel: "Git",
  applyDesktopPositioning: true,
};
const AGENT_RULES_CONFIG: ProjectPanelKindConfig = {
  kind: "agent-rules",
  titleLabel: "Agent Rules",
  applyDesktopPositioning: true,
};
const DOCK_CONFIG_CONFIG: ProjectPanelKindConfig = {
  kind: "dock-config",
  titleLabel: "Dock",
  applyDesktopPositioning: true,
};
const SKILLS_CONFIG: ProjectPanelKindConfig = {
  kind: "skills",
  titleLabel: "Skills",
  applyDesktopPositioning: true,
};
// applyDesktopPositioning: false — App.tsx's pre-existing onOpenBrowser never
// applied the float-if-tiled-else-dock desktop positioning the other five
// project panel kinds get; a real, pre-existing asymmetry (issue #28), not
// an oversight introduced by this generalization. See
// ProjectPanelKindConfig's own doc comment in panelUtils.ts and the
// regression test guarding this ("applyDesktopPositioning: false omits both
// floating and position...") in panelUtils.test.ts.
const BROWSER_CONFIG: ProjectPanelKindConfig = {
  kind: "browser",
  titleLabel: "Preview",
  applyDesktopPositioning: false,
};

export interface UsePanelOpenerParams {
  dockviewApi: DockviewApi | null;
  isMobile: boolean;
  projects: Project[];
  // Only onOpenSession's cross-workspace branch reads this (findSessionWorkspace) —
  // every other opener below is workspace-agnostic (it only ever acts within
  // whichever workspace's dockview instance is currently live).
  workspaces: Workspace[];
  activeWorkspaceId: number | null;
  // Deliberately NOT a param here: `sessions`. onOpenSession takes the
  // session it should open as its own call-time argument, so it never needs
  // the full list — and not accepting one at all is what keeps its identity
  // (and therefore this whole hook's returned object) immune to the 4s
  // sessions poll tick, which replaces `sessions` with a fresh array
  // identity every tick regardless of content. useSessionDeepLink's own
  // effect dependency array relies on exactly this (see its own doc comment
  // on `onOpenSession`) — adding `sessions` here to "look something up"
  // would silently break that.
  // Must be the raw `useState` setter (stable identity forever) — same
  // requirement as useDockviewDrop's `setSidebarOpen`/useWorkspacePersistence's
  // `setPanelsVersion`/useMobileLayout's `setIsMobile` (see those hooks' own
  // param comments). Listed in every callback below's own dependency array
  // purely because eslint's exhaustive-deps rule can no longer statically
  // prove a function-parameter's identity is stable the way it can for a
  // bare `useState` call in this same file — not because it ever actually
  // changes. Since it never does, this is a lint-satisfying addition to each
  // callback's dependency array relative to App.tsx's pre-extraction
  // versions (which read the local `useState` setter directly and so didn't
  // need to list it), not a behavior or identity-stability change.
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
}

export interface UsePanelOpenerResult {
  // Opens (or focuses, with a cross-workspace switch + highlight when the
  // session's panel lives in a different workspace's saved layout) a
  // session's terminal panel. Identity matters: useSessionDeepLink
  // (hooks/useSessionDeepLink.ts) lists this in its own effect's dependency
  // array, App.tsx's handleLaunched lists it in its useCallback dependency
  // array, and App.tsx's onOpenSessionRef mirrors it into a ref on every
  // change — all three rely on this only changing identity when
  // dockviewApi/isMobile/projects/workspaces/activeWorkspaceId actually
  // change (see this hook's own onOpenSession dependency array), not on
  // every render.
  onOpenSession: (session: Session) => void;
  // Sidebar kebab "Open as new window" — always opens as float in the
  // current workspace regardless of which workspace the session belongs to.
  onOpenSessionAsFloat: (session: Session) => void;
  // Issue #270 — notification-row click opens the timeline instead of the
  // terminal.
  onOpenTimeline: (session: Session) => void;
  // Opens (or focuses) a project's GitHub panel.
  onOpenGitHub: (projectId: number) => void;
  // Opens (or focuses) a project's git status panel (issue #76).
  onOpenGit: (projectId: number) => void;
  // Opens (or focuses) a project's agent-rules editor (issue #431).
  onOpenAgentRules: (projectId: number) => void;
  // U4 — opens (or focuses) a project's dock-config editor.
  onOpenDockConfig: (projectId: number) => void;
  // Opens (or focuses) a project's (read-only) skills panel (issue #432).
  onOpenSkills: (projectId: number) => void;
  // Opens (or focuses) a project's dev-server browser preview pane (issue
  // #28). See BROWSER_CONFIG's own comment above for the one respect in
  // which this differs from onOpenGitHub/onOpenGit/onOpenAgentRules/
  // onOpenDockConfig/onOpenSkills.
  onOpenBrowser: (projectId: number) => void;
  // The task board is the unified Kanban view (UnifiedBoard.tsx), not a
  // dockview panel — this just switches `viewMode`.
  onOpenTasks: () => void;
  // Issue #109 — opens a browser pane pre-filled with a specific favorited
  // URL. Always creates a fresh panel (random id suffix); never
  // open-or-focus, unlike every panel kind above.
  onOpenBrowserUrl: (projectId: number, url: string, label: string) => void;
  // Issue #28's general-purpose blank browser tile (CommandPalette's "New
  // browser tab"). Always creates a fresh panel, same as onOpenBrowserUrl.
  onOpenBlankBrowser: () => void;
}

// Extracted from App.tsx (PR 34h of the hook-extraction series, the final PR
// of the 35-PR roadmap) — collapses the 12 `onOpen*` panel-opening callbacks
// App.tsx used to declare inline into this one hook. (The roadmap entry for
// this PR estimated "16 near-identical `onOpen*` callbacks"; the actual
// count in App.tsx is 12 — see this PR's own description for where that
// estimate likely came from and why the other three `open*`-prefixed
// callbacks in App.tsx, `openSettings`/`openGlobalLauncher`/
// `openProjectLauncher`, were deliberately left out: none of them open a
// dockview panel — they set modal/palette state instead.)
//
// Unlike every other hook in this extraction series (34a-34g), this one
// registers no effects at all — every value it returns is a `useCallback`.
// That means its call-site position in App.tsx is NOT constrained by effect
// ordering the way useWorkspacePersistence/useMobileLayout/useSessionDeepLink
// are. It IS constrained by closure order, though: `onOpenSession` must be
// defined before useSessionDeepLink's own call and before the
// onOpenSessionRef mirroring effect both read it — so App.tsx calls this
// hook at the exact position `onOpenSession`'s own declaration used to
// occupy, before both of those.
//
// Six of the twelve (onOpenGitHub/onOpenGit/onOpenAgentRules/
// onOpenDockConfig/onOpenSkills/onOpenBrowser) share one truly identical
// shape (open-or-focus-by-`<kind>-<projectId>`, float-if-tiled-else-dock,
// project-derived title) and are built from one shared pure helper,
// openOrFocusProjectPanel (panelUtils.ts), parameterized by the config
// table above — same "pure function in panelUtils.ts, wrapped in a
// useCallback here" split as openSessionPanel/openTimelinePanel already
// use. The other six (onOpenSession, onOpenSessionAsFloat, onOpenTimeline,
// onOpenTasks, onOpenBrowserUrl, onOpenBlankBrowser) each have genuinely
// distinct logic — see their own doc comments below — and stay as
// individually-written callbacks rather than being forced through a shared
// helper that doesn't actually fit their shape.
export function usePanelOpener({
  dockviewApi,
  isMobile,
  projects,
  workspaces,
  activeWorkspaceId,
  setSidebarOpen,
}: UsePanelOpenerParams): UsePanelOpenerResult {
  // Issue: opening any dockview panel while the Tasks board (UnifiedBoard,
  // a z-index 100 overlay on top of the dockview grid — see App.tsx's own
  // `viewMode === "kanban"` render site) is up used to activate/focus the
  // panel behind that overlay, invisibly — the panel really did open, there
  // was just no way to see it short of the Toolbar's "Back" chevron. Every
  // opener below calls this first (after its own `!dockviewApi` guard, so a
  // no-op call — nothing to open — doesn't still kick the user out of
  // Tasks). `onOpenTasks` is the one deliberate exception: it's the
  // opposite transition, into Tasks. UnifiedBoard.tsx's own former
  // `openSession` wrapper enforced exactly this one-off, for exactly this
  // reason, for the single call path that went through it — this closes
  // every other path the same way instead of leaving them all still broken.
  const leaveTaskView = useCallback(() => {
    useDashboardStore.getState().setViewMode("list");
  }, []);

  const onOpenSession = useCallback(
    (session: Session) => {
      if (!dockviewApi) return;
      leaveTaskView();
      const panelId = `session-${session.id}`;
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setActive();
        useDashboardStore.getState().triggerPanelHighlight(panelId);
      } else {
        const wsId = findSessionWorkspace(session.id, workspaces);
        if (wsId != null && wsId !== activeWorkspaceId) {
          useDashboardStore.getState().triggerPanelHighlight(panelId);
          useDashboardStore.getState().setActiveWorkspaceId(wsId);
        } else {
          openSessionPanel(dockviewApi, session, isMobile, projects);
        }
      }
      setSidebarOpen(false);
    },
    [dockviewApi, isMobile, projects, workspaces, activeWorkspaceId, setSidebarOpen, leaveTaskView],
  );

  const onOpenSessionAsFloat = useCallback(
    (session: Session) => {
      if (!dockviewApi) return;
      leaveTaskView();
      openSessionPanel(dockviewApi, session, isMobile, projects);
      setSidebarOpen(false);
    },
    [dockviewApi, isMobile, projects, setSidebarOpen, leaveTaskView],
  );

  const onOpenTimeline = useCallback(
    (session: Session) => {
      if (!dockviewApi) return;
      leaveTaskView();
      openTimelinePanel(dockviewApi, session);
      setSidebarOpen(false);
    },
    [dockviewApi, setSidebarOpen, leaveTaskView],
  );

  const onOpenGitHub = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      leaveTaskView();
      openOrFocusProjectPanel(dockviewApi, projectId, projects, isMobile, GITHUB_CONFIG);
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile, setSidebarOpen, leaveTaskView],
  );

  const onOpenGit = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      leaveTaskView();
      openOrFocusProjectPanel(dockviewApi, projectId, projects, isMobile, GIT_CONFIG);
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile, setSidebarOpen, leaveTaskView],
  );

  const onOpenAgentRules = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      leaveTaskView();
      openOrFocusProjectPanel(dockviewApi, projectId, projects, isMobile, AGENT_RULES_CONFIG);
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile, setSidebarOpen, leaveTaskView],
  );

  const onOpenDockConfig = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      leaveTaskView();
      openOrFocusProjectPanel(dockviewApi, projectId, projects, isMobile, DOCK_CONFIG_CONFIG);
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile, setSidebarOpen, leaveTaskView],
  );

  const onOpenSkills = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      leaveTaskView();
      openOrFocusProjectPanel(dockviewApi, projectId, projects, isMobile, SKILLS_CONFIG);
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile, setSidebarOpen, leaveTaskView],
  );

  const onOpenBrowser = useCallback(
    (projectId: number) => {
      if (!dockviewApi) return;
      leaveTaskView();
      openOrFocusProjectPanel(dockviewApi, projectId, projects, isMobile, BROWSER_CONFIG);
      setSidebarOpen(false);
    },
    [dockviewApi, projects, isMobile, setSidebarOpen, leaveTaskView],
  );

  const onOpenTasks = useCallback(() => {
    useDashboardStore.getState().setViewMode("kanban");
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  const onOpenBrowserUrl = useCallback(
    (projectId: number, url: string, label: string) => {
      if (!dockviewApi) return;
      leaveTaskView();
      const panel = dockviewApi.addPanel({
        id: `browser-url-${projectId}-${randomPanelId()}`,
        component: "browser",
        title: label,
        params: { kind: "external", url, projectId },
      });
      // Bug fix (independent review) — no explicit position/floating option
      // is passed here, so a fresh panel joins `activeGroup` (verified in
      // dockview-core's `_doAddPanel`) — which can itself be floating (e.g.
      // a workspace with no tiled panels), making a bare `maximizeGroup`
      // throw the same way applyMobilePresentation's own fix (panelUtils.ts)
      // prevents elsewhere.
      if (isMobile) maximizeIfTiled(dockviewApi, panel);
      setSidebarOpen(false);
    },
    [dockviewApi, isMobile, setSidebarOpen, leaveTaskView],
  );

  const onOpenBlankBrowser = useCallback(() => {
    if (!dockviewApi) return;
    leaveTaskView();
    const panel = dockviewApi.addPanel({
      id: `browser-ext-${randomPanelId()}`,
      component: "browser",
      title: "Preview",
      params: { kind: "external" },
    });
    // Same guard as onOpenBrowserUrl above — see its own comment.
    if (isMobile) maximizeIfTiled(dockviewApi, panel);
    setSidebarOpen(false);
  }, [dockviewApi, isMobile, setSidebarOpen, leaveTaskView]);

  return {
    onOpenSession,
    onOpenSessionAsFloat,
    onOpenTimeline,
    onOpenGitHub,
    onOpenGit,
    onOpenAgentRules,
    onOpenDockConfig,
    onOpenSkills,
    onOpenBrowser,
    onOpenTasks,
    onOpenBrowserUrl,
    onOpenBlankBrowser,
  };
}
