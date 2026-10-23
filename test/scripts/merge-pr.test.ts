import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { GIT_ENV_KEYS_TO_STRIP } from "../../src/services/git-env.js";
import {
  cli,
  mergeReadiness,
  parseArgs,
  rebaseAndPush,
  waitForReady,
} from "../../scripts/merge-pr.mjs";

// The spawns are mocked so the script's COMMAND SHAPE can be asserted —
// which is where the CI-breaking guard violation lived (a git spawn
// without env: gitEnv(), which test/git-env-guard.test.ts enforces for
// every git spawn under src/, test/ and scripts/).
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const execFileSyncMock = vi.mocked(execFileSync);

const greenPr = {
  statusCheckRollup: [
    { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
};

// The readiness decision is the whole point of the script: the race it
// exists for is reading a PR's state too early and acting on it.
describe("mergeReadiness", () => {
  const green = (name: string) => ({
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
  });

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
      statusCheckRollup: [
        green("ci"),
        { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
      ],
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
        { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
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

describe("mergeReadiness — the typenames GitHub actually emits", () => {
  it("waits for a QUEUED CheckRun", () => {
    // The regression this pins: a `__typename` guess that is not in
    // GitHub's union ("StatusCheck" — there is no such type; every Actions
    // check is a "CheckRun") made every real check fall through to the
    // FAILED branch, so the script reported a bogus failure while the
    // checks were still queued. Measured on a real PR: 14/14 entries are
    // CheckRun.
    const readiness = mergeReadiness({
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test-node / lint-and-test",
          status: "QUEUED",
          conclusion: null,
        },
        { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("wait");
    expect(readiness.reason).toContain("test-node / lint-and-test");
  });

  it("waits for a PENDING legacy status rather than merging past it", () => {
    // A legacy status in flight is PENDING, and PENDING is "wait" — it is
    // not a failure, and it is not a pass either.
    const readiness = mergeReadiness({
      statusCheckRollup: [{ __typename: "StatusContext", context: "legacy", state: "PENDING" }],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("wait");
  });

  it("names a failed legacy status by its `context`", () => {
    // A real StatusContext carries `context`, not `name` — so the report
    // must not say "undefined (FAILURE)".
    const readiness = mergeReadiness({
      statusCheckRollup: [
        { __typename: "StatusContext", context: "legacy-context", state: "FAILURE" },
      ],
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    expect(readiness.action).toBe("stop");
    expect(readiness.reason).toContain("legacy-context");
    expect(readiness.reason).not.toContain("undefined");
  });
});

describe("parseArgs — extra positionals and the = form", () => {
  it("refuses more than one PR number rather than ignoring the extra", () => {
    expect(() => parseArgs(["100", "200"])).toThrow(/at most one PR number/i);
  });

  it("accepts --timeout=600", () => {
    expect(parseArgs(["--timeout=600"]).timeoutMs).toBe(600_000);
    expect(parseArgs(["--timeout=600"]).prNumber).toBeUndefined();
  });
});

describe("rebaseAndPush", () => {
  it("scrubs the git env on every git spawn, and names the branch on both the rebase and the push", () => {
    // The guard that CI enforces (test/git-env-guard.test.ts, issue #1602,
    // extended to scripts/ by #1649): a GIT_DIR leaked from an outer hook
    // retargets git at a DIFFERENT checkout — the worst possible failure
    // for a script whose job is to force-push a rebase.
    execFileSyncMock.mockReset();
    rebaseAndPush("feat/x");

    const gitCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === "git");
    expect(gitCalls.map((c) => c[1])).toEqual([
      ["fetch", "origin"],
      ["rebase", "origin/main", "feat/x"],
      ["push", "--force-with-lease", "origin", "feat/x"],
    ]);
    for (const call of gitCalls) {
      const opts = call[2] as { env?: Record<string, string> };
      expect(opts?.env).toBeTruthy();
      for (const key of GIT_ENV_KEYS_TO_STRIP) {
        expect(opts?.env?.[key]).toBeUndefined();
      }
    }
  });
});

describe("waitForReady", () => {
  it("gives up when the deadline passes instead of polling forever", () => {
    execFileSyncMock.mockReset();
    // An empty rollup reads as "wait" — the state right after a force-push.
    execFileSyncMock.mockReturnValue(JSON.stringify({ ...greenPr, statusCheckRollup: [] }));
    const res = waitForReady("1", { timeoutMs: 0 });
    expect(res.readiness.action).toBe("stop");
    expect(res.readiness.reason).toMatch(/timed out/i);
  });

  it("returns as soon as the PR is ready", () => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify(greenPr));
    const res = waitForReady("1", { timeoutMs: 1000 });
    expect(res.readiness.action).toBe("merge");
  });
});

describe("cli", () => {
  it("squash-merges the named PR once it is ready", () => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(JSON.stringify(greenPr));
    expect(cli(["123"])).toBe(0);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "123", "--squash"],
      expect.anything(),
    );
  });

  it("reports a PR that is not ready instead of merging it", () => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(
      JSON.stringify({ ...greenPr, statusCheckRollup: [], mergeable: "MERGEABLE" }),
    );
    expect(cli(["123", "--timeout", "1"])).toBe(1);
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", "123", "--squash"],
      expect.anything(),
    );
  });
});

describe("mergeReadiness — a head whose checks have not reported yet", () => {
  it("waits on BLOCKED rather than stopping", () => {
    // Right after a push the rollup can still hold the PREVIOUS head's green
    // checks while the new ones register, and GitHub calls the state
    // BLOCKED throughout. Stopping there refused a merge that was merely
    // early — the failure this script exists to prevent.
    const readiness = mergeReadiness({
      statusCheckRollup: [
        { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
    });
    expect(readiness.action).toBe("wait");
  });

  it("still stops on a DRAFT", () => {
    const readiness = mergeReadiness({
      statusCheckRollup: [
        { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      mergeable: "MERGEABLE",
      mergeStateStatus: "DRAFT",
    });
    expect(readiness.action).toBe("stop");
  });
});
