import { describe, it, expect, vi, beforeEach } from "vitest";

// The remote half of the gate (a task whose worktree is on another host) —
// separate from task-workflow-gate.test.ts, which drives a real local repo,
// because this one needs getRemoteHostClient mocked.
const mockResolveGitDiffStats = vi.fn();
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: () => ({ resolveGitDiffStats: mockResolveGitDiffStats }),
}));
vi.mock("../../src/services/host-git.js", () => ({
  resolveHostGitLog: vi
    .fn()
    .mockResolvedValue({ ok: true, value: { value: [{ sha: "a".repeat(40) }] } }),
}));

const { evaluateWorkflowGate } = await import("../../src/services/task-workflow-gate.js");

const task = { id: 1, worktreePath: "/remote/wt", workflowApprovedSha: null } as never;

describe("evaluateWorkflowGate on a remote host", () => {
  beforeEach(() => {
    mockResolveGitDiffStats.mockReset();
  });

  it("is unverified when the host could not resolve a default base ref", async () => {
    // The host fell back to `git diff HEAD`, whose empty result must not read as clear.
    mockResolveGitDiffStats.mockResolvedValue({
      isRepo: true,
      stats: { workflowFiles: [] },
      baseResolved: false,
    });
    const gate = await evaluateWorkflowGate({} as never, task, "remote-1");
    expect(gate.kind).toBe("unverified");
    expect((gate as { detail: string }).detail).toContain("origin/main");
  });

  it("reads a host agent that predates baseResolved as unknown, never clear", async () => {
    // An old agent omits the key; its unresolved AUTO diffs `HEAD` and reports [].
    mockResolveGitDiffStats.mockResolvedValue({ isRepo: true, stats: { workflowFiles: [] } });
    const gate = await evaluateWorkflowGate({} as never, task, "remote-1");
    expect(gate.kind).toBe("unverified");
    expect((gate as { detail: string }).detail).toContain("update the host agent");
  });

  it("still holds an agent's non-empty workflow list when the flag is missing", async () => {
    mockResolveGitDiffStats.mockResolvedValue({
      isRepo: true,
      stats: { workflowFiles: [".github/workflows/ci.yml"] },
    });
    expect(await evaluateWorkflowGate({} as never, task, "remote-1")).toMatchObject({
      kind: "held",
      change: { files: [".github/workflows/ci.yml"] },
    });
  });

  it("is clear when the base resolved and no workflow file changed", async () => {
    mockResolveGitDiffStats.mockResolvedValue({
      isRepo: true,
      stats: { workflowFiles: [] },
      baseResolved: true,
    });
    expect(await evaluateWorkflowGate({} as never, task, "remote-1")).toEqual({ kind: "clear" });
  });

  it("is held when the base resolved and a workflow file changed", async () => {
    mockResolveGitDiffStats.mockResolvedValue({
      isRepo: true,
      stats: { workflowFiles: [".github/workflows/ci.yml"] },
      baseResolved: true,
    });
    expect(await evaluateWorkflowGate({} as never, task, "remote-1")).toEqual({
      kind: "held",
      change: { sha: "a".repeat(40), files: [".github/workflows/ci.yml"] },
    });
  });

  it("is unverified with the host-specific detail when the host cannot answer", async () => {
    mockResolveGitDiffStats.mockRejectedValue(new Error("unreachable"));
    const gate = await evaluateWorkflowGate({} as never, task, "remote-1");
    expect((gate as { detail: string }).detail).toContain("update the host agent");
  });
});
