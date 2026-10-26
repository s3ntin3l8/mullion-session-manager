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
});
