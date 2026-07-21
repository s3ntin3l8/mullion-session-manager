// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaneTab } from "./PaneTab.js";
import type { Session } from "./api.js";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import type { TerminalPaneParams } from "./TerminalPane.js";

// PaneTab only reads sessions/renameSession/deleteSession/theme/
// settings.sessions.confirmBeforeKill off the store — mirrors
// SessionRow.test.tsx's minimal selector-based mock rather than hydrating
// the real store.
let session: Session;
vi.mock("./store.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) =>
    selector({
      sessions: [session],
      renameSession: vi.fn(),
      deleteSession: vi.fn(),
      theme: "dark",
      settings: { sessions: { confirmBeforeKill: false } },
    }),
}));

function makeProps(): IDockviewPanelHeaderProps<TerminalPaneParams> {
  return {
    api: { title: "claude code", setTitle: vi.fn(), close: vi.fn() },
    params: { sessionId: session.id },
  } as unknown as IDockviewPanelHeaderProps<TerminalPaneParams>;
}

const BASE_SESSION: Session = {
  id: 1,
  projectId: 1,
  name: "claude code",
  nameLocked: true,
  command: "claude code",
  cwd: null,
  kind: "terminal",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastAttachedAt: "2026-01-01T00:00:00.000Z",
  alive: true,
  subscriberCount: 1,
  activity: "idle",
  lastActivityAt: Date.now(),
  attention: false,
  attentionAt: null,
  lastTitle: null,
};

// jsdom's ResizeObserver doesn't exist; PaneTab only needs observe/disconnect
// to not throw — the mount-time callback-ref measurement (not this observer)
// is what these tests exercise.
beforeEach(() => {
  session = { ...BASE_SESSION };
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PaneTab", () => {
  it("shows the status badge when the tab mounts at or above the narrow threshold", () => {
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 250,
    } as DOMRect);

    render(<PaneTab {...makeProps()} />);

    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("hides the status badge when the tab mounts already narrower than the threshold", () => {
    // Regression check for the callback-ref fix: without it, `narrow` starts
    // false and the badge would render for one frame before the
    // ResizeObserver (which never fires in this test) corrected it.
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
    } as DOMRect);

    render(<PaneTab {...makeProps()} />);

    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
  });

  it("still shows the status dot when narrow, just not the badge", () => {
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
    } as DOMRect);

    const { container } = render(<PaneTab {...makeProps()} />);

    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    expect(container.querySelector(".pane-tab-dot-idle")).toBeInTheDocument();
  });
});
