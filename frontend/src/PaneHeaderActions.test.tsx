// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
// the component's own ResizeObserver setup no-ops (`closest()` finds
// nothing) without a `.dv-tabs-and-actions-container` ancestor, so any test
// that wants resizeCallback to actually do something needs this, not a bare
// `render(<PaneHeaderActions .../>)`. Exposed as its own function (rather
// than folded into renderInHeader below) so the deferred-mount test can pass
// it straight to RTL's own `rerender` with updated props on the same tree.
function headerTree(props: IDockviewHeaderActionsProps) {
  return (
    <div className="dv-tabs-and-actions-container">
      <div className="dv-right-actions-container">
        <div className="dv-react-part">
          <PaneHeaderActions {...props} />
        </div>
      </div>
    </div>
  );
}

function renderInHeader(props: IDockviewHeaderActionsProps) {
  return render(headerTree(props));
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
  // setSpanRef's own synchronous getBoundingClientRect() read (Hermes
  // review, PR #709 — avoids a one-frame flash of the buttons on a group
  // that mounts already narrower than the threshold) would otherwise read
  // jsdom's real, un-stubbed getBoundingClientRect() — always {width: 0}
  // — and hide the buttons on every single mount by default, well before
  // any test gets to simulate a real resize. Same fixture value PaneTab.
  // test.tsx's own beforeEach uses for the identical reason (its narrow-tab
  // threshold's own synchronous measure).
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 300,
  } as DOMRect);
});

// Hermes review, PR #709 — test hygiene: this file re-stubs ResizeObserver
// fresh in every beforeEach, and jsdom's environment resets between test
// files, so a missing unstub here was harmless in practice — restored
// anyway to match the repo's usual stub/unstub pairing and stop this file
// from being the exception if it ever grows a test that relies on the real
// global.
afterEach(() => {
  vi.unstubAllGlobals();
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

  // Hermes review, PR #709 — the component's own `!props.activePanel`
  // early return means the span (and this ResizeObserver setup) doesn't
  // necessarily exist on this component's very first render. A plain ref +
  // `useEffect(..., [])` only gets one chance to attach an observer, at
  // that first render — if the group briefly has no active panel when this
  // component first mounts (e.g. a race while dockview is still assembling
  // the group), the span never renders on that pass, the effect no-ops
  // forever, and later renders where activePanel finally arrives get NO
  // observer at all: the buttons would stay visible regardless of actual
  // width. The fix (a callback ref) must attach exactly when the span
  // itself first appears in the DOM, however many renders that takes.
  it("still hides on narrow once activePanel arrives after mounting with none", () => {
    const { rerender } = render(headerTree(makeProps({ activePanel: undefined })));
    expect(screen.queryByTitle("Split right")).not.toBeInTheDocument();

    rerender(headerTree(makeProps()));
    expect(screen.getByTitle("Split right")).toBeInTheDocument();

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
