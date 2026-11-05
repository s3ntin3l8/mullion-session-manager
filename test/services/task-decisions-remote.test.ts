import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBaseRef = vi.fn();
const mockLog = vi.fn();
const mockCommit = vi.fn();
vi.mock("../../src/services/host-git.js", () => ({
  resolveHostBaseRef: mockBaseRef,
  resolveHostGitLog: mockLog,
  resolveHostGitCommit: mockCommit,
}));

const { collectDeclaredDecisions } = await import("../../src/services/task-decisions.js");

const app = { log: { warn: vi.fn() } } as never;
const task = { worktreePath: "/wt" };
const project = { cwd: "/repo" };
const detail = (message: string) => ({ ok: true, value: { forbidden: false, value: { message } } });

describe("collectDeclaredDecisions on a remote host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBaseRef.mockResolvedValue({ ok: true, value: { baseRef: "origin/main", sha: "base" } });
  });

  it("reads only the commits ahead of the base commit", async () => {
    mockLog.mockResolvedValue({
      ok: true,
      value: {
        forbidden: false,
        value: [{ sha: "c2" }, { sha: "c1" }, { sha: "base" }, { sha: "old" }],
      },
    });
    mockCommit.mockImplementation((_a, _h, _c, sha: string) =>
      Promise.resolve(detail(`s\n\nDecision: from ${sha}`)),
    );
    expect(await collectDeclaredDecisions(app, task, project, "remote-1")).toEqual([
      "Decision: from c2",
      "Decision: from c1",
    ]);
    expect(mockCommit).toHaveBeenCalledTimes(2);
  });

  it("returns [] for an unreadable host, a forbidden worktree or no worktree", async () => {
    mockLog.mockResolvedValue({ ok: false, reason: "unreachable", detail: "x" });
    expect(await collectDeclaredDecisions(app, task, project, "remote-1")).toEqual([]);
    mockLog.mockResolvedValue({ ok: true, value: { forbidden: true } });
    expect(await collectDeclaredDecisions(app, task, project, "remote-1")).toEqual([]);
    expect(
      await collectDeclaredDecisions(app, { worktreePath: null }, project, "remote-1"),
    ).toEqual([]);
    mockBaseRef.mockResolvedValue({ ok: false, reason: "unreachable", detail: "x" });
    expect(await collectDeclaredDecisions(app, task, project, "remote-1")).toEqual([]);
  });

  it("never throws: a failing read is a missing section", async () => {
    mockLog.mockRejectedValue(new Error("boom"));
    expect(await collectDeclaredDecisions(app, task, project, "remote-1")).toEqual([]);
  });
});
