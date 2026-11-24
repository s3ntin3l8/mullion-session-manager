// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssueDetailView, IssuesSection } from "./IssuesView.js";
import { issueBranchName, issueSeedPrompt } from "./issueWork.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";
import { makeProject, makeSession, makeTask } from "../test/fixtures.js";
import { useState } from "react";

const LIST = {
  issues: [
    {
      number: 7,
      title: "Crash on start",
      htmlUrl: "https://github.com/a/b/issues/7",
      author: "x",
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: [],
      commentCount: 3,
      milestone: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      taskStatus: "in_progress",
    },
  ],
  page: 1,
  hasMore: false,
  labels: [
    { name: "bug", color: "d73a4a" },
    { name: "docs", color: "0075ca" },
  ],
  taskMasterEnabled: true,
  taskLabel: "mullion-task",
};

const DETAIL = {
  ...LIST.issues[0],
  taskStatus: null,
  writeIdentity: { kind: "user", login: "octocat" },
  state: "open",
  bodyHtml: '<p>It <b>crashes</b></p><img src=x onerror="boom()">',
  subIssues: [],
  subIssuesSummary: null,
  parent: null,
  comments: [
    {
      id: 1,
      author: "bob",
      bodyHtml: "<p>same here</p>",
      createdAt: "2026-01-03T00:00:00Z",
      htmlUrl: "https://github.com/a/b/issues/7#c1",
    },
  ],
};

describe("issueBranchName / issueSeedPrompt", () => {
  it("builds a ref-safe branch name and a prompt that points at the issue", () => {
    expect(issueBranchName({ number: 12, title: "Fix: the  Thing!! (urgent)" })).toBe(
      "issue-12-fix-the-thing-urgent",
    );
    expect(issueBranchName({ number: 3, title: "!!!" })).toBe("issue-3");
    const prompt = issueSeedPrompt({ number: 7, title: "Crash", htmlUrl: "https://x/7" });
    expect(prompt).toContain("#7");
    expect(prompt).toContain("gh issue view 7");
  });
});

describe("IssuesSection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists issues with label chips, task chip and comment count; label chips filter", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, LIST)));
    vi.stubGlobal("fetch", fetchMock);
    const onOpen = vi.fn();
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={onOpen} />,
    );

    expect(await screen.findByText("Crash on start")).toBeInTheDocument();
    expect(screen.getByText("Task: in_progress")).toBeInTheDocument();
    expect(screen.getByTitle("3 comments")).toHaveTextContent("3");

    await userEvent.click(screen.getByRole("button", { name: "Filter issues" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "docs" }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(urls.some((u) => u.includes("labels=docs"))).toBe(true);
    });
    // The closed button still says a filter is on.
    expect(screen.getByRole("button", { name: "Filter issues" })).toHaveTextContent("1");

    await userEvent.click(screen.getByRole("button", { name: /Crash on start/ }));
    expect(onOpen).toHaveBeenCalledWith(7);
  });

  it("Manual lists the issues Task Master is not working, even with no session on them", async () => {
    const plain = { ...LIST.issues[0], number: 8, title: "Plain issue", taskStatus: null };
    const list = { ...LIST, issues: [LIST.issues[0], plain] };
    // The origin filter only shows while Task Master is on.
    const wasEnabled = useDashboardStore.getState().taskMasterEnabled;
    useDashboardStore.setState({ taskMasterEnabled: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, list))),
    );
    render(
      <IssuesSection projectId={1} openIssues={2} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    expect(await screen.findByText("Plain issue")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Manual" }));
    expect(screen.getByText("Plain issue")).toBeInTheDocument();
    expect(screen.queryByText("Crash on start")).toBeNull();
    // #2461 — the pick goes to the server, which filters across pages.
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("origin=manual"))).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: "Task Master" }));
    expect(screen.getByText("Crash on start")).toBeInTheDocument();
    expect(screen.queryByText("Plain issue")).toBeNull();
    useDashboardStore.setState({ taskMasterEnabled: wasEnabled });
  });

  it("boxes the description as a card and keeps comments a rule section", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, DETAIL))),
    );
    const { container } = render(<IssueDetailView projectId={1} number={7} onBack={vi.fn()} />);
    expect(await screen.findByText(/crashes/)).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("sb-detail");
    expect(screen.getByRole("button", { name: /^Description/ }).closest("section")).toHaveClass(
      "sb-sec--card",
    );
    expect(screen.getByRole("button", { name: /^Comments/ }).closest("section")).not.toHaveClass(
      "sb-sec--card",
    );
  });

  it("shows comments newest first and folds all but the newest", async () => {
    const user = userEvent.setup();
    const comment = (id: number, body: string) => ({
      ...DETAIL.comments[0],
      id,
      bodyHtml: `<p>${body}</p>`,
      createdAt: `2026-01-0${id}T00:00:00Z`,
    });
    // The server returns them oldest first.
    const detail = {
      ...DETAIL,
      commentCount: 3,
      comments: [comment(1, "first words"), comment(2, "middle words"), comment(3, "last words")],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, detail))),
    );
    render(<IssueDetailView projectId={1} number={7} onBack={vi.fn()} />);
    expect(await screen.findByText("last words")).toBeInTheDocument();
    expect(screen.queryByText("middle words")).toBeNull();
    expect(screen.queryByText("first words")).toBeNull();

    const headers = screen.getAllByRole("button", { name: /bob/ });
    expect(headers.map((h) => h.getAttribute("aria-expanded"))).toEqual(["true", "false", "false"]);
    await user.click(headers[1]);
    expect(screen.getByText("middle words")).toBeInTheDocument();
  });

  it("sorts through the sort popover and refetches with the new sort", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, LIST)));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Sort issues" }));
    expect(screen.getByRole("radio", { name: "Recently updated" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByRole("radio", { name: "Most comments" }));
    // Choosing closes the popover.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(urls.some((u) => u.includes("sort=comments"))).toBe(true);
    });
  });

  it("clears every filter at once, and Escape closes the popover", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, LIST))),
    );
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Filter issues" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Unassigned" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "docs" }));
    expect(screen.getByRole("button", { name: "Filter issues" })).toHaveTextContent("2");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("checkbox", { name: "Unassigned" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "docs" })).not.toBeChecked();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Filter issues" })).toBeNull();
  });

  it("closes the popover on a click outside it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, LIST))),
    );
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Filter issues" }));
    expect(screen.getByRole("dialog", { name: "Filter issues" })).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Search issues"));
    expect(screen.queryByRole("dialog", { name: "Filter issues" })).toBeNull();
  });

  it("does not claim 'no matches' while another page may hold them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { ...LIST, issues: [], hasMore: true })),
    );
    render(
      <IssuesSection projectId={1} openIssues={60} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    expect(await screen.findByText("No matches on this page — load more")).toBeInTheDocument();
  });

  it("reports Task Master availability to the parent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, LIST)));
    const onTaskMaster = vi.fn();
    render(
      <IssuesSection
        projectId={1}
        openIssues={1}
        issuesHidden={false}
        onOpenIssue={vi.fn()}
        onTaskMaster={onTaskMaster}
      />,
    );
    await waitFor(() =>
      expect(onTaskMaster).toHaveBeenCalledWith({ enabled: true, label: "mullion-task" }),
    );
  });

  it("pages with Load more and shows filtered-empty copy", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ...LIST, hasMore: true }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...LIST,
          page: 2,
          issues: [{ ...LIST.issues[0], number: 8, title: "Second page" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <IssuesSection projectId={1} openIssues={2} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second page")).toBeInTheDocument();
    expect(screen.getByText("Crash on start")).toBeInTheDocument();
  });

  it("search returns an issue that was not on the first page", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes("q=deep")
          ? jsonResponse(200, {
              ...LIST,
              issues: [{ ...LIST.issues[0], number: 99, title: "Deep page issue" }],
            })
          : jsonResponse(200, { ...LIST, hasMore: true }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <IssuesSection projectId={1} openIssues={80} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    expect(await screen.findByText("Crash on start")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search issues"), "deep");
    expect(await screen.findByText("Deep page issue")).toBeInTheDocument();
  });

  it("says so when a search stopped early", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { ...LIST, issues: [], truncated: true })),
    );
    render(
      <IssuesSection projectId={1} openIssues={900} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    expect(await screen.findByText(/search stopped early/)).toBeInTheDocument();
  });

  it("explains a hidden issue list and makes no request", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<IssuesSection projectId={1} openIssues={4} issuesHidden onOpenIssue={vi.fn()} />);
    expect(screen.getByText(/can't list issues/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an error when the list fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(502, { message: "nope" })));
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("IssueDetailView", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the sanitized body and comments, and queues for Task Master", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/queue")) {
        expect(init?.method).toBe("POST");
        return Promise.resolve(jsonResponse(200, { queued: true, label: "mullion-task" }));
      }
      if (url.includes("/github/issues/7")) return Promise.resolve(jsonResponse(200, DETAIL));
      return Promise.resolve(jsonResponse(200, LIST));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onBack = vi.fn();
    const { container } = render(
      <IssueDetailView
        projectId={1}
        number={7}
        onBack={onBack}
        taskMaster={{ enabled: true, label: "mullion-task" }}
      />,
    );

    expect(await screen.findByText("crashes")).toBeInTheDocument();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.getByText("same here")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open issue #7 on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/a/b/issues/7",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Queue for Task Master" }));
    expect(await screen.findByText(/Queued — added/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("comments on the issue and links the posted comment (#1672)", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/issues/7/comments")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ body: "on it" });
        return Promise.resolve(
          jsonResponse(200, { id: 2, htmlUrl: "https://github.com/a/b/issues/7#c2" }),
        );
      }
      if (url.includes("/github/issues/7")) return Promise.resolve(jsonResponse(200, DETAIL));
      return Promise.resolve(jsonResponse(200, LIST));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<IssueDetailView projectId={1} number={7} onBack={vi.fn()} />);
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Comment on this issue" }),
      "on it",
    );
    expect(screen.getByText("Posts as @octocat")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText(/Comment posted/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "view on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/a/b/issues/7#c2",
    );
  });

  it("starts a session in a new issue worktree seeded with the issue, and opens it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/actions")) {
          return Promise.resolve(jsonResponse(200, [{ id: "agent:claude", command: "claude" }]));
        }
        if (url.includes("/github/issues/7")) return Promise.resolve(jsonResponse(200, DETAIL));
        return Promise.resolve(jsonResponse(200, { ...LIST, taskMasterEnabled: false }));
      }),
    );
    const createSession = vi.fn().mockResolvedValue({ id: 55 });
    const requestOpenSession = vi.fn();
    useDashboardStore.setState({ createSession, requestOpenSession });

    render(<IssueDetailView projectId={1} number={7} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start session" }));

    await waitFor(() => expect(requestOpenSession).toHaveBeenCalledWith(55));
    const [projectId, command, opts] = createSession.mock.calls[0];
    expect(projectId).toBe(1);
    expect(command).toBe("claude");
    expect(opts.worktree.branchName).toBe("issue-7-crash-on-start");
    expect(opts.seedPrompt).toContain("gh issue view 7");
    expect(screen.queryByRole("button", { name: "Queue for Task Master" })).toBeNull();
  });

  it("surfaces a launcher-less project instead of starting a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/actions")) return Promise.resolve(jsonResponse(200, []));
        if (url.includes("/github/issues/7")) return Promise.resolve(jsonResponse(200, DETAIL));
        return Promise.resolve(jsonResponse(200, LIST));
      }),
    );
    const createSession = vi.fn();
    useDashboardStore.setState({ createSession });
    render(<IssueDetailView projectId={1} number={7} onBack={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/No launcher/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("says when only the first comments were fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          jsonResponse(
            200,
            url.includes("/github/issues/7") ? { ...DETAIL, commentCount: 230 } : LIST,
          ),
        ),
      ),
    );
    render(<IssueDetailView projectId={1} number={7} onBack={vi.fn()} />);
    expect(await screen.findByText("Comments (1 of 230)")).toBeInTheDocument();
    expect(screen.getByText(/Showing the latest 1/)).toBeInTheDocument();
  });

  it("offers Open session instead of Start when the issue's worktree session exists, and shows Queued", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith("/queue") && init?.method === "POST") {
          return Promise.resolve(jsonResponse(200, { queued: true, label: "mullion-task" }));
        }
        if (url.includes("/github/issues/7")) return Promise.resolve(jsonResponse(200, DETAIL));
        return Promise.resolve(jsonResponse(200, LIST));
      }),
    );
    const requestOpenSession = vi.fn();
    useDashboardStore.setState({
      requestOpenSession,
      projects: [makeProject({ id: 1 })],
      sessions: [
        makeSession({
          id: 31,
          projectId: 1,
          name: "issue 7",
          liveBranch: "issue-7-crash-on-start",
        }),
      ],
    });
    render(
      <IssueDetailView
        projectId={1}
        number={7}
        onBack={vi.fn()}
        taskMaster={{ enabled: true, label: "mullion-task" }}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Queue for Task Master" }));
    expect(await screen.findByRole("button", { name: "Queued" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(requestOpenSession).toHaveBeenCalledWith(31);
    useDashboardStore.setState({ sessions: [] });
  });

  it("shows Queued, not an enabled queue button, when a task already tracks the issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(jsonResponse(200, url.includes("/github/issues/7") ? DETAIL : LIST)),
      ),
    );
    useDashboardStore.setState({
      projects: [makeProject({ id: 1 })],
      tasks: [makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "in_progress" })],
    });
    render(
      <IssueDetailView
        projectId={1}
        number={7}
        onBack={vi.fn()}
        taskMaster={{ enabled: true, label: "mullion-task" }}
      />,
    );
    expect(await screen.findByRole("button", { name: "Queued" })).toBeDisabled();
    useDashboardStore.setState({ tasks: [] });
  });

  it("shows Queued on a fresh mount when the detail response carries a task status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          jsonResponse(
            200,
            url.includes("/github/issues/7") ? { ...DETAIL, taskStatus: "queued" } : LIST,
          ),
        ),
      ),
    );
    useDashboardStore.setState({ projects: [makeProject({ id: 1 })], tasks: [] });
    render(
      <IssueDetailView
        projectId={1}
        number={7}
        onBack={vi.fn()}
        taskMaster={{ enabled: true, label: "mullion-task" }}
      />,
    );
    expect(await screen.findByRole("button", { name: "Queued" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Queue for Task Master" })).toBeNull();
  });

  it("shows an error when the issue cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, { message: "gone" })));
    render(<IssueDetailView projectId={1} number={9} onBack={vi.fn()} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("IssueDetailView relations", () => {
  afterEach(() => vi.unstubAllGlobals());

  const serve = (detail: object) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, detail))),
    );

  it("lists sub-issues on their own card and opens one in the sidebar", async () => {
    serve({
      ...DETAIL,
      subIssuesSummary: { total: 2, completed: 1 },
      subIssues: [
        { number: 11, title: "Open child", state: "open" },
        { number: 12, title: "Done child", state: "closed" },
      ],
    });
    const openIssue = vi.fn();
    useDashboardStore.setState({ openRightSidebarIssue: openIssue });
    render(<IssueDetailView projectId={1} number={7} onBack={() => {}} />);

    expect(await screen.findByText("Sub-issues 1/2")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Closed" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /#11\s*Open child/ }));
    expect(openIssue).toHaveBeenCalledWith(1, 11, { kind: "issue", projectId: 1, number: 7 });
  });

  it("lists an issue from another repo without making it openable here", async () => {
    serve({
      ...DETAIL,
      subIssuesSummary: { total: 1, completed: 0 },
      subIssues: [{ number: 5, title: "Sibling work", state: "open", repo: "a/other" }],
    });
    const openIssue = vi.fn();
    useDashboardStore.setState({ openRightSidebarIssue: openIssue });
    render(<IssueDetailView projectId={1} number={7} onBack={() => {}} />);

    expect(await screen.findByText("a/other#5")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sibling work/ })).toBeNull();
    await userEvent.click(screen.getByText("Sibling work"));
    expect(openIssue).not.toHaveBeenCalled();
  });

  it("links a child issue to its parent, and shows nothing for an unrelated issue", async () => {
    serve({ ...DETAIL, parent: { number: 3, title: "The epic", state: "open" } });
    const openIssue = vi.fn();
    useDashboardStore.setState({ openRightSidebarIssue: openIssue });
    const first = render(<IssueDetailView projectId={1} number={7} onBack={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /#3\s*The epic/ }));
    expect(openIssue).toHaveBeenCalledWith(1, 3, { kind: "issue", projectId: 1, number: 7 });
    first.unmount();

    serve(DETAIL);
    render(<IssueDetailView projectId={1} number={8} onBack={() => {}} />);
    await screen.findByText("crashes");
    expect(screen.queryByText(/Sub-issues/)).toBeNull();
    expect(screen.queryByText(/Parent:/)).toBeNull();
  });
});

describe("Issues list ↔ detail round trip", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({ sessions: [] });
  });

  function Harness() {
    const [open, setOpen] = useState<number | null>(null);
    return open === null ? (
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={setOpen} />
    ) : (
      <IssueDetailView projectId={1} number={open} onBack={() => setOpen(null)} />
    );
  }

  it("keeps the search, sort and label filters across drill-in and back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(jsonResponse(200, url.includes("/github/issues/7") ? DETAIL : LIST)),
      ),
    );
    render(<Harness />);
    await userEvent.type(await screen.findByLabelText("Search issues"), "crash");
    await userEvent.click(screen.getByRole("button", { name: "Filter issues" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "docs" }));
    await userEvent.click(screen.getByRole("button", { name: "Sort issues" }));
    await userEvent.click(screen.getByRole("radio", { name: "Most comments" }));
    await userEvent.click(await screen.findByRole("button", { name: /Crash on start/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));

    expect(await screen.findByLabelText("Search issues")).toHaveValue("crash");
    await userEvent.click(screen.getByRole("button", { name: "Filter issues" }));
    expect(screen.getByRole("checkbox", { name: "docs" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Sort issues" }));
    expect(screen.getByRole("radio", { name: "Most comments" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("sends a numeric query (#7) to the server and shows the issue it returns", async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(jsonResponse(200, LIST)));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    await userEvent.type(await screen.findByLabelText("Search issues"), "#7");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("q=%237"))).toBe(true),
    );
    expect(await screen.findByRole("button", { name: /Crash on start/ })).toBeInTheDocument();
  });

  it("starts or queues from the row's hover actions without opening the issue", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/queue") && init?.method === "POST") {
        return Promise.resolve(jsonResponse(200, { queued: true, label: "mullion-task" }));
      }
      if (url.endsWith("/actions")) {
        return Promise.resolve(jsonResponse(200, [{ id: "agent:claude", command: "claude" }]));
      }
      return Promise.resolve(
        jsonResponse(200, {
          ...LIST,
          issues: [{ ...LIST.issues[0], taskStatus: null }],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    let finish: (v: never) => void = () => {};
    const createSession = vi.fn(() => new Promise<never>((res) => (finish = res)));
    const requestOpenSession = vi.fn();
    useDashboardStore.setState({ createSession, requestOpenSession });
    const onOpen = vi.fn();
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={onOpen} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Queue for Task Master" }));
    expect(await screen.findByText("Queued")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Queue for Task Master" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start session" }));
    await userEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(createSession).toHaveBeenCalledTimes(1);
    finish({ id: 56 } as never);
    await waitFor(() => expect(requestOpenSession).toHaveBeenCalledWith(56));
    expect(onOpen).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("shows the existing session on the row and opens it instead of starting another", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, LIST)));
    const requestOpenSession = vi.fn();
    useDashboardStore.setState({
      requestOpenSession,
      projects: [makeProject({ id: 1 })],
      sessions: [
        makeSession({
          id: 31,
          projectId: 1,
          name: "issue 7",
          liveBranch: "issue-7-crash-on-start",
        }),
      ],
    });
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    expect(await screen.findByRole("button", { name: /issue 7/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(requestOpenSession).toHaveBeenCalledWith(31);
  });

  it("shows the task as a bot chip and folds its sessions out of the pills", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, LIST)));
    useDashboardStore.setState({
      projects: [makeProject({ id: 1 })],
      tasks: [
        makeTask({
          id: 4,
          projectId: 1,
          issueNumber: 7,
          status: "in_progress",
          sessionId: 41,
          reviewSessionId: 42,
        }),
      ],
      sessions: [
        makeSession({ id: 41, projectId: 1, name: "task-worker" }),
        makeSession({ id: 42, projectId: 1, name: "task-reviewer" }),
        makeSession({ id: 43, projectId: 1, name: "hand-started", liveBranch: "issue-7-crash" }),
      ],
    });
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    const chip = await screen.findByRole("button", { name: /#4 · in_progress/ });
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.querySelector('[data-testid="task-session-dot"]')).not.toBeNull();
    expect(screen.queryByText("task-worker")).toBeNull();
    expect(screen.queryByText("task-reviewer")).toBeNull();
    expect(screen.getByText("hand-started")).toBeInTheDocument();
    useDashboardStore.setState({ tasks: [], sessions: [] });
  });

  it("gives the taskStatus-only fallback chip the bot badge", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, LIST)));
    useDashboardStore.setState({ projects: [makeProject({ id: 1 })], tasks: [], sessions: [] });
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    const chip = (await screen.findByText(/Task: in_progress/)).closest(".sb-chip--task");
    expect(chip?.querySelector("svg")).not.toBeNull();
  });
});

// The tests below swap store actions for mocks; put the real ones back so a later test
// that exercises the real action (the status strip's) is not handed a leftover mock.
const realStoreActions = {
  claimTask: useDashboardStore.getState().claimTask,
  openRightSidebarTask: useDashboardStore.getState().openRightSidebarTask,
};

describe("Issues with a queued Task Master task but no session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({ tasks: [], sessions: [], ...realStoreActions });
  });

  it("row offers Claim and Open task instead of Start session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, LIST)));
    const claimTask = vi.fn(async () => makeTask({ id: 4 }));
    const openRightSidebarTask = vi.fn();
    useDashboardStore.setState({
      claimTask,
      openRightSidebarTask,
      taskMasterEnabled: true,
      projects: [makeProject({ id: 1 })],
      tasks: [makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "ready" })],
    });
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    await screen.findByText("Crash on start");
    expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Claim task" }));
    expect(claimTask).toHaveBeenCalledWith(4);
    await userEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(openRightSidebarTask).toHaveBeenCalledWith(4);
  });

  it("row has no Claim for a claimed task", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, LIST)));
    useDashboardStore.setState({
      projects: [makeProject({ id: 1 })],
      tasks: [makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "claimed" })],
    });
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    await screen.findByText("Crash on start");
    expect(screen.queryByRole("button", { name: "Claim task" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open task" })).toBeInTheDocument();
  });

  it("detail offers Open task and Claim, and claims through the store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(jsonResponse(200, url.includes("/github/issues/7") ? DETAIL : LIST)),
      ),
    );
    const claimTask = vi.fn(async () => makeTask({ id: 4 }));
    const openRightSidebarTask = vi.fn();
    useDashboardStore.setState({
      claimTask,
      openRightSidebarTask,
      projects: [makeProject({ id: 1 })],
      tasks: [makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "backlog" })],
    });
    render(
      <IssueDetailView
        projectId={1}
        number={7}
        onBack={vi.fn()}
        taskMaster={{ enabled: true, label: "mullion-task" }}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Claim" }));
    expect(claimTask).toHaveBeenCalledWith(4);
    expect(await screen.findByText("Task #4 claimed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open task" }));
    // Selects the task in the sidebar (not the dock), and Back returns to this issue,
    // like the status strip's own "Open task →".
    expect(openRightSidebarTask).toHaveBeenCalledWith(4, {
      kind: "issue",
      projectId: 1,
      number: 7,
    });
  });

  it("detail shows the linked task's status strip, with its actions and a link into the Tasks view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(jsonResponse(200, url.includes("/github/issues/7") ? DETAIL : LIST)),
      ),
    );
    useDashboardStore.setState({
      taskMasterEnabled: true,
      projects: [makeProject({ id: 1 })],
      tasks: [makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "reviewing" })],
    });
    render(<IssueDetailView projectId={1} number={7} onBack={vi.fn()} />);
    const strip = await screen.findByRole("region", { name: "Task" });
    expect(within(strip).getByRole("button", { name: "Approve task" })).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole("button", { name: "Open task →" }));
    const s = useDashboardStore.getState();
    expect(s.selectedTaskId).toBe(4);
    expect(s.sidebarHistory).toEqual([
      { to: { kind: "task", taskId: 4 }, back: { kind: "issue", projectId: 1, number: 7 } },
    ]);
  });

  it("detail shows an error when the claim fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(jsonResponse(200, url.includes("/github/issues/7") ? DETAIL : LIST)),
      ),
    );
    useDashboardStore.setState({
      claimTask: vi.fn(async () => {
        throw new Error("nope");
      }),
      projects: [makeProject({ id: 1 })],
      tasks: [makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "ready" })],
    });
    render(
      <IssueDetailView
        projectId={1}
        number={7}
        onBack={vi.fn()}
        taskMaster={{ enabled: true, label: "mullion-task" }}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Claim" }));
    expect(await screen.findByText("nope")).toBeInTheDocument();
  });
});

// #2461 — the origin filter runs on the server: a match on a later page is
// found, and the section counts every match rather than the open-issue total.
describe("Issues origin filter across pages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({ taskMasterEnabled: false });
  });

  it("counts the server's matches for a pick, the open total without one", async () => {
    useDashboardStore.setState({ taskMasterEnabled: true });
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        jsonResponse(
          200,
          String(input).includes("origin=tm")
            ? { ...LIST, total: 3, hasMore: true }
            : { ...LIST, issues: [] },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <IssuesSection projectId={1} openIssues={40} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    const count = () => container.querySelector(".sb-count")?.textContent;
    await waitFor(() => expect(count()).toBe("40"));
    await userEvent.click(screen.getByRole("button", { name: "Task Master" }));
    expect(await screen.findByText("Crash on start")).toBeInTheDocument();
    expect(count()).toBe("3");
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("drops the pick while Task Master is off: nothing is sent, nothing filtered", async () => {
    useDashboardStore.setState({ taskMasterEnabled: true });
    const fetchMock = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(jsonResponse(200, LIST)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Manual" }));
    unmount();
    useDashboardStore.setState({ taskMasterEnabled: false });
    fetchMock.mockClear();
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    expect(await screen.findByText("Crash on start")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manual" })).toBeNull();
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("origin="))).toBe(true);
  });
});

// #2461 — a task row's quick actions: the task panel's handlers, compact.
describe("Issue row task quick actions", () => {
  const actionsBefore = {
    retryTask: useDashboardStore.getState().retryTask,
    approveTask: useDashboardStore.getState().approveTask,
    reReviewTask: useDashboardStore.getState().reReviewTask,
    requestOpenSession: useDashboardStore.getState().requestOpenSession,
    openRightSidebarTask: useDashboardStore.getState().openRightSidebarTask,
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({ tasks: [], taskMasterEnabled: false, ...actionsBefore });
  });
  const renderWith = (task: ReturnType<typeof makeTask>, extra = {}) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, LIST)));
    useDashboardStore.setState({
      taskMasterEnabled: true,
      projects: [makeProject({ id: 1 })],
      sessions: [],
      tasks: [task],
      ...extra,
    });
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    return screen.findByText("Crash on start");
  };
  const failed = makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "failed" });
  const reviewing = makeTask({
    id: 4,
    projectId: 1,
    issueNumber: 7,
    status: "reviewing",
    lastReviewVerdict: "approved",
    reviewSessionId: 11,
    reviewFindingsIngestedSessionId: 11,
  });

  it("Retry on a failed task; its failure shows in the section", async () => {
    const retryTask = vi.fn().mockRejectedValue(new Error("Branch is gone"));
    await renderWith(failed, { retryTask });
    await userEvent.click(screen.getByRole("button", { name: "Retry task" }));
    expect(retryTask).toHaveBeenCalledWith(4);
    expect(await screen.findByText("Branch is gone")).toBeInTheDocument();
  });

  it("Retry is disabled, and says why, while Task Master is off", async () => {
    await renderWith(failed, { taskMasterEnabled: false });
    expect(screen.getByRole("button", { name: "Retry task — Task Master is off" })).toBeDisabled();
  });

  it("Approve arms first, then approves; Re-review fires directly", async () => {
    const approveTask = vi.fn(async () => reviewing);
    const reReviewTask = vi.fn(async () => reviewing);
    await renderWith(reviewing, { approveTask, reReviewTask });
    await userEvent.click(screen.getByRole("button", { name: "Re-review task" }));
    expect(reReviewTask).toHaveBeenCalledWith(4);
    await userEvent.click(screen.getByTitle("Approve task"));
    expect(approveTask).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /click again to confirm/ }));
    expect(approveTask).toHaveBeenCalledWith(4);
  });

  it("a tracking epic's approval hands over to the task's detail", async () => {
    const { ApiError } = await import("../api/index.js");
    const approveTask = vi
      .fn()
      .mockRejectedValue(
        new ApiError("Epic #9 has 2 open sub-issues", 409, "tracking-epic-with-open-sub-issues"),
      );
    const openRightSidebarTask = vi.fn();
    await renderWith(reviewing, { approveTask, openRightSidebarTask });
    await userEvent.click(screen.getByTitle("Approve task"));
    await userEvent.click(screen.getByRole("button", { name: /click again to confirm/ }));
    await waitFor(() => expect(openRightSidebarTask).toHaveBeenCalledWith(4));
    expect(screen.getByText(/confirm the approval in the task/)).toBeInTheDocument();
  });

  it("no Approve while a workflow change holds the task", async () => {
    await renderWith({
      ...reviewing,
      workflowChange: JSON.stringify({ sha: "abc", files: [".github/x.yml"] }),
    });
    expect(screen.queryByTitle("Approve task")).toBeNull();
    expect(screen.getByRole("button", { name: "Re-review task" })).toBeInTheDocument();
  });

  it("Open session while the task runs", async () => {
    const requestOpenSession = vi.fn();
    await renderWith(
      makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "in_progress", sessionId: 21 }),
      { requestOpenSession },
    );
    await userEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(requestOpenSession).toHaveBeenCalledWith(21);
  });

  it("no Claim on a backlog task (the server only claims a ready one)", async () => {
    await renderWith(makeTask({ id: 4, projectId: 1, issueNumber: 7, status: "backlog" }));
    expect(screen.queryByRole("button", { name: /Claim task/ })).toBeNull();
  });
});
