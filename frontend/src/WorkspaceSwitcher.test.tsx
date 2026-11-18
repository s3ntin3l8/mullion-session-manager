// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import * as panelUtils from "./panelUtils.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { WORKSPACE_FOCUS_FALLBACK } from "./paletteFocusTargets.js";
import { useDashboardStore } from "./store/index.js";
import { api } from "./api/index.js";
import type { Group, Workspace, Session, Task } from "./api/index.js";
import { resetStore } from "./test/resetStore.js";
import { moveWorkspace } from "./workspaceActions.js";
import type * as WorkspaceActions from "./workspaceActions.js";

// The drag tests below check what is moved where; moveWorkspace's own math
// is reorder.ts's (and its tests').
vi.mock("./workspaceActions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceActions>()),
  moveWorkspace: vi.fn(),
}));

// Deliberately NOT using test/fixtures.ts's makeSession/makeWorkspace here:
// this file's own defaults are tightly coupled to each other (the
// workspace's `layout` references session id 7 by id, and the session
// itself defaults to a specific already-attached/idle/dormant shape) in a
// way fixtures.ts's general-purpose defaults aren't — forcing this onto the
// shared builder would mean overriding most fields at every call site
// instead of the current zero-arg `makeWorkspace()`/`makeSession()`, a net
// readability loss for a shape that (per the file-duplication survey) isn't
// actually repeated anywhere else.
function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 1,
    name: "Default",
    groupId: null,
    position: 0,
    layout: { views: [{ params: { sessionId: 7 } }] },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    name: "My group",
    icon: null,
    color: null,
    collapsed: false,
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 7,
    projectId: 1,
    parentSessionId: null,
    name: "claude code",
    nameLocked: true,
    command: "claude code",
    cwd: null,
    env: null,
    liveCwd: null,
    previewBranch: null,
    kind: "terminal",
    status: "active",
    // Issue #1727 — the session's host: the raw column (null = inherits
    // its project's) and the resolved one the host badge shows.
    hostId: null,
    resolvedHostId: "local",
    // Issue #1852 — the placement decision's own words; null when
    // nothing was decided here (a test session's default).
    placementReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAttachedAt: "2026-01-01T00:00:00.000Z",
    alive: true,
    subscriberCount: 1,
    activity: "idle",
    lastActivityAt: Date.now(),
    attention: false,
    attentionAt: null,
    lastTitle: null,
    gateState: "idle",
    gates: [],
    gatePrompt: null,
    promoteState: "idle",
    promoteSummary: null,
    promoteSuggestedBaseRef: null,
    permissionState: "idle",
    planState: "idle",
    errorState: "idle",
    endedReason: null,
    liveBranch: null,
    exitCode: null,
    attentionKind: null,
    errorDetail: null,
    lastAssistantMessage: null,
    currentTodo: null,
    compactState: "idle",
    subagentCount: 0,
    subagents: [],
    elicitationState: "idle",
    elicitationServer: null,
    lastTurnEndedAt: null,
    stateRestored: true,
    staleHooks: false,
    restoredVersion: null,
    sessionStatus: "idle",
    sessionStatusSeverity: "dormant",
    sessionStatusDetail: null,
    sessionStatusAttentionRequired: false,
    hookEmits: [],
    pendingDevServerPort: null,
    outstandingBackgroundTasks: [],
    ...overrides,
  };
}

describe("WorkspaceSwitcher", () => {
  beforeEach(() => {
    resetStore({
      workspaces: [makeWorkspace()],
      groups: [],
      sessions: [makeSession()],
      activeWorkspaceId: 1,
      tasks: [],
    });
    vi.spyOn(api, "listGroups").mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // P1 — this component used to be a single bare `useDashboardStore()` call
  // (whole-store subscription), so it re-rendered on ANY store write —
  // including the 4s live-refresh tick's unrelated fields (tasks,
  // gitStatuses, settings, …). WorkspaceSwitcher takes no props and reads
  // only the store, which makes it a clean render-count harness: wrap it in
  // a <Profiler> and count commits directly, rather than trying to infer
  // renders from side effects.
  describe("P1 — selector-scoped re-renders", () => {
    it("does not re-render when a store slice it doesn't read changes", async () => {
      let renderCount = 0;
      const onRender: ProfilerOnRenderCallback = () => {
        renderCount += 1;
      };
      render(
        <Profiler id="ws" onRender={onRender}>
          <WorkspaceSwitcher />
        </Profiler>,
      );
      await act(async () => {});
      const countAfterMount = renderCount;
      expect(countAfterMount).toBeGreaterThan(0);

      // `tasks` is not one of the fields WorkspaceSwitcher selects.
      act(() => {
        useDashboardStore.setState({ tasks: [{ id: 1 } as Task] });
      });
      expect(renderCount).toBe(countAfterMount);
    });

    it("re-renders when `workspaces` — a field it does read — changes identity", async () => {
      let renderCount = 0;
      const onRender: ProfilerOnRenderCallback = () => {
        renderCount += 1;
      };
      render(
        <Profiler id="ws" onRender={onRender}>
          <WorkspaceSwitcher />
        </Profiler>,
      );
      await act(async () => {});
      const countAfterMount = renderCount;

      act(() => {
        useDashboardStore.setState({
          workspaces: [makeWorkspace({ id: 1 }), makeWorkspace({ id: 2, name: "Second" })],
        });
      });
      expect(renderCount).toBeGreaterThan(countAfterMount);
    });
  });

  // P2 — workspaceLiveStatus used to walk `workspace.layout` (recursively,
  // via extractSessionIds) inline inside the row-rendering `.map()`, so
  // every render re-walked every workspace's layout regardless of whether
  // `workspaces` itself had changed. Now that walk only happens inside a
  // `useMemo` keyed on `workspaces` — asserted here by spying on
  // extractSessionIds directly and counting calls across renders driven by
  // unrelated (`sessions`) vs. relevant (`workspaces`) state changes.
  describe("P2 — sessionIdsByWorkspace memoization", () => {
    it("calls extractSessionIds once per workspace on mount, and not again when only `sessions` changes", async () => {
      const spy = vi.spyOn(panelUtils, "extractSessionIds");
      render(<WorkspaceSwitcher />);
      await act(async () => {});
      const callsAfterMount = spy.mock.calls.length;
      expect(callsAfterMount).toBe(1); // one workspace in beforeEach's fixture

      // Simulates a live-refresh poll tick: `sessions` gets a fresh array
      // identity, `workspaces` does not.
      act(() => {
        useDashboardStore.setState({ sessions: [makeSession({ attention: true })] });
      });
      expect(spy.mock.calls.length).toBe(callsAfterMount);
    });

    it("re-derives sessionIdsByWorkspace when `workspaces` itself changes", async () => {
      const spy = vi.spyOn(panelUtils, "extractSessionIds");
      render(<WorkspaceSwitcher />);
      await act(async () => {});
      const callsAfterMount = spy.mock.calls.length;

      act(() => {
        useDashboardStore.setState({
          workspaces: [
            makeWorkspace({ id: 1 }),
            makeWorkspace({ id: 2, layout: { views: [{ params: { sessionId: 8 } }] } }),
          ],
        });
      });
      // Both workspaces' layouts get walked again — the memo recomputed the
      // whole map (recomputing per-workspace, not incrementally), which is
      // still correct and still only fires on a `workspaces` change.
      expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
    });

    it("still derives the correct live status against the CURRENT sessions after a memoized (unchanged) id-set lookup", async () => {
      const { container } = render(<WorkspaceSwitcher />);
      await act(async () => {});
      // Session 7 (referenced by the fixture workspace's layout) starts
      // idle/no-attention — no dot rendered yet.
      expect(container.querySelector(".workspace-attn-dot")).toBeNull();

      act(() => {
        useDashboardStore.setState({ sessions: [makeSession({ attention: true })] });
      });
      // Proves deriveWorkspaceLiveStatus still runs against the fresh
      // `sessions` array on every render, even though the memoized id Set
      // it's intersected against wasn't recomputed for this update.
      expect(container.querySelector(".workspace-attn-dot")).not.toBeNull();
    });
  });

  // P10 — the workspace row and group header were bare <div onClick>s with
  // no keyboard support. Same role="button"/tabIndex/Enter-Space pattern as
  // Sidebar.tsx's SessionRow/ProjectHeader.
  describe("P10 — keyboard accessibility", () => {
    // #2886 — axe `nested-interactive`: the row holds a grip, a rename input
    // and a kebab, so it is not itself a button; its name is its one button.
    it("workspace row has one real button, its name, that selects on Enter", async () => {
      const user = userEvent.setup();
      useDashboardStore.setState({ activeWorkspaceId: null });
      const { container } = render(<WorkspaceSwitcher />);
      const row = container.querySelector(".workspace-item") as HTMLElement;
      expect(row).not.toHaveAttribute("role");
      expect(row).not.toHaveAttribute("tabIndex");
      expect(row.querySelector("[role='button'] button, button button")).toBeNull();
      const name = row.querySelector("button.workspace-item-name") as HTMLElement;

      name.focus();
      await user.keyboard("{Enter}");

      expect(useDashboardStore.getState().activeWorkspaceId).toBe(1);
    });

    it("workspace row selects on Space too", async () => {
      const user = userEvent.setup();
      useDashboardStore.setState({ activeWorkspaceId: null });
      const { container } = render(<WorkspaceSwitcher />);
      const name = container.querySelector("button.workspace-item-name") as HTMLElement;

      name.focus();
      await user.keyboard(" ");

      expect(useDashboardStore.getState().activeWorkspaceId).toBe(1);
    });

    // Issue: selecting a workspace from Tasks used to leave viewMode at
    // "kanban" — the workspace really did switch, just invisibly behind the
    // Tasks board's own overlay.
    it("selecting a workspace while in Tasks (viewMode: kanban) switches back to list view", async () => {
      const user = userEvent.setup();
      useDashboardStore.setState({ activeWorkspaceId: null, viewMode: "kanban" });
      const { container } = render(<WorkspaceSwitcher />);
      const row = container.querySelector(".workspace-item") as HTMLElement;

      await user.click(row);

      expect(useDashboardStore.getState().activeWorkspaceId).toBe(1);
      expect(useDashboardStore.getState().viewMode).toBe("list");
    });

    it("does not double-fire selection when the row's own kebab menu is clicked", async () => {
      const user = userEvent.setup();
      useDashboardStore.setState({ activeWorkspaceId: null });
      const { container } = render(<WorkspaceSwitcher />);
      const kebab = container.querySelector(
        ".workspace-item-actions button[title='More…']",
      ) as HTMLElement;

      await user.click(kebab);

      expect(useDashboardStore.getState().activeWorkspaceId).toBeNull();
    });

    it("group header's chevron is its disclosure button and toggles collapse on Enter", async () => {
      // WorkspaceSwitcher's mount effect (useWorkspaceTree) fires
      // refreshGroups() while no groups are loaded yet, which could otherwise
      // overwrite the `groups` state set below with the
      // outer beforeEach's `listGroups` mock (`[]`) the instant that promise
      // resolves — mirror it here so the group this test renders survives
      // that refresh.
      vi.spyOn(api, "listGroups").mockResolvedValue([makeGroup({ collapsed: false })]);
      vi.spyOn(api, "updateGroup").mockResolvedValue(makeGroup({ collapsed: true }));
      useDashboardStore.setState({
        groups: [makeGroup({ collapsed: false })],
        workspaces: [makeWorkspace({ groupId: 1 })],
      });
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);
      const header = container.querySelector(".ws-group-header") as HTMLElement;
      expect(header).not.toHaveAttribute("role");
      const toggle = header.querySelector("button.ws-group-toggle") as HTMLElement;
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(toggle).toHaveAttribute("aria-controls", "ws-group-body-1");

      toggle.focus();
      await user.keyboard("{Enter}");

      expect(api.updateGroup).toHaveBeenCalledWith(1, { collapsed: true });
    });

    it("does not toggle group collapse when the delete-group button is clicked", async () => {
      // See the previous test's comment on why listGroups needs to agree
      // with the state set below — same mount-effect refresh race.
      vi.spyOn(api, "listGroups").mockResolvedValue([makeGroup({ collapsed: false })]);
      const updateGroup = vi.spyOn(api, "updateGroup").mockResolvedValue(makeGroup());
      useDashboardStore.setState({
        groups: [makeGroup({ collapsed: false })],
        workspaces: [makeWorkspace({ groupId: 1 })],
      });
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);
      const deleteBtn = container.querySelector(
        ".ws-group-actions button[title='Delete group']",
      ) as HTMLElement;

      await user.click(deleteBtn);

      expect(updateGroup).not.toHaveBeenCalled();
    });
  });

  // Tasks-as-a-destination — Tasks isn't a workspace, so the switcher must
  // not keep pointing at whatever workspace was active before it opened.
  describe("Tasks-as-a-destination", () => {
    it("highlights the active workspace normally when viewMode is not kanban", () => {
      resetStore({
        workspaces: [makeWorkspace()],
        groups: [],
        sessions: [makeSession()],
        activeWorkspaceId: 1,
        tasks: [],
      });
      const { container } = render(<WorkspaceSwitcher />);
      expect(container.querySelector(".workspace-item")).toHaveClass("active");
      expect(container.querySelector(".workspace-item-name")).toHaveAttribute(
        "data-focus-fallback",
        WORKSPACE_FOCUS_FALLBACK,
      );
    });

    it("drops the active-workspace highlight while viewMode is kanban, without touching activeWorkspaceId itself", () => {
      resetStore({
        workspaces: [makeWorkspace()],
        groups: [],
        sessions: [makeSession()],
        activeWorkspaceId: 1,
        viewMode: "kanban",
        tasks: [],
      });
      const { container } = render(<WorkspaceSwitcher />);
      expect(container.querySelector(".workspace-item")).not.toHaveClass("active");
      expect(container.querySelector(".workspace-item")).not.toHaveAttribute("data-focus-fallback");
      // The underlying selection is untouched — only the paint is
      // suppressed, so leaving Tasks restores the real highlight.
      expect(useDashboardStore.getState().activeWorkspaceId).toBe(1);
    });
  });

  describe("workspace selection", () => {
    it("calls onSelectWorkspace when clicking an ungrouped workspace", async () => {
      resetStore({
        workspaces: [makeWorkspace({ id: 2, name: "Workspace Two", groupId: null })],
        groups: [],
        sessions: [makeSession()],
        activeWorkspaceId: 1,
      });
      const onSelect = vi.fn();
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher onSelectWorkspace={onSelect} />);
      const item = container.querySelector(".workspace-item") as HTMLElement;

      await user.click(item);

      expect(onSelect).toHaveBeenCalledWith(2);
    });

    it("calls onSelectWorkspace when clicking a grouped workspace", async () => {
      const group = makeGroup({ id: 1, collapsed: false });
      vi.spyOn(api, "listGroups").mockResolvedValue([group]);
      resetStore({
        workspaces: [makeWorkspace({ id: 3, name: "Grouped Workspace", groupId: 1 })],
        groups: [group],
        sessions: [makeSession()],
        activeWorkspaceId: 1,
      });
      const onSelect = vi.fn();
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher onSelectWorkspace={onSelect} />);
      const item = container.querySelector(".workspace-item") as HTMLElement;

      await user.click(item);

      expect(onSelect).toHaveBeenCalledWith(3);
    });

    it("falls back to store.showWorkspace when onSelectWorkspace is not provided", async () => {
      resetStore({
        workspaces: [makeWorkspace({ id: 4, name: "Fallback Workspace", groupId: null })],
        groups: [],
        sessions: [makeSession()],
        activeWorkspaceId: 1,
      });
      const showWorkspaceSpy = vi.spyOn(useDashboardStore.getState(), "showWorkspace");
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);
      const item = container.querySelector(".workspace-item") as HTMLElement;

      await user.click(item);

      expect(showWorkspaceSpy).toHaveBeenCalledWith(4);
    });
  });

  // Sidebar declutter (issue #1465) — WORKSPACES gets the same collapse
  // chevron every other sidebar section already has.
  describe("section collapse (issue #1465)", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it("starts expanded by default and shows the workspace list", () => {
      const { container } = render(<WorkspaceSwitcher />);
      const header = container.querySelector(".ws-section-toggle") as HTMLElement;
      expect(header).toHaveAttribute("aria-expanded", "true");
      expect(container.querySelector(".workspace-item")).not.toBeNull();
    });

    it("hides the workspace list and 'New workspace' button on click, and shows them again on a second click", async () => {
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);
      const header = container.querySelector(".ws-section-toggle") as HTMLElement;

      await user.click(header);

      expect(header).toHaveAttribute("aria-expanded", "false");
      expect(container.querySelector(".workspace-item")).toBeNull();
      expect(container.querySelector(".discover-title")).toBeNull();

      await user.click(header);

      expect(header).toHaveAttribute("aria-expanded", "true");
      expect(container.querySelector(".workspace-item")).not.toBeNull();
    });

    it("toggles on Enter/Space when the header's toggle has focus", async () => {
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);
      const header = container.querySelector(".ws-section-toggle") as HTMLElement;
      // #2886 — the header row holds the "+" button, so it is not itself a
      // button; its chevron and title are the disclosure button.
      expect(container.querySelector(".ws-section-toggle")).not.toHaveAttribute("role");

      header.focus();
      await user.keyboard("{Enter}");
      expect(header).toHaveAttribute("aria-expanded", "false");

      await user.keyboard(" ");
      expect(header).toHaveAttribute("aria-expanded", "true");
    });

    it("clicking the '+' new-group button does not also toggle the section", async () => {
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);
      const header = container.querySelector(".ws-section-header") as HTMLElement;

      await user.click(header.querySelector(".toolbar-icon-btn")!);

      expect(header.querySelector(".ws-section-toggle")).toHaveAttribute("aria-expanded", "true");
    });

    it("persists the collapsed state across remounts via localStorage", async () => {
      const user = userEvent.setup();
      const first = render(<WorkspaceSwitcher />);
      await user.click(first.container.querySelector(".ws-section-toggle")!);
      expect(
        first.container.querySelector(".ws-section-toggle")!.getAttribute("aria-expanded"),
      ).toBe("false");
      first.unmount();

      const second = render(<WorkspaceSwitcher />);
      expect(
        second.container.querySelector(".ws-section-toggle")!.getAttribute("aria-expanded"),
      ).toBe("false");
    });

    it("shows an aggregate attention dot on the collapsed header when a workspace's session needs input", async () => {
      resetStore({
        workspaces: [makeWorkspace()],
        groups: [],
        sessions: [makeSession({ attention: true })],
        activeWorkspaceId: 1,
        tasks: [],
      });
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);

      // No dot while expanded — each workspace already shows its own.
      expect(container.querySelector(".ws-section-header .workspace-attn-dot")).toBeNull();

      await user.click(container.querySelector(".ws-section-header")!);

      expect(container.querySelector(".ws-section-header .workspace-attn-dot")).not.toBeNull();
    });

    it("shows an aggregate working dot (not attention) when a session is working but none need input", async () => {
      resetStore({
        workspaces: [makeWorkspace()],
        groups: [],
        sessions: [makeSession({ activity: "working" })],
        activeWorkspaceId: 1,
        tasks: [],
      });
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);
      await user.click(container.querySelector(".ws-section-header")!);

      expect(container.querySelector(".ws-section-header .workspace-working-dot")).not.toBeNull();
      expect(container.querySelector(".ws-section-header .workspace-attn-dot")).toBeNull();
    });

    it("shows no aggregate dot when collapsed and no session needs a look", async () => {
      const user = userEvent.setup();
      const { container } = render(<WorkspaceSwitcher />);
      await user.click(container.querySelector(".ws-section-header")!);

      expect(container.querySelector(".ws-section-header .workspace-attn-dot")).toBeNull();
      expect(container.querySelector(".ws-section-header .workspace-working-dot")).toBeNull();
    });
  });
});

// Audit finding 12 — the workspace and group deletes were `void`ed, so a
// rejected request became an unhandled promise rejection: the delete
// silently did nothing and the user was told nothing at all.
describe("failed workspace/group delete (audit finding 12)", () => {
  // This describe sits at the top level, so it does NOT inherit the
  // inner describe's beforeEach — it needs its own store setup and its
  // own listGroups mock, or the component's mount effect reaches the real
  // fetch and rejects.
  beforeEach(() => {
    // The section's collapsed state lives in localStorage, and an earlier
    // test in this file deliberately leaves it collapsed — so clear it,
    // or the workspace rows (and their delete buttons) are not rendered.
    localStorage.clear();
    resetStore({
      workspaces: [makeWorkspace()],
      groups: [],
      sessions: [makeSession()],
      activeWorkspaceId: 1,
      tasks: [],
    });
    vi.spyOn(api, "listGroups").mockResolvedValue([]);
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([makeWorkspace()]);
  });

  it("reports a failed workspace delete", async () => {
    vi.spyOn(api, "deleteWorkspace").mockRejectedValue(new Error("the server said no"));
    const user = userEvent.setup();
    const { container } = render(<WorkspaceSwitcher />);

    const deleteBtn = container.querySelector("button[title='Delete workspace']") as HTMLElement;
    expect(deleteBtn).not.toBeNull();
    // The ConfirmButton arms on the first click and fires on the second.
    await user.click(deleteBtn);
    await user.click(deleteBtn);

    await waitFor(() => {
      const toasts = useDashboardStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].kind).toBe("error");
      expect(toasts[0].message).toContain("Could not delete the workspace.");
      expect(toasts[0].message).toContain("the server said no");
    });
  });

  it("reports a failed group delete", async () => {
    vi.spyOn(api, "listGroups").mockResolvedValue([makeGroup({ collapsed: false })]);
    vi.spyOn(api, "deleteGroup").mockRejectedValue(new Error("the server said no"));
    useDashboardStore.setState({
      groups: [makeGroup({ collapsed: false })],
      workspaces: [makeWorkspace({ groupId: 1 })],
    });
    const user = userEvent.setup();
    const { container } = render(<WorkspaceSwitcher />);

    const deleteBtn = container.querySelector(
      ".ws-group-actions button[title='Delete group']",
    ) as HTMLElement;
    expect(deleteBtn).not.toBeNull();
    await user.click(deleteBtn);
    await user.click(deleteBtn);

    await waitFor(() => {
      const toasts = useDashboardStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].kind).toBe("error");
      expect(toasts[0].message).toContain("Could not delete the group.");
    });
  });

  it("reports nothing when the delete succeeds", async () => {
    vi.spyOn(api, "deleteWorkspace").mockResolvedValue(undefined);
    vi.spyOn(api, "listWorkspaces").mockResolvedValue([]);
    const user = userEvent.setup();
    const { container } = render(<WorkspaceSwitcher />);

    const deleteBtn = container.querySelector("button[title='Delete workspace']") as HTMLElement;
    await user.click(deleteBtn);
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(api.deleteWorkspace).toHaveBeenCalled();
    });
    expect(useDashboardStore.getState().toasts).toHaveLength(0);
  });
});

// #3224 — the switcher drags with the pointer drag hook
// (hooks/usePointerReorder.ts), the same as the rail's workspace picker.
describe("WorkspaceSwitcher drag to reorder", () => {
  // Group A (id 1) holds a1, a2; group B (id 2) holds b1; u1 is in no group.
  // jsdom has no layout, so each test lays the list out with `layout`: the
  // section body spans 0-400, a group's zone covers its header and rows.
  const seed = ({
    bCollapsed = false,
    ungrouped = true,
  }: { bCollapsed?: boolean; ungrouped?: boolean } = {}) => {
    localStorage.clear();
    const workspaces = [
      makeWorkspace({ id: 1, name: "a1", groupId: 1, position: 0 }),
      makeWorkspace({ id: 2, name: "a2", groupId: 1, position: 1 }),
      makeWorkspace({ id: 3, name: "b1", groupId: 2, position: 0 }),
      ...(ungrouped ? [makeWorkspace({ id: 4, name: "u1", groupId: null, position: 0 })] : []),
    ];
    resetStore({
      workspaces,
      groups: [
        makeGroup({ id: 1, name: "A" }),
        makeGroup({ id: 2, name: "B", collapsed: bCollapsed }),
      ],
      sessions: [makeSession()],
      activeWorkspaceId: 1,
      tasks: [],
    });
  };

  const layout = (
    zones: Record<string, [number, number]>,
    rows: Record<string, [number, number]>,
  ) =>
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const box =
        this.id === "workspaces-section-body"
          ? [0, 400]
          : this.dataset.dropZone !== undefined
            ? zones[this.dataset.dropZone]
            : this.dataset.dragId !== undefined
              ? rows[this.dataset.dragId]
              : undefined;
      const [top, bottom] = box ?? [0, 0];
      return { top, bottom, left: 0, right: 200, width: 200, height: bottom - top } as DOMRect;
    });

  // Group A's header 40-70, a1 70-100, a2 100-130; group B's header
  // 130-160, b1 160-190; u1 190-220.
  const expanded = () =>
    layout(
      { "1": [40, 130], "2": [130, 190], none: [190, 220] },
      { "1": [70, 100], "2": [100, 130], "3": [160, 190], "4": [190, 220] },
    );

  const handle = (container: HTMLElement, id: number) =>
    container.querySelector(`[data-drag-id="${id}"] .ws-drag-handle`) as HTMLElement;
  const down = (el: HTMLElement, clientY: number) =>
    fireEvent.pointerDown(el, { pointerId: 1, isPrimary: true, button: 0, clientY, clientX: 50 });
  const move = (el: HTMLElement, clientY: number, clientX = 50) =>
    fireEvent.pointerMove(el, { pointerId: 1, clientY, clientX });
  const up = (el: HTMLElement, clientY: number) =>
    fireEvent.pointerUp(el, { pointerId: 1, clientY, clientX: 50 });

  beforeEach(() => vi.mocked(moveWorkspace).mockClear());
  afterEach(() => vi.restoreAllMocks());

  it("marks the groups, the ungrouped list and the rows for the drag, and only the handle drags", () => {
    seed();
    const { container } = render(<WorkspaceSwitcher />);
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-drop-zone]")].map(
        (z) => z.dataset.dropZone,
      ),
    ).toEqual(["1", "2", "none"]);
    // Zones do not nest: the group's own list is inside its group's zone.
    expect(container.querySelector(".ws-group .ws-drop-list")).not.toHaveAttribute(
      "data-drop-zone",
    );
    expect(container.querySelectorAll("[data-drag-id]")).toHaveLength(4);
    // No native drag left.
    expect(container.querySelector("[draggable]")).toBeNull();
  });

  it("reorders within a group, with the drop line where it lands", () => {
    seed();
    const { container } = render(<WorkspaceSwitcher />);
    expanded();
    const a1 = handle(container, 1);
    down(a1, 85);
    move(a1, 120);
    // Below a2's middle (115): after it.
    expect(container.querySelector('[data-drag-id="1"]')).toHaveClass("ws-dragging");
    expect(container.querySelector('[data-drag-id="2"]')).toHaveClass("ws-sibling-dim");
    const group = container.querySelector('[data-drop-zone="1"]')!;
    expect(group.querySelectorAll(".ws-drop-indicator")).toHaveLength(1);
    // After a2: the list's last child.
    expect(group.querySelector(".ws-drop-list")!.lastElementChild).toHaveClass("ws-drop-indicator");
    up(a1, 120);
    expect(moveWorkspace).toHaveBeenCalledWith(expect.any(Array), 1, 1, 1);
    expect(container.querySelector(".ws-dragging")).toBeNull();
    expect(container.querySelector(".ws-drop-indicator")).toBeNull();
  });

  it("moves a workspace into another group, and onto an expanded group's header at its top", () => {
    seed();
    const { container } = render(<WorkspaceSwitcher />);
    expanded();
    const a1 = handle(container, 1);
    down(a1, 85);
    move(a1, 180);
    up(a1, 180);
    expect(moveWorkspace).toHaveBeenLastCalledWith(expect.any(Array), 1, 2, 1);
    const u1 = handle(container, 4);
    down(u1, 205);
    move(u1, 140);
    // On B's header: first in B, the line above b1.
    const b = container.querySelector('[data-drop-zone="2"]')!;
    expect(b.querySelector('.ws-drop-indicator + [data-drag-id="3"]')).not.toBeNull();
    up(u1, 140);
    expect(moveWorkspace).toHaveBeenLastCalledWith(expect.any(Array), 4, 2, 0);
  });

  it("takes a workspace out of all groups, an empty ungrouped list offering a box to drop on", () => {
    seed({ ungrouped: false });
    const { container } = render(<WorkspaceSwitcher />);
    expect(container.textContent).not.toContain("Drop here to ungroup");
    layout(
      { "1": [40, 130], "2": [130, 190], none: [190, 222] },
      { "1": [70, 100], "2": [100, 130], "3": [160, 190] },
    );
    const b1 = handle(container, 3);
    down(b1, 175);
    move(b1, 200);
    const none = container.querySelector('[data-drop-zone="none"]')!;
    expect(none).toHaveTextContent("Drop here to ungroup");
    up(b1, 200);
    expect(moveWorkspace).toHaveBeenCalledWith(expect.any(Array), 3, null, 0);
    expect(container.textContent).not.toContain("Drop here to ungroup");
  });

  it("drops onto a collapsed group's header, which lights up", () => {
    seed({ bCollapsed: true });
    const { container } = render(<WorkspaceSwitcher />);
    // B is collapsed: its zone is its header alone.
    layout(
      { "1": [40, 130], "2": [130, 160], none: [160, 190] },
      { "1": [70, 100], "2": [100, 130], "4": [160, 190] },
    );
    expect(container.querySelector('[data-drag-id="3"]')).toBeNull();
    const a1 = handle(container, 1);
    down(a1, 85);
    move(a1, 145);
    const header = container.querySelector('[data-drop-zone="2"] .ws-group-header')!;
    expect(header).toHaveClass("ws-group-drop-target");
    expect(header).toHaveTextContent("drop here");
    up(a1, 145);
    expect(moveWorkspace).toHaveBeenCalledWith(expect.any(Array), 1, 2, 0);
    expect(header).not.toHaveClass("ws-group-drop-target");
  });

  it("puts the row back on Escape, a pointer cancel, a release away from the list, or a drop in place", () => {
    seed();
    const { container } = render(<WorkspaceSwitcher />);
    expanded();
    const a1 = handle(container, 1);

    down(a1, 85);
    move(a1, 180);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".ws-dragging")).toBeNull();
    up(a1, 180);

    down(a1, 85);
    move(a1, 180);
    fireEvent.pointerCancel(a1, { pointerId: 1 });
    expect(container.querySelector(".ws-dragging")).toBeNull();

    // Over the sidebar's other sections, away from the switcher's own box.
    down(a1, 85);
    move(a1, 180);
    move(a1, 900);
    expect(container.querySelector(".ws-drop-indicator")).toBeNull();
    up(a1, 900);

    // Back where it started: nothing to save.
    down(a1, 85);
    move(a1, 80);
    up(a1, 80);

    expect(moveWorkspace).not.toHaveBeenCalled();
  });
});
