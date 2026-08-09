// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import * as panelUtils from "./panelUtils.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { useDashboardStore } from "./store.js";
import { api } from "./api.js";
import type { Workspace, Session, Task } from "./api.js";

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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 7,
    projectId: 1,
    parentSessionId: null,
    name: "claude code",
    nameLocked: true,
    command: "claude code",
    cwd: null,
    liveCwd: null,
    previewBranch: null,
    kind: "terminal",
    status: "active",
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
    useDashboardStore.setState({
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
});
