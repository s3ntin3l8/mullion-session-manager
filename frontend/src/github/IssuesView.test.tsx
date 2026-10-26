// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  state: "open",
  bodyHtml: '<p>It <b>crashes</b></p><img src=x onerror="boom()">',
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

    await userEvent.click(screen.getByRole("button", { name: "docs" }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(urls.some((u) => u.includes("labels=docs"))).toBe(true);
    });

    await userEvent.click(screen.getByRole("button", { name: /Crash on start/ }));
    expect(onOpen).toHaveBeenCalledWith(7);
  });

  it("sorts through the app's themed dropdown and refetches with the new sort", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, LIST)));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <IssuesSection projectId={1} openIssues={1} issuesHidden={false} onOpenIssue={vi.fn()} />,
    );
    const sort = await screen.findByLabelText("Sort issues");
    expect(sort.closest(".settings-dropdown.small")).not.toBeNull();
    await userEvent.selectOptions(sort, "comments");
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(urls.some((u) => u.includes("sort=comments"))).toBe(true);
    });
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
    expect(screen.getByText(/Showing the first 1/)).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "docs" }));
    await userEvent.selectOptions(screen.getByLabelText("Sort issues"), "comments");
    await userEvent.click(await screen.findByRole("button", { name: /Crash on start/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));

    expect(await screen.findByLabelText("Search issues")).toHaveValue("crash");
    expect(screen.getByRole("button", { name: "docs" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Sort issues")).toHaveValue("comments");
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
});
