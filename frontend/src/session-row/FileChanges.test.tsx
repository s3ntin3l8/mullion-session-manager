// @vitest-environment jsdom
// SessionRow row 4 — file changes (issue #177). Split out of the former
// monolithic SessionRow.test.tsx (PR 27 phase 2, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md) — owns every test that exercises
// the file-change chip strip and its click-to-expand diff (FileChanges.tsx,
// including its own SessionFileDiff). Still mounts the full `<SessionRow>`
// (see GitLine.test.tsx's own header comment for why — same reasoning
// applies here: the interesting behavior under test is
// summarizeFileChanges' derivation from the store's `events` slice, which
// FileChanges.tsx itself never touches, it only receives the already-capped
// array as a prop).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionRow } from "../Sidebar.js";
import {
  api,
  type GitBranchesResult,
  type GitDiffStats,
  type GitHubPRsStatus,
  type GitStatus,
  type NotificationEvent,
  type Project,
  type Session,
  type GitFileDiffResponse,
} from "../api/index.js";
import { makeSession, makeProject } from "../test/fixtures.js";

let events: Record<number, NotificationEvent[]>;
let sessionGitStatuses: Record<number, GitStatus | null>;
let gitDiffStats: Record<number, GitDiffStats | null>;
let gitBranchesByProject: Record<number, GitBranchesResult | undefined>;
let prsByProject: Record<number, GitHubPRsStatus | undefined>;
let sessions: Session[];
const promoteSessionMock = vi.fn().mockResolvedValue(undefined);
const declinePromoteMock = vi.fn().mockResolvedValue(undefined);
const renameSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../store/index.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { sessions: { confirmBeforeKill: false } },
      theme: "dark",
      events,
      sessionGitStatuses,
      gitDiffStats,
      gitBranchesByProject,
      prsByProject,
      sessions,
      promoteSession: promoteSessionMock,
      declinePromote: declinePromoteMock,
      renameSession: renameSessionMock,
    }),
}));

const PROJECT: Project = makeProject();

beforeEach(() => {
  events = {};
  sessionGitStatuses = {};
  gitDiffStats = {};
  gitBranchesByProject = {};
  prsByProject = {};
  sessions = [];
  localStorage.clear();
});

describe("SessionRow row 4 — file changes (issue #177)", () => {
  it("renders no strip when the session has no file_change events", () => {
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-file-changes-line")).toBeNull();
  });

  it("renders no strip for a session with only non-file_change events", () => {
    events = {
      1: [{ seq: 1, sessionId: 1, kind: "title_change", ts: Date.now(), payload: { title: "x" } }],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    expect(container.querySelector(".session-file-changes-line")).toBeNull();
  });

  it("renders one chip per distinct path, most-recently-changed first", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
        {
          seq: 2,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/b.ts", action: "create" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chips = container.querySelectorAll(".session-file-change-chip");
    expect(chips).toHaveLength(2);
    // seq 2 (b.ts) is more recent than seq 1 (a.ts) -> shown first.
    expect(chips[0].querySelector(".session-file-change-name")?.textContent).toBe("b.ts");
    expect(chips[0].querySelector(".session-file-change-letter")?.textContent).toBe("A");
    expect(chips[0].querySelector(".github-panel-ci-dot")?.classList.contains("good")).toBe(true);
    expect(chips[1].querySelector(".session-file-change-name")?.textContent).toBe("a.ts");
    expect(chips[1].querySelector(".session-file-change-letter")?.textContent).toBe("M");
    expect(chips[1].querySelector(".github-panel-ci-dot")?.classList.contains("pending")).toBe(
      true,
    );
  });

  it("collapses repeated events for the same path into one chip with the latest action", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "create" },
        },
        {
          seq: 2,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
        {
          seq: 3,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chips = container.querySelectorAll(".session-file-change-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0].querySelector(".session-file-change-letter")?.textContent).toBe("M");
  });

  it("shows the D badge for a deleted file", () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/gone.ts", action: "delete" },
        },
      ],
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chip = container.querySelector(".session-file-change-chip");
    expect(chip?.querySelector(".session-file-change-letter")?.textContent).toBe("D");
    expect(chip?.querySelector(".github-panel-ci-dot")?.classList.contains("bad")).toBe(true);
  });

  it("caps the number of chips shown at 5, keeping the most recent", () => {
    events = {
      1: Array.from({ length: 7 }, (_, i) => ({
        seq: i + 1,
        sessionId: 1,
        kind: "file_change" as const,
        ts: Date.now(),
        payload: { path: `src/file-${i}.ts`, action: "modify" as const },
      })),
    };
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );
    const chips = container.querySelectorAll(".session-file-change-chip");
    expect(chips).toHaveLength(5);
    // Most recent 5 of 7 -> file-2 through file-6.
    expect(chips[0].querySelector(".session-file-change-name")?.textContent).toBe("file-6.ts");
    expect(chips[4].querySelector(".session-file-change-name")?.textContent).toBe("file-2.ts");
  });

  it("expands a minimal path + action + count detail on click, and collapses on a second click", async () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
        {
          seq: 2,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={vi.fn()} onEnd={vi.fn()} />,
    );

    expect(container.querySelector(".session-file-change-detail")).toBeNull();

    await user.click(container.querySelector(".session-file-change-chip")!);
    const detail = container.querySelector(".session-file-change-detail");
    expect(detail?.querySelector(".session-file-change-detail-path")?.textContent).toBe("src/a.ts");
    expect(detail?.querySelector(".session-file-change-detail-meta")?.textContent).toBe(
      "M · 2 changes",
    );

    await user.click(container.querySelector(".session-file-change-chip")!);
    expect(container.querySelector(".session-file-change-detail")).toBeNull();
  });

  it("clicking a chip does not fire onOpen", async () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow session={makeSession({})} project={PROJECT} onOpen={onOpen} onEnd={vi.fn()} />,
    );

    await user.click(container.querySelector(".session-file-change-chip")!);

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders a loading spinner while the diff is loading, and then renders formatted diff lines when resolved", async () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    let resolveDiffPromise!: (value: GitFileDiffResponse) => void;
    const diffPromise = new Promise<GitFileDiffResponse>((resolve) => {
      resolveDiffPromise = resolve;
    });
    const spy = vi.spyOn(api, "getSessionGitFileDiff").mockReturnValue(diffPromise);

    const user = userEvent.setup();
    const { container } = render(
      <SessionRow
        session={makeSession({ id: 1 })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );

    const chip = container.querySelector(".session-file-change-chip")!;
    await user.click(chip);

    // spinner is shown
    expect(container.querySelector(".session-diff-spinner")?.textContent).toBe("…");
    expect(spy).toHaveBeenCalledWith(1, "src/a.ts");

    // resolve mock API response
    await act(async () => {
      resolveDiffPromise({
        patch: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,2 +1,3 @@",
          " unchanged context",
          "-deleted line",
          "+added line",
        ].join("\n"),
      });
    });

    // diff lines are rendered with the correct classes
    expect(container.querySelector(".session-diff-spinner")).toBeNull();
    const lines = container.querySelectorAll(".session-diff-line");
    expect(lines).toHaveLength(7);
    expect(lines[0].classList.contains("session-diff-file")).toBe(true);
    expect(lines[1].classList.contains("session-diff-file")).toBe(true);
    expect(lines[2].classList.contains("session-diff-file")).toBe(true);
    expect(lines[3].classList.contains("session-diff-hunk")).toBe(true);
    expect(lines[4].classList.contains("session-diff-context")).toBe(true);
    expect(lines[5].classList.contains("session-diff-del")).toBe(true);
    expect(lines[6].classList.contains("session-diff-add")).toBe(true);

    spy.mockRestore();
  });

  it("shows 'No changes' message if API returns no changes (null patch)", async () => {
    events = {
      1: [
        {
          seq: 1,
          sessionId: 1,
          kind: "file_change",
          ts: Date.now(),
          payload: { path: "src/a.ts", action: "modify" },
        },
      ],
    };
    const spy = vi.spyOn(api, "getSessionGitFileDiff").mockResolvedValue({ patch: null });
    const user = userEvent.setup();
    const { container } = render(
      <SessionRow
        session={makeSession({ id: 1 })}
        project={PROJECT}
        onOpen={vi.fn()}
        onEnd={vi.fn()}
      />,
    );

    const chip = container.querySelector(".session-file-change-chip")!;
    await user.click(chip);

    // wait for render
    await screen.findByText("No changes");
    expect(container.querySelector(".session-diff-empty")).toBeTruthy();

    spy.mockRestore();
  });
});
