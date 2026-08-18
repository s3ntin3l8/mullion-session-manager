// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaneHeaderActions } from "./PaneHeaderActions.js";
import type { IDockviewHeaderActionsProps } from "dockview";

// PaneHeaderActions only reads `requestSplit` off the store.
const requestSplit = vi.fn();

vi.mock("./store/index.js", () => {
  const useDashboardStore = (selector: (s: unknown) => unknown) => selector({ requestSplit });
  return { useDashboardStore };
});

function makeProps(overrides: { activePanel?: { id: string } | undefined } = {}) {
  return {
    api: {},
    containerApi: {},
    panels: [],
    activePanel: "activePanel" in overrides ? overrides.activePanel : { id: "session-1" },
    isGroupActive: true,
    group: {},
    headerPosition: "top",
  } as unknown as IDockviewHeaderActionsProps;
}

// Captures the observer's callback so a test can simulate a live resize of
// the header row (this component's own immediate parent, per its own
// comment) — same pattern as PaneTab.test.tsx's own tight-mode resize test.
let resizeCallback: ResizeObserverCallback = () => {};

beforeEach(() => {
  requestSplit.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
      resizeCallback = callback;
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
});

describe("PaneHeaderActions", () => {
  it("renders nothing when there's no active panel", () => {
    const { container } = render(<PaneHeaderActions {...makeProps({ activePanel: undefined })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("calls requestSplit with the active panel's id and the clicked direction", async () => {
    render(<PaneHeaderActions {...makeProps()} />);

    await userEvent.click(screen.getByTitle("Split right"));
    expect(requestSplit).toHaveBeenCalledWith("session-1", "right");

    await userEvent.click(screen.getByTitle("Split down"));
    expect(requestSplit).toHaveBeenCalledWith("session-1", "below");
  });

  // Issue: narrow headers overflow — below HIDE_SPLIT_ACTIONS_BELOW_GROUP_
  // WIDTH_PX (PaneHeaderActions.tsx), these buttons hide entirely so the tab
  // strip's own more essential content isn't squeezed further by them; split
  // stays reachable via each tab's own kebab menu (PaneActionsMenu.test.tsx
  // covers that fallback).
  it("hides both split buttons once the header row narrows below the threshold", () => {
    render(<PaneHeaderActions {...makeProps()} />);
    expect(screen.getByTitle("Split right")).toBeInTheDocument();
    expect(screen.getByTitle("Split down")).toBeInTheDocument();

    act(() => {
      resizeCallback(
        [{ contentRect: { width: 150 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    expect(screen.queryByTitle("Split right")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Split down")).not.toBeInTheDocument();
  });

  it("shows the split buttons again once the header widens back out", () => {
    render(<PaneHeaderActions {...makeProps()} />);

    act(() => {
      resizeCallback(
        [{ contentRect: { width: 150 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(screen.queryByTitle("Split right")).not.toBeInTheDocument();

    act(() => {
      resizeCallback(
        [{ contentRect: { width: 300 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(screen.getByTitle("Split right")).toBeInTheDocument();
    expect(screen.getByTitle("Split down")).toBeInTheDocument();
  });
});
