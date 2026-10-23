import { describe, expect, it } from "vitest";
import { mergeReadiness } from "../../scripts/merge-pr.mjs";

// The readiness decision is the whole point of the script: the race it
// exists for is reading a PR's state too early and acting on it.
describe("mergeReadiness", () => {
  const green = (name: string) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" });

  it("waits when the rollup is EMPTY — the race this script exists for", () => {
    // Right after a force-push, the new head's checks have not registered
    // yet and the rollup comes back empty. "0 pending" is not "ready":
    // treating it as ready is what produces "Pull Request is not mergeable
    // (mergePullRequest)".
    const readiness = mergeReadiness({
      statusCheckRollup: [],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("wait");
    expect(readiness.reason).toMatch(/no status checks/i);
  });

  it("waits when GitHub has not finished computing mergeability", () => {
    const readiness = mergeReadiness({
      statusCheckRollup: [green("ci")],
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
    expect(readiness.action).toBe("wait");
  });

  it("waits while a check is still running", () => {
    const readiness = mergeReadiness({
      statusCheckRollup: [green("ci"), { name: "e2e", status: "IN_PROGRESS", conclusion: null }],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("wait");
    expect(readiness.reason).toContain("e2e");
  });

  it("stops when a check FAILED, rather than waiting for a green that will not come", () => {
    const readiness = mergeReadiness({
      statusCheckRollup: [
        green("ci"),
        { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
      ],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("stop");
    expect(readiness.reason).toContain("lint");
  });

  it("asks for a rebase when the head does not contain the base", () => {
    // This repo's required status checks are `strict: true`, so a behind
    // head is refused even with every check green.
    const readiness = mergeReadiness({
      statusCheckRollup: [green("ci")],
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    });
    expect(readiness.action).toBe("rebase");
  });

  it("stops on a conflict", () => {
    const readiness = mergeReadiness({
      statusCheckRollup: [green("ci")],
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
    expect(readiness.action).toBe("stop");
  });

  it("merges when the checks are green and the head contains the base", () => {
    const readiness = mergeReadiness({
      statusCheckRollup: [
        green("ci"),
        { name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
      ],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("merge");
  });

  it("treats a missing rollup as empty rather than crashing", () => {
    // `gh pr view --json statusCheckRollup` omits the field on some
    // responses rather than returning [].
    const readiness = mergeReadiness({
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("wait");
  });
});
