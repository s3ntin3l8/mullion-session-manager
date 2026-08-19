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

// Wraps every render in the real dockview DOM nesting (see the "observes
// the real header row" test's own comment for the source-verified shape) —
// the component's own ResizeObserver effect no-ops (`closest()` finds
// nothing) without a `.dv-tabs-and-actions-container` ancestor, so any test
// that wants resizeCallback to actually do something needs this, not a bare
// `render(<PaneHeaderActions .../>)`.
function renderInHeader(props: IDockviewHeaderActionsProps) {
  return render(
    <div className="dv-tabs-and-actions-container">
      <div className="dv-right-actions-container">
        <div className="dv-react-part">
          <PaneHeaderActions {...props} />
        </div>
      </div>
    </div>,
  );
}

// Captures the observer's callback (to simulate a live resize of the header
// row, same pattern as PaneTab.test.tsx's own tight-mode resize test) AND
// the element `.observe()` was actually called with — the latter is what
// the "observes the real header row" test below needs: independent review
// (PR #709) found the first version of this component observed the wrong
// element (a shrink-to-fit wrapper dockview-react inserts, not the header
// row), which every OTHER test in this file — all of which invoke
// resizeCallback directly, bypassing whatever element was actually observed
// — would have kept passing right through.
let resizeCallback: ResizeObserverCallback = () => {};
let observedElement: Element | null = null;

beforeEach(() => {
  requestSplit.mockClear();
  observedElement = null;
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
      resizeCallback = callback;
      return {
        observe: vi.fn((el: Element) => {
          observedElement = el;
        }),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }),
  );
});

describe("PaneHeaderActions", () => {
  it("renders nothing when there's no active panel", () => {
    const { container } = render(<PaneHeaderActions {...makeProps({ activePanel: undefined })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("calls requestSplit with the active panel's id and the clicked direction", async () => {
    renderInHeader(makeProps());

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
    renderInHeader(makeProps());
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

  // Independent code review (PR #709) — verified against the real
  // dockview-core/dockview-react source (tabsContainer.js's
  // setRightActionsElement / dockview-react's `.dv-react-part` wrapper):
  // dockview mounts this component several levels deep,
  // .dv-tabs-and-actions-container > ... > .dv-right-actions-container >
  // .dv-react-part > (this component's own root), and neither
  // .dv-right-actions-container nor .dv-react-part has any flex-grow of its
  // own — both are shrink-to-fit around this component's two buttons, same
  // as the component's own root span. Reproduces that real nesting (rather
  // than the flat single-parent shape the other tests in this file use) to
  // prove the fix actually walks up to the true header row instead of
  // stopping at one of those shrink-to-fit wrappers.
  it("observes the real header row (.dv-tabs-and-actions-container), not a shrink-to-fit wrapper", () => {
    renderInHeader(makeProps());

    expect(observedElement).not.toBeNull();
    expect(observedElement).toHaveClass("dv-tabs-and-actions-container");
  });

  it("shows the split buttons again once the header widens back out", () => {
    renderInHeader(makeProps());

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
