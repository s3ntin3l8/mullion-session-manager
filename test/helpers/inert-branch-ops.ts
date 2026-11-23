import { vi } from "vitest";

/** The guarded branch operations of a fake SessionBackend (#1672, #3068),
 * for tests that never exercise them: each refuses as `not-a-repo`. */
export function inertBranchOps() {
  const refuse = () => vi.fn().mockResolvedValue({ ok: false, reason: "not-a-repo" });
  return {
    checkoutBranch: refuse(),
    createBranch: refuse(),
    rebaseBranch: refuse(),
    pullBranch: refuse(),
  };
}
