// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitPanel } from "./GitPanel.js";
import type { GitBranchesResult, GitStatus } from "./api/index.js";
import { LIVE_REFRESH_INTERVAL_MS, useDashboardStore } from "./store/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

const CLEAN_STATUS: GitStatus = {
  branch: "main",
  hash: "abc1234",
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  hasConflicts: false,
};

// Routes a mocked fetch by URL — GitPanel now fires two independent requests
// (git-status and, separately, git-branches for issue #162's branch/worktree
// list), so a single undifferentiated mock can no longer stand in for both.
// Defaults each endpoint to a 204 ("not applicable") unless a test overrides
// it, matching what an unrelated endpoint would actually do for a project
// these tests don't care about.
function mockFetch(opts: {
  status?: () => Response | Promise<Response>;
  branches?: () => Response | Promise<Response>;
  pull?: () => Response | Promise<Response>;
  fetch?: () => Response | Promise<Response>;
  health?: () => Response | Promise<Response>;
  // Issue #1896 — the repair endpoint answers differently with and without
  // `confirm`, so the mock is handed the parsed body.
  repair?: (body: { confirm?: boolean }) => Response | Promise<Response>;
  fileDiff?: (url: string) => Response | Promise<Response>;
  log?: () => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/git-repair")) {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { confirm?: boolean })
        : ({} as { confirm?: boolean });
      return Promise.resolve(
        opts.repair
          ? opts.repair(body)
          : jsonResponse(200, {
              gitDir: "/tmp/x/.git",
              quarantine: [],
              willFetch: false,
              indexesToRebuild: ["/tmp/x"],
              indexesToSkip: [],
              actionable: false,
            }),
      );
    }
    if (url.includes("/git-health")) {
      return Promise.resolve(
        opts.health
          ? opts.health()
          : jsonResponse(200, {
              healthy: true,
              zeroByteObjects: [],
              otherZeroByteFiles: [],
              fsckErrors: [],
              gitDir: "/tmp/x/.git",
              timedOut: false,
            }),
      );
    }
    if (url.includes("/git-pull")) {
      return Promise.resolve(opts.pull ? opts.pull() : jsonResponse(200, { pulled: true }));
    }
    if (url.includes("/git-fetch")) {
      return Promise.resolve(opts.fetch ? opts.fetch() : jsonResponse(200, { success: true }));
    }
    if (url.includes("/git-file-diff")) {
      return Promise.resolve(
        opts.fileDiff
          ? opts.fileDiff(url)
          : jsonResponse(200, { patch: "@@ -1 +1 @@\n-old\n+new" }),
      );
    }
    if (url.includes("/git-log")) {
      return Promise.resolve(
        opts.log ? opts.log() : jsonResponse(200, { commits: [], hasMore: false }),
      );
    }
    if (url.includes("/git-status")) {
      return Promise.resolve(opts.status ? opts.status() : new Response(null, { status: 204 }));
    }
    if (url.includes("/git-branches")) {
      return Promise.resolve(opts.branches ? opts.branches() : new Response(null, { status: 204 }));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
  });
}

describe("GitPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the branch, hash, and a clean-tree message once loaded", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: () => jsonResponse(200, CLEAN_STATUS) }));
    render(<GitPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
    expect(screen.getByText("Working tree clean")).toBeInTheDocument();
    expect(screen.getByText("Clean")).toBeInTheDocument();
  });

  it("shows a not-applicable message on a 204 response, without listing anything", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<GitPanel params={{ projectId: 2 }} />);

    expect(await screen.findByText(/Not a git repository/)).toBeInTheDocument();
  });

  // Audit finding 28 — a failed FIRST fetch used to leave `status` at
  // `undefined`, which the panel rendered as "Loading…" FOREVER: the user
  // was told it was still loading when it had in fact failed, and nothing
  // in the panel ever named the failure.
  it("shows a named error with a Retry instead of 'Loading…' when the first fetch fails", async () => {
    // A raw network error (or a thrown ApiError for a 503 "git status
    // temporarily unavailable" response) with no prior successful fetch to
    // fall back to — there is no status to show, so the panel must say it
    // could not load one, never assert a wrong "not a git repository"
    // state it can't actually confirm.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git-status")) {
        return Promise.reject(new Error("network down"));
      }
      if (url.includes("/git-branches")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<GitPanel params={{ projectId: 3 }} />);

    expect(await screen.findByText(/Could not load git status/)).toBeInTheDocument();
    // The failure is named in TEXT — the error is never signalled by
    // colour alone.
    expect(screen.getByText(/network down/)).toBeInTheDocument();
    // ... and the panel no longer claims to still be loading.
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText(/Not a git repository/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  // Audit finding 28 — the failure state has to be RECOVERABLE, not just
  // visible: the Retry re-runs the same fetch, and a successful retry
  // lands the panel in its normal loaded state with the error gone.
  it("Retry re-fetches the status; a successful retry shows the data and clears the error", async () => {
    let statusCallCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/git-status")) {
        statusCallCount += 1;
        // Only the mount-time fetch fails; the Retry's own request (and
        // any later poll tick) succeeds.
        return statusCallCount === 1
          ? Promise.reject(new Error("network down"))
          : Promise.resolve(jsonResponse(200, CLEAN_STATUS));
      }
      if (url.includes("/git-branches")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes("/git-log")) {
        return Promise.resolve(jsonResponse(200, { commits: [], hasMore: false }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<GitPanel params={{ projectId: 30 }} />);

    const retryButton = await screen.findByRole("button", { name: "Retry" });
    await user.click(retryButton);

    expect(await screen.findByText("main")).toBeInTheDocument();
    // The error is gone — the panel is no longer claiming it could not
    // load the status.
    expect(screen.queryByText(/Could not load git status/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    // The Retry really did re-run the request.
    expect(statusCallCount).toBeGreaterThan(1);
  });

  it("keeps showing the last-known-good status across a later transient poll failure", async () => {
    vi.useFakeTimers();
    try {
      // git-branches always 204s here — this test is only exercising the
      // git-status poll's LKG behavior. Tracked by call count (not
      // mockImplementationOnce) since the branches effect's own fetch can
      // interleave with the status poll's calls under fake timers.
      //
      // git-log has to be routed explicitly: the panel's own History
      // section fetches it once the status has loaded, and without this
      // branch that request fell through to the git-status arm below —
      // which made the History request the "second call" that failed,
      // while the poll tick's own call succeeded and the panel never
      // actually saw a failed refresh at all.
      let statusCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-branches")) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.includes("/git-log")) {
          return Promise.resolve(jsonResponse(200, { commits: [], hasMore: false }));
        }
        statusCallCount += 1;
        // The second git-status call (the next poll tick) fails transiently
        // (e.g. a 503) — the panel must keep rendering the branch/clean
        // status from the first, successful fetch instead of reverting to
        // "Not a git repository".
        if (statusCallCount === 2) {
          return Promise.reject(new Error("git status unavailable"));
        }
        return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<GitPanel params={{ projectId: 7 }} />);

      // Flush the mount-time fetch's promise chain and let React commit the
      // resulting state update — `act` is what makes the update actually
      // land in the DOM before we assert on it under fake timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("main")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_REFRESH_INTERVAL_MS);
      });

      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("Working tree clean")).toBeInTheDocument();
      expect(screen.queryByText(/Not a git repository/)).not.toBeInTheDocument();
      // Audit finding 28's second half — the last-known-good status is
      // still on screen, but it is no longer known to be current, and the
      // panel says so in text (not by colour alone).
      expect(screen.getByText(/out of date/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists changed files with their status code", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () =>
          jsonResponse(200, {
            ...CLEAN_STATUS,
            isClean: false,
            files: [
              { path: "src/a.ts", status: "M" },
              { path: "src/new.ts", status: "?" },
            ],
          }),
      }),
    );
    render(<GitPanel params={{ projectId: 4 }} />);

    expect(await screen.findByText("Changes (2)")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
  });

  describe("Edit action (open in the file editor)", () => {
    const withFiles = (files: Array<{ path: string; status: string }>) =>
      vi.stubGlobal(
        "fetch",
        mockFetch({
          status: () => jsonResponse(200, { ...CLEAN_STATUS, isClean: false, files }),
        }),
      );

    it("offers Edit for changed and untracked files, not deleted files or folders", async () => {
      withFiles([
        { path: "src/a.ts", status: "M" },
        { path: "src/new.ts", status: "?" },
        { path: "gone.ts", status: "D" },
        { path: "newdir/", status: "?" },
      ]);
      const onEditFile = vi.fn();
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 4 }} onEditFile={onEditFile} />);
      await screen.findByText("Changes (4)");
      expect(screen.getByLabelText("Edit src/new.ts")).toBeInTheDocument();
      expect(screen.queryByLabelText("Edit gone.ts")).toBeNull();
      expect(screen.queryByLabelText("Edit newdir/")).toBeNull();
      await user.click(screen.getByLabelText("Edit src/a.ts"));
      expect(onEditFile).toHaveBeenCalledWith("src/a.ts");
    });

    it("shows no Edit buttons without an onEditFile handler", async () => {
      withFiles([{ path: "src/a.ts", status: "M" }]);
      render(<GitPanel params={{ projectId: 4 }} />);
      await screen.findByText("Changes (1)");
      expect(screen.queryByLabelText("Edit src/a.ts")).toBeNull();
    });
  });

  // Issue #1851 — the READ-ONLY clone health check.
  it("reports a healthy repository when the check says so", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: () => jsonResponse(200, CLEAN_STATUS) }));
    render(<GitPanel params={{ projectId: 7 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));

    expect(await screen.findByText("This repository is healthy.")).toBeInTheDocument();
  });

  it("says what is wrong when the repository is damaged", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () =>
          jsonResponse(200, {
            healthy: false,
            gitDir: "/tmp/x/.git",
            zeroByteObjects: ["ab/cdef"],
            otherZeroByteFiles: [],
            fsckErrors: ["error: invalid sha1 pointer in cache-tree of .git/index"],
            timedOut: false,
          }),
      }),
    );
    render(<GitPanel params={{ projectId: 8 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));

    expect(await screen.findByText(/This repository looks damaged/)).toBeInTheDocument();
    expect(screen.getByText(/1 zero-byte object/)).toBeInTheDocument();
    expect(screen.getByText(/1 fsck error/)).toBeInTheDocument();
    // Real damage IS the danger style.
    expect(screen.getByText(/This repository looks damaged/).className).toContain(
      "github-panel-conflicts",
    );
  });

  // A project that is not a git repository at all has no clone to be
  // damaged — "looks damaged" would be the wrong story.
  it("says the project is not a git repository when there is no clone", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () =>
          jsonResponse(200, {
            healthy: false,
            gitDir: null,
            zeroByteObjects: [],
            otherZeroByteFiles: [],
            fsckErrors: [],
            timedOut: false,
          }),
      }),
    );
    render(<GitPanel params={{ projectId: 14 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));

    expect(await screen.findByText(/not a git repository/)).toBeInTheDocument();
    expect(screen.queryByText(/looks damaged/)).toBeNull();
    // Not a finding, so not the danger style either.
    expect(screen.getByText(/not a git repository/).className).not.toContain(
      "github-panel-conflicts",
    );
  });

  // A check that could not finish has no verdict. Saying "looks damaged"
  // would send the user to repair a clone that may well be fine.
  it("says the check did not finish when it timed out, rather than that the repository is damaged", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () =>
          jsonResponse(200, {
            healthy: false,
            gitDir: "/tmp/x/.git",
            zeroByteObjects: [],
            otherZeroByteFiles: [],
            fsckErrors: [],
            timedOut: true,
          }),
      }),
    );
    render(<GitPanel params={{ projectId: 12 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));

    expect(await screen.findByText(/did not finish/)).toBeInTheDocument();
    expect(screen.queryByText(/looks damaged/)).toBeNull();
  });

  // A pull refused because a repair holds the clone is not a failure — it
  // must not read as "Action failed."
  it("says a busy clone was busy, not that the action failed", async () => {
    const { reasonMessage } = await import("./git/gitReasons.js");
    expect(reasonMessage("busy", undefined)).toMatch(/already running/i);
    expect(reasonMessage("busy", undefined)).not.toMatch(/failed/i);
  });

  // A failed check must not leave its error on screen next to a later
  // successful one.
  // Issue #1896 — the clone REPAIR. The plan is on screen BEFORE the
  // confirmation, and the repair only runs on the second click.
  const DAMAGED_HEALTH = {
    healthy: false,
    gitDir: "/tmp/x/.git",
    zeroByteObjects: ["ab/cdef"],
    otherZeroByteFiles: [],
    fsckErrors: ["error: invalid sha1 pointer in cache-tree of .git/index"],
    timedOut: false,
  };
  const REPAIR_PLAN = {
    gitDir: "/tmp/x/.git",
    quarantine: ["abcdef"],
    willFetch: true,
    indexesToRebuild: ["/tmp/x"],
    indexesToSkip: [],
    actionable: true,
  };

  it("offers no repair when the clone is healthy", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: () => jsonResponse(200, CLEAN_STATUS) }));
    render(<GitPanel params={{ projectId: 15 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));

    expect(await screen.findByText("This repository is healthy.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /repair/i })).toBeNull();
  });

  it("shows the plan before the repair is confirmed", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () => jsonResponse(200, DAMAGED_HEALTH),
        repair: () => jsonResponse(200, REPAIR_PLAN),
      }),
    );
    render(<GitPanel params={{ projectId: 16 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));

    // The plan is on screen, and so is the button that will act on it.
    expect(await screen.findByText(/quarantine 1 damaged object\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/fetch from origin/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /repair/i })).toBeInTheDocument();
  });

  it("runs the repair only after the confirmation, and reports what it did", async () => {
    const bodies: { confirm?: boolean }[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () => jsonResponse(200, DAMAGED_HEALTH),
        repair: (body) => {
          bodies.push(body);
          return body.confirm
            ? jsonResponse(200, {
                ...DAMAGED_HEALTH,
                healthy: true,
                quarantine: "/tmp/x/.git/gc-quarantine-1",
                quarantined: ["abcdef"],
                recovered: [],
                unrecovered: [],
                refsRestored: true,
                indexesRebuilt: ["/tmp/x"],
                indexesSkipped: [],
                whole: true,
              })
            : jsonResponse(200, REPAIR_PLAN);
        },
      }),
    );
    render(<GitPanel params={{ projectId: 17 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));
    const repairButton = await screen.findByRole("button", { name: /repair/i });

    // The first click arms the button; nothing has run yet.
    await userEvent.click(repairButton);
    expect(bodies.filter((b) => b.confirm === true)).toHaveLength(0);

    // The second one confirms.
    await userEvent.click(repairButton);
    expect(await screen.findByText(/the clone is whole again/)).toBeInTheDocument();
    expect(bodies.filter((b) => b.confirm === true)).toHaveLength(1);
    expect(await screen.findByText(/1 damaged object\(s\) moved into/)).toBeInTheDocument();
    // The outcome REPLACES the damage banner: the panel must not go on
    // saying the repository looks damaged after it has been repaired.
    expect(screen.queryByText(/This repository looks damaged/)).toBeNull();
  });

  it("says so when the repair plan cannot be computed", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () =>
          jsonResponse(200, {
            healthy: false,
            gitDir: "/tmp/x/.git",
            zeroByteObjects: ["ab/cdef"],
            otherZeroByteFiles: [],
            fsckErrors: ["error: invalid sha1 pointer in cache-tree of .git/index"],
            timedOut: false,
          }),
        repair: () => jsonResponse(500, { message: "the plan could not be computed" }),
      }),
    );
    render(<GitPanel params={{ projectId: 18 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));

    expect(await screen.findByText(/the plan could not be computed/)).toBeInTheDocument();
    // With no plan there is nothing to confirm, so no repair button.
    expect(screen.queryByRole("button", { name: /repair/i })).toBeNull();
  });

  it("says so when the repair itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () =>
          jsonResponse(200, {
            healthy: false,
            gitDir: "/tmp/x/.git",
            zeroByteObjects: ["ab/cdef"],
            otherZeroByteFiles: [],
            fsckErrors: [],
            timedOut: false,
          }),
        repair: (body) =>
          body.confirm
            ? jsonResponse(500, { message: "the repair could not run" })
            : jsonResponse(200, {
                gitDir: "/tmp/x/.git",
                quarantine: ["abcdef"],
                willFetch: true,
                indexesToRebuild: ["/tmp/x"],
                indexesToSkip: [],
                actionable: true,
              }),
      }),
    );
    render(<GitPanel params={{ projectId: 19 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));
    const repairButton = await screen.findByRole("button", { name: /repair/i });
    await userEvent.click(repairButton);
    await userEvent.click(repairButton);

    expect(await screen.findByText(/the repair could not run/)).toBeInTheDocument();
  });

  it("reports the parts of the outcome that are not a clean success", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () =>
          jsonResponse(200, {
            healthy: false,
            gitDir: "/tmp/x/.git",
            zeroByteObjects: ["ab/cdef"],
            otherZeroByteFiles: [],
            fsckErrors: [],
            timedOut: false,
          }),
        repair: (body) =>
          body.confirm
            ? jsonResponse(200, {
                healthy: false,
                gitDir: "/tmp/x/.git",
                zeroByteObjects: ["ab/cdef"],
                otherZeroByteFiles: [],
                fsckErrors: [],
                timedOut: false,
                quarantine: "/tmp/x/.git/gc-quarantine-1",
                quarantined: ["abcdef"],
                recovered: ["123456"],
                unrecovered: ["fedcba"],
                refsRestored: false,
                indexesRebuilt: ["/tmp/x"],
                // The doctor's entries are "<path>: <reason>".
                indexesSkipped: ["/tmp/y: staged content would be lost"],
                whole: false,
              })
            : jsonResponse(200, {
                gitDir: "/tmp/x/.git",
                quarantine: ["abcdef"],
                willFetch: true,
                indexesToRebuild: ["/tmp/x"],
                indexesToSkip: [{ path: "/tmp/y", paths: ["a.txt"] }],
                actionable: true,
              }),
      }),
    );
    render(<GitPanel params={{ projectId: 20 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));
    // The plan says an index would be left alone, and why.
    expect(await screen.findByText(/leave 1 index\(es\) alone/)).toBeInTheDocument();

    const repairButton = await screen.findByRole("button", { name: /repair/i });
    await userEvent.click(repairButton);
    await userEvent.click(repairButton);

    // The outcome is what is reported, not the plan.
    expect(await screen.findByText(/the clone is NOT whole/)).toBeInTheDocument();
    // The index that was left alone is listed, with the reason.
    expect(screen.getByText(/staged content would be lost/)).toBeInTheDocument();
    expect(screen.getByText(/1 object\(s\) read fine again/)).toBeInTheDocument();
    expect(screen.getByText(/1 object\(s\) could not be recovered/)).toBeInTheDocument();
  });

  it("clears a previous failure when a later check succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () => {
          calls++;
          return calls === 1
            ? jsonResponse(500, { message: "the clone could not be inspected" })
            : jsonResponse(200, {
                healthy: true,
                zeroByteObjects: [],
                otherZeroByteFiles: [],
                fsckErrors: [],
                gitDir: "/tmp/x/.git",
                timedOut: false,
              });
        },
      }),
    );
    render(<GitPanel params={{ projectId: 13 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));
    expect(await screen.findByText(/the clone could not be inspected/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /check/i }));
    expect(await screen.findByText("This repository is healthy.")).toBeInTheDocument();
    // The stale error is gone.
    expect(screen.queryByText(/the clone could not be inspected/)).toBeNull();
  });

  // A failed check must say so. Silence here would read as "healthy" —
  // the one thing the check exists to rule out.
  it("reports an error when the health check itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        health: () => jsonResponse(500, { message: "the clone could not be inspected" }),
      }),
    );
    render(<GitPanel params={{ projectId: 9 }} />);
    await screen.findByText("main");

    await userEvent.click(screen.getByRole("button", { name: /check/i }));

    expect(await screen.findByText(/the clone could not be inspected/)).toBeInTheDocument();
    expect(screen.queryByText("This repository is healthy.")).toBeNull();
    // A failed check is announced, not just tinted — the same role="alert"
    // the git-status failure uses.
    expect(screen.getByRole("alert")).toHaveTextContent(/the clone could not be inspected/);
  });

  it("shows ahead/behind counts when they differ from zero", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: () => jsonResponse(200, { ...CLEAN_STATUS, ahead: 2, behind: 1 }) }),
    );
    render(<GitPanel params={{ projectId: 5 }} />);

    expect(await screen.findByText("↑2 ↓1")).toBeInTheDocument();
  });

  it("shows a conflict callout when hasConflicts is true", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () =>
          jsonResponse(200, {
            ...CLEAN_STATUS,
            isClean: false,
            hasConflicts: true,
            files: [{ path: "src/a.ts", status: "U" }],
          }),
      }),
    );
    render(<GitPanel params={{ projectId: 6 }} />);

    expect(await screen.findByText(/unresolved merge conflicts/)).toBeInTheDocument();
  });

  it("lists branches, marking the current one", async () => {
    const branchesResult: GitBranchesResult = {
      branches: [
        { name: "main", isCurrent: true },
        { name: "feature/foo", isCurrent: false },
      ],
      worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
      remoteBranches: [],
    };
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        branches: () => jsonResponse(200, branchesResult),
      }),
    );
    render(<GitPanel params={{ projectId: 7 }} />);

    expect(await screen.findByText("Branches (2)")).toBeInTheDocument();
    expect(screen.getByText("feature/foo")).toBeInTheDocument();
    expect(screen.getByText("current")).toBeInTheDocument();
  });

  it("lists worktrees, tagging the main one and showing a detached HEAD as such", async () => {
    const branchesResult: GitBranchesResult = {
      branches: [{ name: "main", isCurrent: true }],
      worktrees: [
        { path: "/home/x/project", branch: "main", isMain: true },
        { path: "/home/x/.mullion-worktrees/1", branch: "agent/task-1", isMain: false },
        { path: "/home/x/.claude/worktrees/2", branch: null, isMain: false },
      ],
      remoteBranches: [],
    };
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: () => jsonResponse(200, CLEAN_STATUS),
        branches: () => jsonResponse(200, branchesResult),
      }),
    );
    render(<GitPanel params={{ projectId: 8 }} />);

    expect(await screen.findByText("Worktrees (3)")).toBeInTheDocument();
    expect(screen.getByText("/home/x/project")).toBeInTheDocument();
    expect(screen.getByText("main (main)")).toBeInTheDocument();
    expect(screen.getByText("/home/x/.mullion-worktrees/1")).toBeInTheDocument();
    expect(screen.getByText("agent/task-1")).toBeInTheDocument();
    expect(screen.getByText("/home/x/.claude/worktrees/2")).toBeInTheDocument();
    expect(screen.getByText("detached")).toBeInTheDocument();
  });

  it("shows no branches/worktrees sections when git-branches 204s", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: () => jsonResponse(200, CLEAN_STATUS) }));
    render(<GitPanel params={{ projectId: 9 }} />);

    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.queryByText(/^Branches/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Worktrees/)).not.toBeInTheDocument();
  });

  // Issue #442 — branch/worktree mutation UI.
  describe("branch/worktree management (issue #442)", () => {
    it("disables Delete for the current branch and one checked out in another worktree", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "checked-out-elsewhere", isCurrent: false },
          { name: "deletable", isCurrent: false },
        ],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          {
            path: "/home/x/.mullion-worktrees/other",
            branch: "checked-out-elsewhere",
            isMain: false,
          },
        ],
        remoteBranches: [],
      };
      vi.stubGlobal(
        "fetch",
        mockFetch({
          status: () => jsonResponse(200, CLEAN_STATUS),
          branches: () => jsonResponse(200, branchesResult),
        }),
      );
      render(<GitPanel params={{ projectId: 10 }} />);

      await screen.findByText("Branches (3)");
      const deleteButtons = screen.getAllByText("Delete");
      expect(deleteButtons).toHaveLength(3);
      expect(deleteButtons[0]).toBeDisabled(); // main (current)
      expect(deleteButtons[1]).toBeDisabled(); // checked out elsewhere
      expect(deleteButtons[2]).not.toBeDisabled(); // deletable
    });

    it("on a git-level refusal, shows a message and Force button; Force succeeds and refreshes branches", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "unmerged-branch", isCurrent: false },
        ],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      let branchesCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branch-delete")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { force?: boolean };
          return Promise.resolve(
            body.force
              ? jsonResponse(200, { deleted: true })
              : jsonResponse(200, { deleted: false, reason: "unmerged" }),
          );
        }
        if (url.includes("/git-branches")) {
          branchesCallCount += 1;
          return Promise.resolve(jsonResponse(200, branchesResult));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 11 }} />);

      await screen.findByText("Branches (2)");
      const callsAfterMount = branchesCallCount;

      const deleteButtons = screen.getAllByText("Delete");
      // ConfirmButton needs an arm click, then a confirm click.
      await user.click(deleteButtons[1]);
      await user.click(deleteButtons[1]);

      expect(await screen.findByText(/not fully merged|unmerged/i)).toBeInTheDocument();
      const forceButton = await screen.findByText("Force");
      await user.click(forceButton);
      await user.click(forceButton);

      await vi.waitFor(() => expect(branchesCallCount).toBeGreaterThan(callsAfterMount));
    });

    // Independent review on PR #505 — a THROWN branch-delete failure (a 503
    // host-unreachable, or a 429 off the route's rate limit) used to be
    // swallowed into console.debug only, with no user-visible change at
    // all: the same "transient failure looks like nothing happened" class
    // this PR's refreshBranches fix already addresses on the read path.
    it("shows a message when the branch-delete request itself throws (not a git-level refusal)", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "deletable", isCurrent: false },
        ],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branch-delete")) {
          return Promise.resolve(jsonResponse(503, { message: "Host is unreachable" }));
        }
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 14 }} />);

      await screen.findByText("Branches (2)");
      const deleteButtons = screen.getAllByText("Delete");
      await user.click(deleteButtons[1]);
      await user.click(deleteButtons[1]);

      expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
      // A thrown request failure isn't a git-level refusal reason — Force
      // can't fix an unreachable host, so it must not be offered here.
      expect(screen.queryByText("Force")).not.toBeInTheDocument();
    });

    it("disables Remove for the main worktree, and a successful worktree remove refreshes branches", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          { path: "/home/x/.mullion-worktrees/foo", branch: "foo", isMain: false },
        ],
        remoteBranches: [],
      };
      let branchesCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-worktree-remove")) {
          return Promise.resolve(jsonResponse(200, { removed: true }));
        }
        if (url.includes("/git-branches")) {
          branchesCallCount += 1;
          return Promise.resolve(jsonResponse(200, branchesResult));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 12 }} />);

      await screen.findByText("Worktrees (2)");
      const removeButtons = screen.getAllByText("Remove");
      expect(removeButtons).toHaveLength(2);
      expect(removeButtons[0]).toBeDisabled();
      expect(removeButtons[1]).not.toBeDisabled();

      const callsBefore = branchesCallCount;
      await user.click(removeButtons[1]);
      await user.click(removeButtons[1]);

      await vi.waitFor(() => expect(branchesCallCount).toBeGreaterThan(callsBefore));
    });

    // Hermes review on PR #505 — "Open session here" had no in-flight
    // guard; a double-click before the first request resolves could create
    // two sessions.
    it("disables Open session here while a create-session request is in flight, and issues only one call", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          { path: "/home/x/.mullion-worktrees/foo", branch: "foo", isMain: false },
        ],
        remoteBranches: [],
      };
      let createSessionCalls = 0;
      let resolveCreateSession: (() => void) | undefined;
      // U6 — "Open session here" now goes through the STORE's createSession
      // action rather than calling api.createSession directly, so it also
      // fires a GET /api/sessions (refreshSessions) once the POST resolves.
      // Both share the same "/api/sessions" URL substring, so the POST/GET
      // branches have to be told apart by method (the create-in-flight
      // guard below only cares about POST calls).
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        if (url.includes("/actions")) {
          return Promise.resolve(
            jsonResponse(200, [
              { id: "agent:claude", title: "Claude", command: "claude", kind: "agent" },
            ]),
          );
        }
        if (url.includes("/api/sessions") && method === "POST") {
          createSessionCalls += 1;
          return new Promise((resolve) => {
            resolveCreateSession = () => resolve(jsonResponse(201, { id: 1 }));
          });
        }
        if (url.includes("/api/sessions")) {
          // The post-create refreshSessions() GET — resolve immediately so
          // it doesn't itself become a second in-flight request.
          return Promise.resolve(jsonResponse(200, []));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 16 }} />);

      await screen.findByText("Worktrees (2)");
      const openButtons = screen.getAllByText("Open session here");
      expect(openButtons).toHaveLength(1); // main worktree doesn't get one

      await user.click(openButtons[0]);
      await vi.waitFor(() => expect(openButtons[0]).toBeDisabled());
      // A second click while the first request is still in flight must not
      // fire a second createSession call.
      await user.click(openButtons[0]);
      await vi.waitFor(() => expect(createSessionCalls).toBe(1));

      resolveCreateSession?.();
      await vi.waitFor(() => expect(openButtons[0]).not.toBeDisabled());
    });

    // U6 — "Open session here" used to call api.createSession directly,
    // discarding the created session and never firing refreshSessions(), so
    // no panel ever opened and the new row only appeared up to
    // LIVE_REFRESH_INTERVAL_MS later via the next poll tick. This proves
    // both halves of the fix: (1) the store action is used, not the raw api
    // client — observable as a GET /api/sessions (refreshSessions) firing
    // right after the POST, which api.createSession alone would never
    // trigger — and (2) the resulting session reaches onOpenSession, which
    // is what actually opens a pane for it.
    it("U6 — opens a session via the store action (not the raw api client) and hands it to onOpenSession", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          { path: "/home/x/.mullion-worktrees/foo", branch: "foo", isMain: false },
        ],
        remoteBranches: [],
      };
      const NEW_SESSION = {
        id: 42,
        projectId: 20,
        parentSessionId: null,
        name: null,
        nameLocked: false,
        command: "claude",
        cwd: "/home/x/.mullion-worktrees/foo",
        liveCwd: null,
        previewBranch: null,
        kind: "terminal",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastAttachedAt: null,
        alive: true,
        subscriberCount: 0,
        activity: "idle",
        lastActivityAt: null,
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
        hookEmits: [],
        pendingDevServerPort: null,
        outstandingBackgroundTasks: [],
        sessionStatusAttentionRequired: false,
      };
      let listSessionsCalls = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        if (url.includes("/actions")) {
          return Promise.resolve(
            jsonResponse(200, [
              { id: "agent:claude", title: "Claude", command: "claude", kind: "agent" },
            ]),
          );
        }
        if (url.includes("/api/sessions") && method === "POST") {
          return Promise.resolve(jsonResponse(201, NEW_SESSION));
        }
        if (url.includes("/api/sessions")) {
          listSessionsCalls += 1;
          return Promise.resolve(jsonResponse(200, [NEW_SESSION]));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const onOpenSession = vi.fn();
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 20 }} onOpenSession={onOpenSession} />);

      await screen.findByText("Worktrees (2)");
      await user.click(screen.getByText("Open session here"));

      await vi.waitFor(() =>
        expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 42 })),
      );
      // Only the store's createSession action also calls refreshSessions()
      // — api.createSession alone never would. This is what makes the new
      // row show up in the sidebar/tab strip immediately instead of
      // waiting out the next live-refresh poll tick.
      expect(listSessionsCalls).toBeGreaterThan(0);
    });

    it("Prune stale calls the prune endpoint and refreshes branches", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      let branchesCallCount = 0;
      let pruneCalled = false;
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-worktree-prune")) {
          pruneCalled = true;
          return Promise.resolve(jsonResponse(200, { pruned: true }));
        }
        if (url.includes("/git-branches")) {
          branchesCallCount += 1;
          return Promise.resolve(jsonResponse(200, branchesResult));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 13 }} />);

      await screen.findByText("Worktrees (1)");
      const callsBefore = branchesCallCount;
      await user.click(screen.getByText("Prune stale"));

      await vi.waitFor(() => {
        expect(pruneCalled).toBe(true);
        expect(branchesCallCount).toBeGreaterThan(callsBefore);
      });
    });

    // Independent review on PR #505 — same swallowed-throw gap as the
    // branch-delete case above, for the panel-level Prune stale button.
    it("shows a message when the prune request itself throws", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-worktree-prune")) {
          return Promise.resolve(jsonResponse(503, { message: "Host is unreachable" }));
        }
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 15 }} />);

      await screen.findByText("Worktrees (1)");
      await user.click(screen.getByText("Prune stale"));

      expect(await screen.findByText(/unreachable/i)).toBeInTheDocument();
    });

    // Hermes review on PR #505 — "Open session here" used to silently
    // no-op when no launcher resolved (unlike Delete/Remove, which always
    // surface a message).
    it("shows a message when no launcher is configured for Open session here", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [],
        worktrees: [
          { path: "/home/x/project", branch: "main", isMain: true },
          { path: "/home/x/.mullion-worktrees/foo", branch: "foo", isMain: false },
        ],
        remoteBranches: [],
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branches"))
          return Promise.resolve(jsonResponse(200, branchesResult));
        if (url.includes("/actions")) return Promise.resolve(jsonResponse(200, []));
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 17 }} />);

      await screen.findByText("Worktrees (2)");
      await user.click(screen.getByText("Open session here"));

      expect(await screen.findByText(/no launcher/i)).toBeInTheDocument();
    });

    it("keeps showing last-known-good branches/worktrees after a mutation whose refresh transiently fails", async () => {
      // The real bug this fixes: the old `.catch(() => setBranchesResult(null))`
      // made a transient refresh failure right after a mutation look like
      // "my delete destroyed the panel" — see refreshBranches's own doc
      // comment in GitPanel.tsx.
      const branchesResult: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "mergeable", isCurrent: false },
        ],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      let branchesCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
        if (url.includes("/git-branch-delete")) {
          return Promise.resolve(jsonResponse(200, { deleted: true }));
        }
        if (url.includes("/git-branches")) {
          branchesCallCount += 1;
          if (branchesCallCount === 1) return Promise.resolve(jsonResponse(200, branchesResult));
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 14 }} />);

      await screen.findByText("Branches (2)");
      const deleteButtons = screen.getAllByText("Delete");
      await user.click(deleteButtons[1]);
      await user.click(deleteButtons[1]);

      await vi.waitFor(() => expect(branchesCallCount).toBeGreaterThan(1));
      expect(screen.getByText("Branches (2)")).toBeInTheDocument();
      expect(screen.getByText("mergeable")).toBeInTheDocument();
    });

    it("a mutation also invalidates store.ts's independent gitBranchesByProject cache (SessionRow's own branch display)", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [{ name: "main", isCurrent: true }],
        worktrees: [{ path: "/home/x/project", branch: "main", isMain: true }],
        remoteBranches: [],
      };
      const originalRefreshGitRefs = useDashboardStore.getState().refreshGitRefs;
      const refreshGitRefsSpy = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ refreshGitRefs: refreshGitRefsSpy });
      try {
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/git-status")) return Promise.resolve(jsonResponse(200, CLEAN_STATUS));
          if (url.includes("/git-worktree-prune")) {
            return Promise.resolve(jsonResponse(200, { pruned: true }));
          }
          if (url.includes("/git-branches"))
            return Promise.resolve(jsonResponse(200, branchesResult));
          return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
        });
        vi.stubGlobal("fetch", fetchMock);
        const user = userEvent.setup();
        render(<GitPanel params={{ projectId: 15 }} />);

        await screen.findByText("Worktrees (1)");
        expect(refreshGitRefsSpy).not.toHaveBeenCalled();
        await user.click(screen.getByText("Prune stale"));

        await vi.waitFor(() => expect(refreshGitRefsSpy).toHaveBeenCalled());
      } finally {
        useDashboardStore.setState({ refreshGitRefs: originalRefreshGitRefs });
      }
    });
  });

  describe("Pull action (issue #745)", () => {
    it("disables the Pull button when behind is 0", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ status: () => jsonResponse(200, { ...CLEAN_STATUS, behind: 0 }) }),
      );
      render(<GitPanel params={{ projectId: 20 }} />);

      const pullButton = await screen.findByRole("button", { name: /Pull/ });
      expect(pullButton).toBeDisabled();
    });

    it("enables the Pull button when behind > 0 and calls pull endpoint on click", async () => {
      let pullCalled = false;
      vi.stubGlobal(
        "fetch",
        mockFetch({
          status: () => jsonResponse(200, { ...CLEAN_STATUS, behind: 2 }),
          pull: () => {
            pullCalled = true;
            return jsonResponse(200, { pulled: true });
          },
        }),
      );
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 21 }} />);

      const pullButton = await screen.findByRole("button", { name: /Pull/ });
      expect(pullButton).not.toBeDisabled();

      await user.click(pullButton);
      expect(pullCalled).toBe(true);
    });

    it("renders error banner when pull returns a refusal reason", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          status: () => jsonResponse(200, { ...CLEAN_STATUS, behind: 1 }),
          pull: () =>
            jsonResponse(200, {
              pulled: false,
              reason: "dirty-tree",
              detail: "Worktree has uncommitted changes",
            }),
        }),
      );
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 22 }} />);

      const pullButton = await screen.findByRole("button", { name: /Pull/ });
      await user.click(pullButton);

      expect(
        await screen.findByText("Working tree has uncommitted changes or conflicts."),
      ).toBeInTheDocument();
    });

    it("expands and collapses inline diff when a changed file row is clicked, and disables directory rows", async () => {
      let requestedDiffUrl = "";
      vi.stubGlobal(
        "fetch",
        mockFetch({
          status: () =>
            jsonResponse(200, {
              ...CLEAN_STATUS,
              isClean: false,
              files: [
                { path: "src/a.ts", status: "M" },
                { path: "sub/", status: "?" },
              ],
            }),
          fileDiff: (url) => {
            requestedDiffUrl = url;
            return jsonResponse(200, { patch: "@@ -1 +1 @@\n-old\n+new" });
          },
        }),
      );
      const user = userEvent.setup();
      render(<GitPanel params={{ projectId: 23 }} />);

      const dirToggle = await screen.findByRole("button", { name: /sub\// });
      expect(dirToggle).toBeDisabled();

      const fileToggle = await screen.findByRole("button", { name: /src\/a\.ts/ });
      expect(fileToggle).toHaveAttribute("aria-expanded", "false");
      await user.click(fileToggle);
      expect(fileToggle).toHaveAttribute("aria-expanded", "true");
      expect(await screen.findByText("+new")).toBeInTheDocument();
      expect(requestedDiffUrl).toContain("projectId=23");
      expect(requestedDiffUrl).not.toContain("base=AUTO");

      // Clicking again collapses the diff
      await user.click(fileToggle);
      expect(fileToggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("+new")).toBeNull();
    });

    it("renders History section with git history", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          status: () => jsonResponse(200, CLEAN_STATUS),
          log: () =>
            jsonResponse(200, {
              commits: [
                {
                  sha: "a".repeat(40),
                  parents: [],
                  author: "Tester",
                  time: 1_700_000_000,
                  subject: "feat: history commit",
                  refs: [],
                },
              ],
              hasMore: false,
            }),
        }),
      );
      render(<GitPanel params={{ projectId: 24 }} />);

      expect(await screen.findByText("History")).toBeInTheDocument();
      expect(await screen.findByText("feat: history commit")).toBeInTheDocument();
    });

    it("displays upstream tracking tooltip on branch", async () => {
      const branchesResult: GitBranchesResult = {
        branches: [{ name: "main", isCurrent: true, upstream: "origin/main" }],
        worktrees: [],
        remoteBranches: [],
      };
      vi.stubGlobal(
        "fetch",
        mockFetch({
          status: () => jsonResponse(200, CLEAN_STATUS),
          branches: () => jsonResponse(200, branchesResult),
        }),
      );
      render(<GitPanel params={{ projectId: 25 }} />);

      await screen.findByText("Branches (1)");
      const branchTitle = screen.getByTitle(/main[\s\S]*Tracks: origin\/main/);
      expect(branchTitle).toBeInTheDocument();
      expect(branchTitle).toHaveTextContent("main");
    });
  });
});
