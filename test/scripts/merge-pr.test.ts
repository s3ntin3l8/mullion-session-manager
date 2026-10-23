import { describe, expect, it } from "vitest";
import { mergeReadiness, parseArgs } from "../../scripts/merge-pr.mjs";

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

describe("parseArgs", () => {
  it("does not read a flag's value as the PR number", () => {
    // The bug this exists for: `--timeout 600` picked the 600 as the PR
    // number, so the script waited on — and squash-merged — PR #600.
    expect(parseArgs(["--timeout", "600"]).prNumber).toBeUndefined();
    expect(parseArgs(["--timeout", "600"]).timeoutMs).toBe(600_000);
    expect(parseArgs(["123", "--timeout", "600"]).prNumber).toBe("123");
    expect(parseArgs(["--timeout", "600", "123"]).prNumber).toBe("123");
  });

  it("rejects a timeout that is missing or not a positive number", () => {
    // NaN would make `Date.now() >= deadline` never true, so the wait would
    // never time out.
    expect(() => parseArgs(["--timeout"])).toThrow(/positive number/i);
    expect(() => parseArgs(["--timeout", "soon"])).toThrow(/positive number/i);
    expect(() => parseArgs(["--timeout", "0"])).toThrow(/positive number/i);
    expect(() => parseArgs(["--timeout", "-5"])).toThrow(/positive number/i);
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/i);
  });

  it("defaults the timeout to 30 minutes and allows the rebase", () => {
    expect(parseArgs([]).timeoutMs).toBe(30 * 60_000);
    expect(parseArgs([]).allowRebase).toBe(true);
    expect(parseArgs(["--no-rebase"]).allowRebase).toBe(false);
  });
});

describe("mergeReadiness — legacy commit statuses", () => {
  it("reads a StatusContext entry by its `state`, not `status`", () => {
    // A legacy commit status carries `state`, no `status` and no
    // `conclusion`. Read as a StatusCheck it would look like a check that
    // never completes — so the script would wait out the whole timeout on
    // a PR whose checks had all finished.
    const readiness = mergeReadiness({
      statusCheckRollup: [
        { __typename: "StatusContext", name: "legacy", state: "SUCCESS" },
        { __typename: "StatusCheck", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("merge");
  });

  it("reports a FAILED legacy status as a failure", () => {
    const readiness = mergeReadiness({
      statusCheckRollup: [{ __typename: "StatusContext", name: "legacy", state: "FAILURE" }],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("stop");
    expect(readiness.reason).toContain("legacy");
  });
});
