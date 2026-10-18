// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHistorySection } from "./GitHistorySection.js";
import { GitBranchesSection } from "./GitBranchesSection.js";
import { GitWorktreesSection } from "./GitWorktreesSection.js";
import { HistoryGraph } from "./HistoryGraph.js";
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
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("origin/main")).toBeInTheDocument();
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
        : url.includes("/git-log") && !url.includes("scope=head")
          ? jsonResponse(200, { commits: COMMITS, hasMore: true })
          : null,
    );
    render(<GitHistorySection projectId={1} cwd="/wt/x" />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("older")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("History scope"), "head");
    await waitFor(() => {
      const urls = fn.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("scope=head") && u.includes("cwd=%2Fwt%2Fx"))).toBe(true);
    });
  });

  it("drops Load more when a reload (scope change) fails after a page had more", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes("scope=head")
            ? jsonResponse(500, { message: "boom" })
            : jsonResponse(200, { commits: COMMITS, hasMore: true }),
        ),
      ),
    );
    render(<GitHistorySection projectId={1} />);
    expect(await screen.findByRole("button", { name: "Load more" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("History scope"), "head");
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
    expect(screen.getByText("origin/main").className).toContain("gh-ref-remote");
    expect(screen.getByText("upstream/main").className).toContain("gh-ref-remote");
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
        if (url.includes("scope=head")) {
          return Promise.resolve(
            jsonResponse(200, {
              commits: [{ ...COMMITS[3], subject: "head-only" }],
              hasMore: false,
            }),
          );
        }
        return Promise.resolve(jsonResponse(200, { commits: COMMITS, hasMore: true }));
      }),
    );
    render(<GitHistorySection projectId={1} />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await userEvent.selectOptions(screen.getByLabelText("History scope"), "head");
    expect(await screen.findByText("head-only")).toBeInTheDocument();

    release(
      jsonResponse(200, { commits: [{ ...COMMITS[3], subject: "stale page" }], hasMore: true }),
    );
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.queryByText("stale page")).toBeNull();
    expect(screen.getByText("head-only")).toBeInTheDocument();
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
    const { container } = render(<HistoryGraph row={layout.rows[3]} columns={layout.width} />);
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
});

describe("GitSidebarView", () => {
  it("shows Changes and History open by default, persists toggles", async () => {
    stubFetch();
    render(<GitSidebarView projectId={1} actions={{ onOpenGit: vi.fn() } as never} />);
    expect(await screen.findByText("merge feat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Branches/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: /Branches/ }));
    expect(screen.getByRole("button", { name: /Branches/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(JSON.parse(localStorage.getItem("crs.gitSidebarSections")!).branches).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(screen.queryByText("merge feat")).toBeNull();
  });

  it("drops the selected worktree when the project changes", async () => {
    stubFetch();
    useDashboardStore.setState({
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
    localStorage.setItem("crs.gitSidebarSections", JSON.stringify({ worktrees: true }));
    const actions = { onOpenGit: vi.fn() } as never;
    const { rerender } = render(<GitSidebarView projectId={1} actions={actions} />);
    await screen.findByText("merge feat");
    await userEvent.click(screen.getByRole("button", { name: "repo-wt" }));
    const logUrls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => String(c[0]));
    const fn = stubFetch();
    rerender(<GitSidebarView projectId={2} actions={actions} />);
    await waitFor(() =>
      expect(logUrls(fn).some((u) => u.includes("/projects/2/git-log"))).toBe(true),
    );
    expect(
      logUrls(fn)
        .filter((u) => u.includes("/projects/2/git-log"))
        .every((u) => !u.includes("cwd=")),
    ).toBe(true);
  });

  it("restores stored section state and survives corrupt storage", () => {
    stubFetch();
    localStorage.setItem(
      "crs.gitSidebarSections",
      JSON.stringify({ history: false, worktrees: true }),
    );
    const { unmount } = render(
      <GitSidebarView projectId={1} actions={{ onOpenGit: vi.fn() } as never} />,
    );
    expect(screen.getByRole("button", { name: /History/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /Worktrees/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    unmount();
    localStorage.setItem("crs.gitSidebarSections", "{not json");
    render(<GitSidebarView projectId={1} actions={{ onOpenGit: vi.fn() } as never} />);
    expect(screen.getByRole("button", { name: /History/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
