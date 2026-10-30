// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStartSessionFrom } from "./useStartSessionFrom.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";

describe("useStartSessionFrom", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = (launchers: unknown[]) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, launchers)));
    const createSession = vi.fn().mockResolvedValue({ id: 9 });
    const requestOpenSession = vi.fn();
    useDashboardStore.setState({ createSession, requestOpenSession });
    return { createSession, requestOpenSession };
  };

  it("reuses an existing branch as-is and opens the new session", async () => {
    const { createSession, requestOpenSession } = setup([
      { id: "agent:claude", command: "claude" },
    ]);
    const { result } = renderHook(() => useStartSessionFrom(1));
    await result.current({ worktree: { branch: "feat-x" }, seedPrompt: "go" });
    expect(createSession).toHaveBeenCalledWith(1, "claude", {
      worktree: { branch: "feat-x" },
      seedPrompt: "go",
    });
    expect(requestOpenSession).toHaveBeenCalledWith(9);
  });

  it("cuts a new branch from the default branch", async () => {
    const { createSession } = setup([{ id: "agent:claude", command: "claude" }]);
    useDashboardStore.setState({
      gitBranchesByProject: { 1: { defaultBranch: "origin/trunk" } } as never,
    });
    const { result } = renderHook(() => useStartSessionFrom(1));
    await result.current({ worktree: { branchName: "issue-1-x" }, seedPrompt: "go" });
    expect(createSession.mock.calls[0][2].worktree).toEqual({
      baseRef: "origin/trunk",
      branchName: "issue-1-x",
    });
  });

  it("rejects when the project has no launcher", async () => {
    const { createSession } = setup([]);
    const { result } = renderHook(() => useStartSessionFrom(1));
    await expect(result.current({ worktree: { branch: "b" }, seedPrompt: "p" })).rejects.toThrow(
      /No launcher/,
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("passes skipPermissions for an agent the settings list", async () => {
    const { createSession } = setup([{ id: "agent:claude", kind: "agent", command: "claude" }]);
    // A Response body can only be read once; hand out a fresh one per call.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse(200, [{ id: "agent:claude", kind: "agent", command: "claude" }]),
        ),
    );
    useDashboardStore.setState({
      settings: {
        ...useDashboardStore.getState().settings,
        launchers: {
          ...useDashboardStore.getState().settings.launchers,
          defaultAgent: "claude",
          skipPermissionsAgents: ["claude"],
        },
      },
    });
    const { result } = renderHook(() => useStartSessionFrom(1));
    await result.current({ worktree: { branch: "b" }, seedPrompt: "p" });
    expect(createSession.mock.calls[0][2].skipPermissions).toBe(true);
    useDashboardStore.setState({
      settings: {
        ...useDashboardStore.getState().settings,
        launchers: {
          ...useDashboardStore.getState().settings.launchers,
          skipPermissionsAgents: [],
        },
      },
    });
    await result.current({ worktree: { branch: "b" }, seedPrompt: "p" });
    expect(createSession.mock.calls[1][2].skipPermissions).toBe(false);
  });
});
