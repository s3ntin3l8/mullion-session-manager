// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHistorySection } from "./GitHistorySection.js";
import { GitBranchesSection } from "./GitBranchesSection.js";
import { GitWorktreesSection } from "./GitWorktreesSection.js";
import { HistoryGraph, MAX_GRAPH_W } from "./HistoryGraph.js";
import { HistorySidebarView } from "../right-sidebar/HistorySidebarView.js";
import { computeGraphLayout } from "./graphLayout.js";
import { GitSidebarView } from "../right-sidebar/GitSidebarView.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";

const COMMITS = [
  {
    sha: "m".repeat(40),
    parents: ["a".repeat(40), "f".repeat(40)],
    author: "T",
    time: 1_700_000_000,
    subject: "merge feat",
    refs: ["HEAD -> main", "origin/main", "tag: v1"],
  },
  {
    sha: "f".repeat(40),
    parents: ["b".repeat(40)],
    author: "T",
    time: 1_699_999_000,
    subject: "feat: thing",
    refs: ["feat"],
  },
  {
    sha: "a".repeat(40),
    parents: ["b".repeat(40)],
    author: "T",
    time: 1_699_998_000,
    subject: "second",
    refs: [],
  },
  {
    sha: "b".repeat(40),
    parents: [],
    author: "T",
    time: 1_699_997_000,
    subject: "first",
    refs: [],
  },
];

function stubFetch(extra?: (url: string) => Response | null) {
  const fn = vi.fn((url: string) => {
    const custom = extra?.(url);
    if (custom) return Promise.resolve(custom);
    if (url.includes("/git-log")) {
      return Promise.resolve(jsonResponse(200, { commits: COMMITS, hasMore: false }));
    }
    if (url.includes("/file?")) {
      return Promise.resolve(jsonResponse(200, { patch: "@@ -1 +1 @@\n-old\n+new" }));
    }
    if (url.includes("/git-commit/")) {
      return Promise.resolve(
        jsonResponse(200, {
          sha: COMMITS[1].sha,
          parents: [],
          author: "T",
          email: "t@x",
          time: 1,
          message: "feat: thing\n\nlonger body",
          files: [
            { path: "src/a.ts", additions: 3, deletions: 1 },
            { path: "img.png", additions: null, deletions: null },
          ],
        }),
      );
    }
    return Promise.resolve(jsonResponse(204, undefined));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({
    prsByProject: {
      1: {
        prs: [
          {
            number: 9,
            headBranch: "feat",
            prPhase: "ready_to_merge",
            title: "t",
            htmlUrl: "",
            author: null,
            headSha: "x",
            baseBranch: "main",
            ciStatus: "success",
            actionsRuns: [],
          },
        ],
        prSummary: { total: 1, pass: 1, fail: 0, pending: 0, unknown: 0 },
      },
    },
  } as never);
});
afterEach(() => vi.unstubAllGlobals());

describe("GitHistorySection", () => {
  it("renders the graph rows with ref chips and a PR chip on its branch", async () => {
    stubFetch();
    const { container } = render(<GitHistorySection projectId={1} />);
    expect(await screen.findByText("merge feat")).toBeInTheDocument();
    expect(container.querySelectorAll("svg.gh-graph")).toHaveLength(4);
    // `HEAD -> main` + `origin/main` collapse into one synced chip.
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.queryByText("origin/main")).toBeNull();
    expect(screen.getByLabelText("synced with remote")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("#9")).toBeInTheDocument(); // PR chip on `feat`
  });

  it("expands a commit to its files and shows a file diff; binary files have no counts", async () => {
    stubFetch();
    render(<GitHistorySection projectId={1} />);
    await userEvent.click(await screen.findByRole("button", { name: /feat: thing/ }));
    expect(await screen.findByText("longer body")).toBeInTheDocument();
    expect(screen.getByText("bin")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /src\/a.ts/ }));
    expect(await screen.findByText("+new")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /src\/a.ts/ }));
    expect(screen.queryByText("+new")).toBeNull();
  });

  it("shows the clicked file's diff even if an earlier click answers late", async () => {
    let releaseA!: (r: Response) => void;
    const slowA = new Promise<Response>((res) => {
      releaseA = res;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/git-log")) {
          return Promise.resolve(jsonResponse(200, { commits: COMMITS, hasMore: false }));
        }
        if (url.includes("/file?path=src%2Fa.ts")) return slowA;
        if (url.includes("/file?path=src%2Fb.ts")) {
          return Promise.resolve(jsonResponse(200, { patch: "@@ -1 +1 @@\n-x\n+from-b" }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            sha: COMMITS[1].sha,
            parents: [],
            author: "T",
            email: "t@x",
            time: 1,
            message: "feat: thing",
            files: [
              { path: "src/a.ts", additions: 1, deletions: 0 },
              { path: "src/b.ts", additions: 1, deletions: 0 },
            ],
          }),
        );
      }),
    );
    render(<GitHistorySection projectId={1} />);
    await userEvent.click(await screen.findByRole("button", { name: /feat: thing/ }));
    await userEvent.click(await screen.findByRole("button", { name: /src\/a.ts/ }));
    await userEvent.click(screen.getByRole("button", { name: /src\/b.ts/ }));
    expect(await screen.findByText("+from-b")).toBeInTheDocument();
    releaseA(jsonResponse(200, { patch: "@@ -1 +1 @@\n-x\n+from-a" }));
    await waitFor(() => expect(screen.getByText("+from-b")).toBeInTheDocument());
    expect(screen.queryByText("+from-a")).toBeNull();
  });

  it("switches scope and pages with Load more", async () => {
    const fn = stubFetch((url) =>
      url.includes("skip=4")
        ? jsonResponse(200, {
            commits: [{ ...COMMITS[3], sha: "c".repeat(40), subject: "older" }],
            hasMore: false,
          })
        : url.includes("/git-log") && !url.includes("scope=all")
          ? jsonResponse(200, { commits: COMMITS, hasMore: true })
          : null,
    );
    render(<GitHistorySection projectId={1} cwd="/wt/x" />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("older")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("History scope"), "all");
    await waitFor(() => {
      const urls = fn.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("scope=all") && u.includes("cwd=%2Fwt%2Fx"))).toBe(true);
    });
  });

  it("renders the history scope as the app's themed dropdown, not a bare native select", async () => {
    stubFetch((url) =>
      url.includes("/git-log") ? jsonResponse(200, { commits: COMMITS, hasMore: false }) : null,
    );
    render(<GitHistorySection projectId={1} cwd="/wt/x" />);
    const scope = await screen.findByLabelText("History scope");
    expect(scope.closest(".settings-dropdown.small")).not.toBeNull();
    expect(scope).toHaveValue("head");
  });

  it("drops Load more when a reload (scope change) fails after a page had more", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes("scope=all")
            ? jsonResponse(500, { message: "boom" })
            : jsonResponse(200, { commits: COMMITS, hasMore: true }),
        ),
      ),
    );
    render(<GitHistorySection projectId={1} />);
    expect(await screen.findByRole("button", { name: "Load more" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("History scope"), "all");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("never duplicates a commit that shifts between pages", async () => {
    stubFetch((url) =>
      url.includes("skip=4")
        ? jsonResponse(200, {
            commits: [COMMITS[3], { ...COMMITS[3], sha: "d".repeat(40), subject: "older" }],
            hasMore: false,
          })
        : url.includes("/git-log")
          ? jsonResponse(200, { commits: COMMITS, hasMore: true })
          : null,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<GitHistorySection projectId={1} />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("older")).toBeInTheDocument();
    expect(screen.getAllByText("first")).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("explains an unavailable history and a failed load", async () => {
    stubFetch(() => jsonResponse(204, undefined));
    const { unmount } = render(<GitHistorySection projectId={1} />);
    expect(await screen.findByText("No history available")).toBeInTheDocument();
    unmount();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { message: "boom" })));
    render(<GitHistorySection projectId={1} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("GitHistorySection fixes", () => {
  it("classifies only real remote refs as remote (a local feature/x is a branch)", async () => {
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: { branches: [], worktrees: [], remoteBranches: ["upstream/main"] },
      },
    } as never);
    stubFetch((url) =>
      url.includes("/git-log")
        ? jsonResponse(200, {
            commits: [{ ...COMMITS[0], refs: ["feature/x", "origin/main", "upstream/main"] }],
            hasMore: false,
          })
        : null,
    );
    render(<GitHistorySection projectId={1} />);
    expect((await screen.findByText("feature/x")).className).toContain("gh-ref-branch");
    // Both remotes strip to `main`: one remote-only chip, not two.
    const main = screen.getByText("main");
    expect(main.className).toContain("gh-ref-remote");
    expect(main.title).toBe("origin/main, upstream/main · in sync with the remote");
  });

  it("ignores a page that was in flight when the scope changed", async () => {
    let release!: (r: Response) => void;
    const slow = new Promise<Response>((res) => {
      release = res;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("skip=4")) return slow;
        if (url.includes("scope=all")) {
          return Promise.resolve(
            jsonResponse(200, {
              commits: [{ ...COMMITS[3], subject: "all-only" }],
              hasMore: false,
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, { commits: COMMITS, hasMore: true }));
      }),
    );
    render(<GitHistorySection projectId={1} />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await userEvent.selectOptions(screen.getByLabelText("History scope"), "all");
    expect(await screen.findByText("all-only")).toBeInTheDocument();

    release(
      jsonResponse(200, { commits: [{ ...COMMITS[3], subject: "stale page" }], hasMore: true }),
    );
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.queryByText("stale page")).toBeNull();
    expect(screen.getByText("all-only")).toBeInTheDocument();
  });
});

describe("HistoryGraph", () => {
  it("draws a dot per row and a line for each connection", () => {
    const layout = computeGraphLayout([
      { sha: "m", parents: ["x", "f"] },
      { sha: "f", parents: ["base"] },
      { sha: "x", parents: ["base"] },
      { sha: "base", parents: [] },
    ]);
    const { container } = render(<HistoryGraph row={layout.rows[3]} />);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    expect(container.querySelectorAll("line").length).toBeGreaterThanOrEqual(2);
  });
});

describe("GitBranchesSection / GitWorktreesSection", () => {
  it("lists branches with ahead/behind, merged and PR chips", () => {
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: {
          branches: [
            { name: "main", isCurrent: true },
            {
              name: "feat",
              isCurrent: false,
              ahead: 2,
              behind: 1,
              isMerged: true,
              lastCommitRelative: "3 days ago",
            },
          ],
          worktrees: [],
          remoteBranches: [],
        },
      },
    } as never);
    render(<GitBranchesSection projectId={1} />);
    expect(screen.getByText("● main")).toBeInTheDocument();
    expect(screen.getByText("↑2")).toBeInTheDocument();
    expect(screen.getByText("↓1")).toBeInTheDocument();
    expect(screen.getByText("merged")).toBeInTheDocument();
    expect(screen.getByText("#9")).toBeInTheDocument();
    expect(screen.getByText("3 days ago")).toBeInTheDocument();
  });

  it("shows the merged tag from the detailed branch list the section fetches", async () => {
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: { branches: [{ name: "feat", isCurrent: false }], worktrees: [], remoteBranches: [] },
      },
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes("detail=1")
            ? jsonResponse(200, {
                branches: [{ name: "feat", isCurrent: false, isMerged: true }],
                worktrees: [],
                remoteBranches: [],
              })
            : jsonResponse(204, undefined),
        ),
      ),
    );
    render(<GitBranchesSection projectId={1} />);
    expect(await screen.findByText("merged")).toBeInTheDocument();
  });

  it("never shows another project's branches after a project switch", async () => {
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: {
          branches: [{ name: "p1-branch", isCurrent: false }],
          worktrees: [],
          remoteBranches: [],
        },
        2: {
          branches: [{ name: "p2-branch", isCurrent: false }],
          worktrees: [],
          remoteBranches: [],
        },
      },
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("/projects/1/")
          ? Promise.resolve(
              jsonResponse(200, {
                branches: [{ name: "p1-detailed", isCurrent: false }],
                worktrees: [],
                remoteBranches: [],
              }),
            )
          : Promise.reject(new Error("boom")),
      ),
    );
    const { rerender } = render(<GitBranchesSection projectId={1} />);
    expect(await screen.findByText("p1-detailed")).toBeInTheDocument();
    rerender(<GitBranchesSection projectId={2} />);
    expect(screen.queryByText("p1-detailed")).toBeNull();
    expect(screen.getByText("p2-branch")).toBeInTheDocument();
  });

  it("shows placeholders without data", () => {
    useDashboardStore.setState({ gitBranchesByProject: {} } as never);
    const { unmount } = render(<GitBranchesSection projectId={1} />);
    expect(screen.getByText("No branch data")).toBeInTheDocument();
    unmount();
    render(<GitWorktreesSection projectId={1} selected={undefined} onSelect={vi.fn()} />);
    expect(screen.getByText("No worktree data")).toBeInTheDocument();
  });

  it("matches a session by liveCwd, then cwd, then the project root", () => {
    useDashboardStore.setState({
      projects: [{ id: 1, name: "p", cwd: "/repo", hostId: "local" }],
      sessions: [
        {
          id: 1,
          projectId: 1,
          status: "active",
          cwd: "/elsewhere",
          liveCwd: "/repo-wt",
          name: "cd-ed",
        },
        { id: 2, projectId: 1, status: "active", cwd: null, liveCwd: null, name: "root-one" },
      ],
      gitBranchesByProject: {
        1: {
          branches: [],
          remoteBranches: [],
          worktrees: [
            { path: "/repo", branch: "main", isMain: true },
            { path: "/repo-wt", branch: "feat", isMain: false },
          ],
        },
      },
    } as never);
    render(<GitWorktreesSection projectId={1} selected={undefined} onSelect={vi.fn()} />);
    const rows = screen.getAllByText(/▶/);
    expect(rows.map((r) => r.textContent)).toEqual(["▶ root-one", "▶ cd-ed"]);
  });

  it("lists worktrees with live sessions (click focuses) and scopes history on select", async () => {
    const requestOpenSession = vi.fn();
    useDashboardStore.setState({
      requestOpenSession,
      sessions: [{ id: 5, projectId: 1, status: "active", cwd: "/repo-wt", name: "agent" }],
      gitBranchesByProject: {
        1: {
          branches: [],
          remoteBranches: [],
          worktrees: [
            { path: "/repo", branch: "main", isMain: true },
            { path: "/repo-wt", branch: "feat", isMain: false },
            { path: "/repo-det", branch: null, isMain: false },
          ],
        },
      },
    } as never);
    const onSelect = vi.fn();
    render(<GitWorktreesSection projectId={1} selected={undefined} onSelect={onSelect} />);
    expect(screen.getByText("(detached)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /agent/ }));
    expect(requestOpenSession).toHaveBeenCalledWith(5);
    await userEvent.click(screen.getByRole("button", { name: "repo-wt" }));
    expect(onSelect).toHaveBeenCalledWith("/repo-wt");
    await userEvent.click(screen.getByRole("button", { name: "repo" }));
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it("deletes a branch and refreshes on confirmation", async () => {
    let deletedCall: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes("/git-branch-delete")) {
          deletedCall = JSON.parse(String(opts?.body));
          return Promise.resolve(jsonResponse(200, { deleted: true }));
        }
        if (url.includes("detail=1")) {
          return Promise.resolve(
            jsonResponse(200, {
              branches: [{ name: "feature", isCurrent: false }],
              worktrees: [],
              remoteBranches: [],
            }),
          );
        }
        return Promise.resolve(jsonResponse(204, undefined));
      }),
    );
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: {
          branches: [{ name: "feature", isCurrent: false, upstream: "origin/feature" }],
          worktrees: [],
          remoteBranches: [],
        },
      },
    } as never);
    render(<GitBranchesSection projectId={1} />);
    const branchTitle = screen.getByText("feature");
    expect(branchTitle).toHaveAttribute("title", "feature\nTracks: origin/feature");

    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    await userEvent.click(deleteBtn);
    await userEvent.click(deleteBtn);

    expect(deletedCall).toEqual({ name: "feature", force: false });
  });

  it("handles branch delete refusal and allows force delete", async () => {
    let forceCall: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes("/git-branch-delete")) {
          const body = JSON.parse(String(opts?.body));
          if (!body.force) {
            return Promise.resolve(
              jsonResponse(200, { deleted: false, reason: "unmerged", detail: "not fully merged" }),
            );
          }
          forceCall = body;
          return Promise.resolve(jsonResponse(200, { deleted: true }));
        }
        if (url.includes("detail=1")) {
          return Promise.resolve(
            jsonResponse(200, {
              branches: [{ name: "unmerged-feat", isCurrent: false }],
              worktrees: [],
              remoteBranches: [],
            }),
          );
        }
        return Promise.resolve(jsonResponse(204, undefined));
      }),
    );
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: {
          branches: [{ name: "unmerged-feat", isCurrent: false }],
          worktrees: [],
          remoteBranches: [],
        },
      },
    } as never);
    render(<GitBranchesSection projectId={1} />);
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    await userEvent.click(deleteBtn);
    await userEvent.click(deleteBtn);

    expect(
      await screen.findByText((content) => content.includes("not merged")),
    ).toBeInTheDocument();
    const forceBtn = screen.getByRole("button", { name: "Force" });
    await userEvent.click(forceBtn);
    await userEvent.click(forceBtn);

    expect(forceCall).toEqual({ name: "unmerged-feat", force: true });
  });

  it("prunes stale worktrees and removes worktree on confirmation", async () => {
    let pruneCalled = false;
    let removeCalled: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes("/git-worktree-prune")) {
          pruneCalled = true;
          return Promise.resolve(jsonResponse(200, { pruned: true }));
        }
        if (url.includes("/git-worktree-remove")) {
          removeCalled = JSON.parse(String(opts?.body));
          return Promise.resolve(jsonResponse(200, { removed: true }));
        }
        if (url.includes("detail=1")) {
          return Promise.resolve(
            jsonResponse(200, {
              branches: [],
              worktrees: [
                { path: "/repo", branch: "main", isMain: true },
                { path: "/repo-extra", branch: "extra", isMain: false },
              ],
              remoteBranches: [],
            }),
          );
        }
        return Promise.resolve(jsonResponse(204, undefined));
      }),
    );
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: {
          branches: [],
          remoteBranches: [],
          worktrees: [
            { path: "/repo", branch: "main", isMain: true },
            { path: "/repo-extra", branch: "extra", isMain: false },
          ],
        },
      },
    } as never);
    render(<GitWorktreesSection projectId={1} selected={undefined} onSelect={vi.fn()} />);
    const pruneBtn = screen.getByRole("button", { name: /Prune stale/ });
    await userEvent.click(pruneBtn);
    expect(pruneCalled).toBe(true);

    const removeBtn = screen.getByRole("button", { name: "Remove" });
    await userEvent.click(removeBtn);
    await userEvent.click(removeBtn);

    expect(removeCalled).toEqual({ worktreePath: "/repo-extra", force: false });
  });

  it("clears branch rowErrors and worktree pruneError when projectId changes, including late in-flight responses", async () => {
    let settleSlowBranchDelete!: (r: Response) => void;
    let settleSlowPrune!: (err: Error) => void;
    let callIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/git-branch-delete")) {
          callIdx += 1;
          if (callIdx === 1) {
            return Promise.resolve(
              jsonResponse(200, { deleted: false, reason: "unmerged", detail: "not merged" }),
            );
          }
          return new Promise<Response>((res) => {
            settleSlowBranchDelete = res;
          });
        }
        if (url.includes("/git-worktree-prune")) {
          return new Promise<Response>((_, rej) => {
            settleSlowPrune = rej;
          });
        }
        return Promise.resolve(jsonResponse(204, undefined));
      }),
    );
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: {
          branches: [{ name: "shared-name", isCurrent: false }],
          worktrees: [{ path: "/repo1", branch: "main", isMain: true }],
          remoteBranches: [],
        },
        2: {
          branches: [{ name: "shared-name", isCurrent: false }],
          worktrees: [{ path: "/repo2", branch: "main", isMain: true }],
          remoteBranches: [],
        },
      },
    } as never);

    const { rerender, unmount } = render(<GitBranchesSection projectId={1} />);
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    await userEvent.click(deleteBtn);
    await userEvent.click(deleteBtn);
    expect(
      await screen.findByText((content) => content.includes("not merged")),
    ).toBeInTheDocument();

    // Start a second (slow) delete on project 1, then switch to project 2 before it settles
    await userEvent.click(deleteBtn);
    await userEvent.click(deleteBtn);
    rerender(<GitBranchesSection projectId={2} />);
    expect(screen.queryByText((content) => content.includes("not merged"))).toBeNull();

    settleSlowBranchDelete(
      jsonResponse(200, { deleted: false, reason: "unmerged", detail: "late project 1 refusal" }),
    );
    await waitFor(() =>
      expect(screen.queryByText((content) => content.includes("not merged"))).toBeNull(),
    );
    unmount();

    const wtRender = render(
      <GitWorktreesSection projectId={1} selected={undefined} onSelect={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Prune stale/ }));
    expect(screen.getByRole("button", { name: /Pruning/ })).toBeDisabled();

    // Switch to project 2 while project 1's prune is still in flight
    wtRender.rerender(
      <GitWorktreesSection projectId={2} selected={undefined} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Prune stale/ })).not.toBeDisabled();

    settleSlowPrune(new Error("prune boom"));
    await waitFor(() => expect(screen.queryByText("prune boom")).toBeNull());
  });
});

describe("GitSidebarView", () => {
  it("no longer hosts History; Changes is open by default and toggles persist", async () => {
    stubFetch();
    render(<GitSidebarView projectId={1} actions={{ onOpenGit: vi.fn() } as never} />);
    expect(screen.queryByRole("button", { name: /History/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Branches/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await userEvent.click(screen.getByRole("button", { name: /Branches/ }));
    expect(JSON.parse(localStorage.getItem("crs.gitSidebarSections")!).branches).toBe(true);
  });

  it("restores stored section state and survives corrupt storage", () => {
    stubFetch();
    localStorage.setItem("crs.gitSidebarSections", JSON.stringify({ worktrees: true }));
    const { unmount } = render(
      <GitSidebarView projectId={1} actions={{ onOpenGit: vi.fn() } as never} />,
    );
    expect(screen.getByRole("button", { name: /Worktrees/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    unmount();
    localStorage.setItem("crs.gitSidebarSections", "{not json");
    render(<GitSidebarView projectId={1} actions={{ onOpenGit: vi.fn() } as never} />);
    expect(screen.getByRole("button", { name: /Branches/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

describe("HistorySidebarView", () => {
  const actions = { onOpenGit: vi.fn() } as never;
  const withWorktrees = () =>
    useDashboardStore.setState({
      gitBranchesByProject: {
        1: {
          branches: [
            { name: "main", isCurrent: true },
            { name: "feat", isCurrent: false },
          ],
          remoteBranches: [],
          worktrees: [
            { path: "/repo", branch: "main", isMain: true },
            { path: "/repo-wt", branch: "feat", isMain: false },
          ],
        },
      },
    } as never);
  const logUrls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => String(c[0]));

  it("defaults to the current branch and offers All and each branch", async () => {
    withWorktrees();
    const fn = stubFetch();
    render(<HistorySidebarView projectId={1} actions={actions} />);
    expect(await screen.findByText("merge feat")).toBeInTheDocument();
    expect(logUrls(fn).some((u) => u.includes("scope=head"))).toBe(true);
    const scope = screen.getByLabelText("History scope");
    expect(Array.from(scope.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "head",
      "all",
      "branch:main",
      "branch:feat",
    ]);
    await userEvent.selectOptions(scope, "branch:feat");
    await waitFor(() =>
      expect(logUrls(fn).some((u) => u.includes("scope=branch%3Afeat"))).toBe(true),
    );
  });

  it("filters by worktree and drops it when the project changes", async () => {
    withWorktrees();
    stubFetch();
    const { rerender } = render(<HistorySidebarView projectId={1} actions={actions} />);
    await screen.findByText("merge feat");
    await userEvent.selectOptions(screen.getByLabelText("Worktree filter"), "/repo-wt");
    const fn = stubFetch();
    rerender(<HistorySidebarView projectId={2} actions={actions} />);
    await waitFor(() =>
      expect(logUrls(fn).some((u) => u.includes("/projects/2/git-log"))).toBe(true),
    );
    expect(
      logUrls(fn)
        .filter((u) => u.includes("/projects/2/git-log"))
        .every((u) => !u.includes("cwd=")),
    ).toBe(true);
  });

  it("keeps every row's subject on screen at a 260px sidebar, graph capped per row", async () => {
    // A history 14 lanes wide: the old global column width starved the subject.
    const wide = Array.from({ length: 14 }, (_, i) => ({
      sha: `w${i}`.padEnd(40, "0"),
      parents: [`p${i}`.padEnd(40, "0")],
      author: "T",
      time: 1_700_000_000 - i,
      subject: `wide ${i}`,
      refs: i === 0 ? ["a", "b", "c", "origin/a"] : [],
    }));
    const tail = wide.map((c, i) => ({
      sha: c.parents[0],
      parents: [] as string[],
      author: "T",
      time: 1_699_000_000 - i,
      subject: `tail ${i}`,
      refs: [],
    }));
    stubFetch((url) =>
      url.includes("/git-log")
        ? jsonResponse(200, { commits: [...wide, ...tail], hasMore: false })
        : null,
    );
    const { container } = render(
      <div style={{ width: 260 }}>
        <HistorySidebarView projectId={1} actions={actions} />
      </div>,
    );
    for (const c of wide) expect(await screen.findByText(c.subject)).toBeVisible();
    const widths = Array.from(container.querySelectorAll("svg.gh-graph")).map((n) =>
      Number(n.getAttribute("width")),
    );
    expect(Math.max(...widths)).toBeLessThanOrEqual(MAX_GRAPH_W);
    expect(Math.min(...widths)).toBeLessThan(Math.max(...widths)); // per-row, not global
    // 4 refs -> two inline chips + "+2", and a single count chip for compact density.
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(container.querySelectorAll(".gh-commit-refs--count .sb-chip")).toHaveLength(1);
  });
});
