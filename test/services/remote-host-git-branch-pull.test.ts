import { describe, expect, it, vi } from "vitest";
import { resolveGitBranchPull, type GitRequest } from "../../src/services/remote-host-git.js";

// Issue #3068 — the primary's side of the per-branch Pull on a remote host:
// what it sends to the agent's /internal/git-branch-pull.
describe("resolveGitBranchPull", () => {
  it("posts the branch and the checkout the primary guarded", async () => {
    const result = { ok: false, reason: "dirty-tree" };
    const request = vi.fn().mockResolvedValue(result);
    await expect(
      resolveGitBranchPull(request as unknown as GitRequest, "/x/y", "feature", "/x/y/.wt/f"),
    ).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith(
      "/internal/git-branch-pull",
      {
        method: "POST",
        body: JSON.stringify({ cwd: "/x/y", branch: "feature", expectedWorktree: "/x/y/.wt/f" }),
      },
      expect.any(Number),
    );
  });
});
