// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitHistorySection } from "./GitHistorySection.js";
import { HistoryGraph, MAX_GRAPH_W } from "./HistoryGraph.js";
import { HistorySidebarView } from "../right-sidebar/HistorySidebarView.js";
import { computeGraphLayout } from "./graphLayout.js";
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

  it("says the host is unreachable instead of showing an empty history", async () => {
    useDashboardStore.setState({
      projects: [{ id: 1, hostId: "h1" }] as never,
      hosts: [{ id: "h1", name: "box", health: "offline" }] as never,
    });
    stubFetch(() => jsonResponse(204, undefined));
    render(<GitHistorySection projectId={1} />);
    expect(await screen.findByText("Host box is unreachable")).toBeInTheDocument();
    expect(screen.queryByText("No history available")).toBeNull();
    useDashboardStore.setState({ projects: [], hosts: [] });
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
    expect((await screen.findByText("feature/x")).className).toContain("sb-chip--success");
    // Both remotes strip to `main`: one remote-only chip, not two.
    const main = screen.getByText("main");
    expect(main.className).toContain("sb-chip--neutral");
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

describe("HistorySidebarView", () => {
  const actions = { onOpenGit: vi.fn() } as never;
  const withWorktrees = (hostId = "local") =>
    useDashboardStore.setState({
      projects: [{ id: 1, name: "p", cwd: "/repo", hostId }],
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

  it("keeps the branch scope per project: a switch falls back to the current branch", async () => {
    withWorktrees();
    stubFetch();
    const { rerender } = render(<HistorySidebarView projectId={1} actions={actions} />);
    await screen.findByText("merge feat");
    await userEvent.selectOptions(screen.getByLabelText("History scope"), "branch:feat");
    const fn = stubFetch();
    rerender(<HistorySidebarView projectId={2} actions={actions} />);
    await waitFor(() =>
      expect(logUrls(fn).some((u) => u.includes("/projects/2/git-log"))).toBe(true),
    );
    const urls = logUrls(fn).filter((u) => u.includes("/projects/2/git-log"));
    expect(urls.every((u) => u.includes("scope=head"))).toBe(true);
    expect(screen.getByLabelText("History scope")).toHaveValue("head");
  });

  it("offers no per-branch scopes on a remote-host project", async () => {
    withWorktrees("host-2");
    stubFetch();
    render(<HistorySidebarView projectId={1} actions={actions} />);
    await screen.findByText("merge feat");
    const scope = screen.getByLabelText("History scope");
    expect(Array.from(scope.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "head",
      "all",
    ]);
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
