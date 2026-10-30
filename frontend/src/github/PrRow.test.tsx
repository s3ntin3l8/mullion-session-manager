// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrRow } from "./PrRow.js";
import { api } from "../api/index.js";
import type * as ApiModule from "../api/index.js";
import type { GitHubPROrWithChecks } from "../api/types.js";
import type { MullionLinkEntry } from "../hooks/useMullionLinks.js";
import { useDashboardStore } from "../store/index.js";
import { makeProject, makeSession } from "../test/fixtures.js";

vi.mock("../api/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, createPrPreview: vi.fn() } };
});

const PR = {
  number: 42,
  title: "Fix attention race",
  htmlUrl: "https://github.com/acme/widgets/pull/42",
  author: "a",
  headSha: "abc123",
  headBranch: "fix-attention",
  baseBranch: "main",
  ciStatus: "success",
  actionsRuns: [],
} as unknown as GitHubPROrWithChecks;

const entry = (preview: MullionLinkEntry["preview"]): MullionLinkEntry => ({
  sessions: [],
  task: null,
  taskOwned: false,
  reviewRun: null,
  preview,
  promoteRequest: null,
  devServer: null,
});

describe("PrRow preview action (#2018)", () => {
  beforeEach(() => {
    useDashboardStore.setState({
      projects: [makeProject({ id: 1 })],
      openPreviewRequest: null,
      toasts: [],
    });
  });
  afterEach(() => vi.mocked(api.createPrPreview).mockReset());

  it("starts the PR's preview and opens it in the dock", async () => {
    vi.mocked(api.createPrPreview).mockResolvedValue({ slug: "s42" } as never);
    const onOpen = vi.fn();
    render(<PrRow pr={PR} projectId={1} links={undefined} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "Preview this PR" }));
    await waitFor(() =>
      expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({
        projectId: 1,
        slug: "s42",
        branch: "fix-attention",
      }),
    );
    expect(api.createPrPreview).toHaveBeenCalledWith(1, 42);
    // The action is the row's own, not a click on the row.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("asks again for a known preview, which restarts a dead one", async () => {
    vi.mocked(api.createPrPreview).mockResolvedValue({ slug: "old" } as never);
    const preview = {
      slug: "old",
      kind: "project" as const,
      projectId: 1,
      externalUrl: null,
      createdAt: "",
      branch: "fix-attention",
      upstreamPort: 4000,
    };
    render(<PrRow pr={PR} projectId={1} links={entry(preview)} onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open preview" }));
    await waitFor(() =>
      expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({ slug: "old" }),
    );
    expect(api.createPrPreview).toHaveBeenCalledWith(1, 42);
  });

  it("opens the checkout preview of a checked-out PR head instead of starting another", async () => {
    useDashboardStore.setState({
      projects: [makeProject({ id: 1, devServerUrl: "http://localhost:5173" })],
    });
    const checkout = {
      slug: "checkout",
      kind: "project" as const,
      projectId: 1,
      externalUrl: null,
      createdAt: "",
      branch: "fix-attention",
      upstreamPort: null,
    };
    render(<PrRow pr={PR} projectId={1} links={entry(checkout)} onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Open preview" }));
    expect(useDashboardStore.getState().openPreviewRequest).toMatchObject({ slug: "checkout" });
    expect(api.createPrPreview).not.toHaveBeenCalled();
  });

  it("says why a fork's PR can't be previewed", async () => {
    const { ApiError } = await import("../api/client.js");
    vi.mocked(api.createPrPreview).mockRejectedValue(new ApiError("fork", 409, "fork_unsupported"));
    render(<PrRow pr={PR} projectId={1} links={undefined} onOpen={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Preview this PR" }));
    await waitFor(() =>
      expect(
        useDashboardStore
          .getState()
          .toasts.map((t) => t.message)
          .join(" "),
      ).toMatch(/from a fork isn't supported/),
    );
  });
});

describe("PrRow task vs sessions", () => {
  const link = (id: number, name: string) => ({
    session: makeSession({ id, name }),
    severity: "busy" as const,
    attention: false,
    children: [],
  });

  it("shows a bot-badged task chip and folds the task's sessions out of the pills", () => {
    const links: MullionLinkEntry = {
      ...entry(null),
      task: { id: 5, status: "in_progress", sessionId: 1, reviewSessionId: 2 } as never,
      sessions: [link(1, "worker-sess"), link(2, "reviewer-sess"), link(3, "hand-sess")],
    };
    render(<PrRow pr={PR} projectId={1} links={links} onOpen={vi.fn()} />);
    const chip = screen.getByRole("button", { name: /#5 · in_progress/ });
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.querySelector('[data-testid="task-session-dot"]')).not.toBeNull();
    expect(screen.queryByText("worker-sess")).toBeNull();
    expect(screen.queryByText("reviewer-sess")).toBeNull();
    expect(screen.getByText("hand-sess")).toBeInTheDocument();
  });
});
