// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IssueDetailView, IssuesSection } from "./IssuesView.js";
import { issueBranchName, issueSeedPrompt } from "./issueWork.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";

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
    expect(screen.getByText("💬 3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "docs" }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
      expect(urls.some((u) => u.includes("labels=docs"))).toBe(true);
    });

    await userEvent.click(screen.getByRole("button", { name: /Crash on start/ }));
    expect(onOpen).toHaveBeenCalledWith(7);
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
    const { container } = render(<IssueDetailView projectId={1} number={7} onBack={onBack} />);

    expect(await screen.findByText("crashes")).toBeInTheDocument();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.getByText("same here")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/a/b/issues/7",
    );

    await userEvent.click(await screen.findByRole("button", { name: "Queue for Task Master" }));
    expect(await screen.findByText(/Queued/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(onBack).toHaveBeenCalled();
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

  it("shows an error when the issue cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, { message: "gone" })));
    render(<IssueDetailView projectId={1} number={9} onBack={vi.fn()} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
