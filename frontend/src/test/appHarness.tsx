// Shared mocks and helpers for App's integration tests (App.test.tsx,
// App.halves.test.tsx). Imported first by each, before App itself, so the
// mocks below are registered before App's module graph loads.
import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { LayoutMode } from "../api/index.js";
import { useDashboardStore } from "../store/index.js";

// Set by the pane-cap test before render. Null keeps every other test on the
// old path: DockviewReact never reports an api, and the palette stays empty.
const { splitHarness, sidebarHarness, dockHarness, persistenceHarness } = vi.hoisted(() => ({
  splitHarness: {
    api: null as {
      panels: unknown[];
      activePanel: null;
      getPanel: (id: string) => unknown;
      addPanel: (opts: { id: string; params?: { sessionId?: number } }) => void;
      onDidActivePanelChange: () => { dispose: () => void };
      onDidAddPanel: () => { dispose: () => void };
      onWillMutateLayout: () => { dispose: () => void };
      onDidMutateLayout: () => { dispose: () => void };
    } | null,
    launch: null as {
      id: number;
      projectId: number;
      name: string | null;
      nameLocked: boolean;
      lastTitle: string | null;
      command: string;
    } | null,
    announced: false,
  },
  sidebarHarness: {
    props: null as { workspaceProjectIds?: number[] | null } | null,
  },
  dockHarness: {
    props: null as { workspaceProjectIds?: number[] | null } | null,
  },
  persistenceHarness: {
    restoringRef: { current: false },
    restoredWorkspaceIdRef: { current: null as number | null },
  },
}));

// App is the integration seam for every layout tier, and nothing mounted it
// before the tablet-tier carry-over series. This is a deliberately shallow
// smoke harness: every child component and network-touching hook is stubbed,
// so what's under test is App's OWN tier wiring (initial tier seeding, the
// `data-tier` attribute, compact-vs-desktop sidebar semantics) — not the
// children, which have their own suites. jsdom does no layout, so geometry
// is out of scope here.

vi.mock("dockview-react", () => ({
  DockviewReact: (props: { onReady?: (event: { api: unknown }) => void }) => {
    if (splitHarness.api && !splitHarness.announced) {
      splitHarness.announced = true;
      queueMicrotask(() => props.onReady?.({ api: splitHarness.api }));
    }
    return <div data-testid="dockview" />;
  },
}));
vi.mock("dockview-react/dist/styles/dockview.css", () => ({}));
vi.mock("../Sidebar.js", () => ({
  Sidebar: (props: { workspaceProjectIds?: number[] | null }) => {
    sidebarHarness.props = props;
    return <div data-testid="sidebar" />;
  },
}));
vi.mock("../WorkspaceSwitcher.js", () => ({
  WorkspaceSwitcher: ({ onSelectWorkspace }: { onSelectWorkspace?: (id: number) => void }) => (
    <span data-testid="workspace-switcher">
      {splitHarness.launch ? (
        <button type="button" data-testid="show-workspace" onClick={() => onSelectWorkspace?.(2)} />
      ) : null}
    </span>
  ),
}));
vi.mock("../PhoneNavigator.js", () => ({
  PhoneNavigatorPanel: ({
    tablet,
    workspaces,
  }: {
    tablet?: boolean;
    workspaces?: React.ReactNode;
  }) => (
    <div data-testid="navigator" data-tablet={String(!!tablet)}>
      {workspaces}
    </div>
  ),
}));
vi.mock("../Toolbar.js", () => ({
  Toolbar: ({
    onToggleSidebar,
    notificationSheet,
    mobileSessionSlot,
  }: {
    onToggleSidebar?: () => void;
    notificationSheet?: boolean;
    mobileSessionSlot?: React.ReactNode;
  }) => (
    <div data-testid="toolbar">
      {onToggleSidebar && (
        <button
          data-testid="toggle-sidebar"
          data-notif-sheet={String(!!notificationSheet)}
          onClick={onToggleSidebar}
        />
      )}
      {mobileSessionSlot}
    </div>
  ),
}));
// From 700px the left rail holds the sidebar toggle the top bar used to (#3009).
// Same test id, so the tier-agnostic sidebar tests find whichever one renders.
vi.mock("../LeftRail.js", () => ({
  LeftRail: ({
    onToggleSidebar,
    notificationSheet,
    sidebarShown,
    middle,
  }: {
    onToggleSidebar: () => void;
    notificationSheet?: boolean;
    sidebarShown: boolean;
    middle?: React.ReactNode;
  }) => (
    <nav data-testid="left-rail" data-sidebar-shown={String(sidebarShown)}>
      <button
        data-testid="toggle-sidebar"
        data-notif-sheet={String(!!notificationSheet)}
        onClick={onToggleSidebar}
      />
      {middle}
    </nav>
  ),
}));
// The rail's middle region (#3009): records what App hands it.
const railHarness = vi.hoisted(() => ({
  props: null as null | {
    sheet: boolean;
    showPanes: boolean;
    panes: { id: string; title: string; sessionId: number | undefined }[];
    activePanelId: string | null;
    onFocusPane: (panelId: string) => void;
    onNewSession: () => void;
    onSelectWorkspace: (id: number) => void;
    menuItems?: (entry: { panelId: string }) => Array<{ label: string; onSelect: () => void }>;
  },
}));
vi.mock("../rail/RailWorkspaceSection.js", () => ({
  RailWorkspaceSection: (props: NonNullable<typeof railHarness.props>) => {
    railHarness.props = props;
    return <div data-testid="rail-middle" data-show-panes={String(props.showPanes)} />;
  },
}));
vi.mock("../MobileKeyBar.js", () => ({
  MobileKeyBar: ({ sessionId }: { sessionId: number }) => (
    <div data-testid="key-bar" data-session={sessionId} />
  ),
}));
// #3010 — the right half's pane and the launcher, as App wires them.
const foldHarness = vi.hoisted(() => ({
  rightHalf: null as null | { sessionId: number; focused: boolean; onUse: () => void },
  launcher: null as null | {
    onLaunched: (session: unknown, target: { half?: "left" | "right" } | null) => void;
  },
  onOpenSession: (() => {}) as (session: unknown) => void,
}));
vi.mock("../fold/RightHalfPane.js", () => ({
  RightHalfPane: (p: NonNullable<typeof foldHarness.rightHalf>) => {
    foldHarness.rightHalf = p;
    return <div data-testid="right-half" data-session={p.sessionId} />;
  },
}));
vi.mock("../launchers/SessionLauncher.js", () => ({
  SessionLauncherHost: (p: NonNullable<typeof foldHarness.launcher>) => {
    foldHarness.launcher = p;
    return null;
  },
}));
vi.mock("../MobileSessionBar.js", () => ({
  MobileSessionBar: ({ tier, contextLabel }: { tier: string; contextLabel?: string }) => (
    <span data-testid="session-bar" data-tier={tier} data-context={contextLabel ?? ""} />
  ),
}));
vi.mock("../PaneHeaderActions.js", () => ({ PaneHeaderActions: () => null }));
vi.mock("../CommandPalette.js", () => ({
  CommandPalette: (props: {
    onLaunched?: (session: NonNullable<typeof splitHarness.launch>) => void;
  }) => (
    <div data-testid="palette">
      {splitHarness.launch ? (
        <button
          type="button"
          data-testid="launch-split"
          onClick={() => props.onLaunched?.(splitHarness.launch!)}
        />
      ) : null}
    </div>
  ),
}));
vi.mock("../Dock.js", () => ({
  Dock: (props: { workspaceProjectIds?: number[] | null }) => {
    dockHarness.props = props;
    return null;
  },
}));
vi.mock("../ResourceAlertBanner.js", () => ({ ResourceAlertBanner: () => null }));
vi.mock("../panels/registry.js", () => ({
  components: {},
  tabComponents: {},
  KanbanBoardOverlay: ({ phone }: { phone?: boolean }) => (
    <div data-testid="kanban-overlay" data-phone={String(!!phone)} />
  ),
}));
vi.mock("../Settings.js", () => ({ Settings: () => null }));
vi.mock("../terminalRepaintRegistry.js", () => ({ repaintAllTerminals: vi.fn() }));
vi.mock("../pushClient.js", () => ({ ensurePushSubscribed: vi.fn().mockResolvedValue(undefined) }));

// Hooks that talk to the network, the DOM globally, or dockview.
vi.mock("../hooks/useAppStreams.js", () => ({ useAppStreams: vi.fn() }));
vi.mock("../hooks/usePolling.js", () => ({ usePolling: vi.fn() }));
vi.mock("../hooks/useAttentionNotifications.js", () => ({ useAttentionNotifications: vi.fn() }));
vi.mock("../hooks/useSessionDeepLink.js", () => ({ useSessionDeepLink: vi.fn() }));
vi.mock("../hooks/useOpenSessionRequest.js", () => ({ useOpenSessionRequest: vi.fn() }));
vi.mock("../hooks/useGlobalShortcuts.js", () => ({ useGlobalShortcuts: vi.fn() }));
vi.mock("../hooks/useDockviewDrop.js", () => ({
  useDockviewDrop: () => ({ dockviewRef: { current: null } }),
}));
vi.mock("../hooks/useWorkspacePersistence.js", () => ({
  useWorkspacePersistence: () => persistenceHarness,
}));
vi.mock("../hooks/useLayoutPresentation.js", () => ({ useLayoutPresentation: vi.fn() }));
vi.mock("../hooks/useVisualViewportInset.js", () => ({ useVisualViewportInset: vi.fn() }));
vi.mock("../hooks/usePanelOpener.js", () => ({
  usePanelOpener: () => ({ onOpenSession: (s: unknown) => foldHarness.onOpenSession(s) }),
}));
// The mode bar has its own tests (PhoneModeBar.test.tsx).
vi.mock("../PhoneModeBar.js", () => ({ PhoneModeBar: () => <nav data-testid="mode-bar" /> }));
vi.mock("../hooks/usePhoneBackStack.js", () => ({ usePhoneBackStack: vi.fn() }));
vi.mock("../lib/sidebarSwipeGesture.js", () => ({
  attachSidebarSwipeGesture: vi.fn(() => () => {}),
}));

export function setLayoutMode(layoutMode: LayoutMode) {
  useDashboardStore.setState({
    settings: { ...useDashboardStore.getState().settings, layoutMode },
  });
}

// matchMedia stub keyed on the width tier the test wants to simulate.
// "halves" is the tablet tier inside the two-halves band, 800-1099px (#3010).
export type StubWidth = "phone" | "tablet" | "desktop" | "halves";
export function widthMatches(tier: StubWidth, query: string, coarse: boolean): boolean {
  return (
    (tier === "halves" &&
      (query === "(min-width: 700px) and (max-width: 1279.98px)" ||
        query === "(min-width: 800px) and (max-width: 1099.98px)")) ||
    (tier === "phone" && query.includes("max-width: 699.98px")) ||
    (tier === "tablet" && query.includes("min-width: 700px")) ||
    (tier === "desktop" && query.includes("min-width: 1280px")) ||
    (coarse && query === "(pointer: coarse)")
  );
}
export function stubWidth(tier: StubWidth, coarse = false) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: widthMatches(tier, query, coarse),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}
// A width that can change: `resize` fires the media queries' listeners (the
// layout band follows them), the tier is set separately, as
// useLayoutPresentation would, so the two can cross one commit apart.
export function stubLiveWidth(initial: StubWidth) {
  let width = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return widthMatches(width, query, false);
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    })),
  );
  return {
    resize(next: StubWidth) {
      width = next;
      act(() => {
        for (const l of [...listeners]) l();
      });
    },
  };
}

export { splitHarness, sidebarHarness, dockHarness, persistenceHarness, railHarness, foldHarness };
