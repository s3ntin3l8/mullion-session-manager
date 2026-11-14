// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BottomSheet } from "./BottomSheet.js";
import { resetPhoneBackStackForTests } from "../hooks/usePhoneBackStack.js";

let theme = "dark";
vi.mock("../store/index.js", () => {
  const state = {
    get theme() {
      return theme;
    },
  };
  const useDashboardStore = (selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state;
  return { useDashboardStore };
});

beforeEach(() => {
  theme = "dark";
  resetPhoneBackStackForTests();
});

afterEach(() => {
  resetPhoneBackStackForTests();
});

// Issue #1435 — the shared shell MobileSessionSwitcher/CopyModeSheet/
// NotificationBell's phone branch/TasksToolbar's phone filter sheet build
// on. Each of THOSE components' own tests is the no-regression proof for
// the specific prop combination it uses; this file exercises BottomSheet's
// own contract in isolation.
describe("BottomSheet", () => {
  it("renders nothing while closed, and a labeled dialog while open", () => {
    const { rerender } = render(
      <BottomSheet open={false} onClose={vi.fn()} label="Example" closeLabel="Close" title="Title">
        body
      </BottomSheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(
      <BottomSheet open={true} onClose={vi.fn()} label="Example" closeLabel="Close" title="Title">
        body
      </BottomSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Example" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("renders headerActions in the same trailing group as the close button", () => {
    render(
      <BottomSheet
        open={true}
        onClose={vi.fn()}
        label="Example"
        closeLabel="Close"
        title="Title"
        headerActions={<button>Extra</button>}
      >
        body
      </BottomSheet>,
    );
    const extra = screen.getByRole("button", { name: "Extra" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(extra.parentElement).toBe(close.parentElement);
    expect(extra.parentElement).toHaveClass("mobile-session-sheet-header-actions");
  });

  it("closes on a backdrop click by default, not on a click inside the sheet", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BottomSheet open={true} onClose={onClose} label="Example" closeLabel="Close" title="Title">
        <button>Inside</button>
      </BottomSheet>,
    );
    await user.click(screen.getByRole("button", { name: "Inside" }));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(document.querySelector(".mobile-session-backdrop") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("press-release backdropClose only closes on a press AND release both landing on the backdrop", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet
        open={true}
        onClose={onClose}
        label="Example"
        closeLabel="Close"
        title="Title"
        backdropClose="press-release"
      >
        <button>Inside</button>
      </BottomSheet>,
    );
    const backdrop = document.querySelector(".mobile-session-backdrop") as HTMLElement;

    // A drag that starts inside and ends on the backdrop must not close.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Inside" }));
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape by default", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BottomSheet open={true} onClose={onClose} label="Example" closeLabel="Close" title="Title">
        body
      </BottomSheet>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("onEscape returning true intercepts Escape and skips the default close", async () => {
    const onClose = vi.fn();
    const onEscape = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <BottomSheet
        open={true}
        onClose={onClose}
        label="Example"
        closeLabel="Close"
        title="Title"
        onEscape={onEscape}
      >
        body
      </BottomSheet>,
    );
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("onEscape returning false falls through to the default close", async () => {
    const onClose = vi.fn();
    const onEscape = vi.fn(() => false);
    const user = userEvent.setup();
    render(
      <BottomSheet
        open={true}
        onClose={onClose}
        label="Example"
        closeLabel="Close"
        title="Title"
        onEscape={onEscape}
      >
        body
      </BottomSheet>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("portals to document.body and carries the theme class by default", () => {
    theme = "light";
    const { container } = render(
      <BottomSheet open={true} onClose={vi.fn()} label="Example" closeLabel="Close" title="Title">
        body
      </BottomSheet>,
    );
    expect(container.querySelector(".mobile-session-backdrop")).toBeNull();
    const backdrop = document.querySelector(".mobile-session-backdrop") as HTMLElement;
    expect(backdrop.parentElement).toBe(document.body);
    expect(backdrop).toHaveClass("cmux-root", "light");
  });

  it("renders inline with no theme wrapper when portal is false", () => {
    theme = "light";
    const { container } = render(
      <BottomSheet
        open={true}
        onClose={vi.fn()}
        label="Example"
        closeLabel="Close"
        title="Title"
        portal={false}
      >
        body
      </BottomSheet>,
    );
    const backdrop = container.querySelector(".mobile-session-backdrop") as HTMLElement;
    expect(backdrop).not.toBeNull();
    expect(backdrop).not.toHaveClass("cmux-root");
  });

  it("appends backdropClassName/sheetClassName alongside the shared base classes", () => {
    render(
      <BottomSheet
        open={true}
        onClose={vi.fn()}
        label="Example"
        closeLabel="Close"
        title="Title"
        backdropClassName="my-backdrop"
        sheetClassName="my-sheet"
      >
        body
      </BottomSheet>,
    );
    expect(document.querySelector(".mobile-session-backdrop.my-backdrop")).not.toBeNull();
    expect(document.querySelector(".mobile-session-sheet.my-sheet")).not.toBeNull();
  });

  it("moves focus into the sheet on open, and to initialFocusRef when given", () => {
    function WithInitialFocus() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <BottomSheet
          open={true}
          onClose={vi.fn()}
          label="Example"
          closeLabel="Close"
          title="Title"
          initialFocusRef={inputRef}
        >
          <input ref={inputRef} aria-label="target" />
        </BottomSheet>
      );
    }
    render(<WithInitialFocus />);
    expect(screen.getByLabelText("target")).toHaveFocus();
  });

  it("registers with the phone back-stack only when backStack is true", () => {
    const pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    const { rerender } = render(
      <BottomSheet open={true} onClose={vi.fn()} label="Example" closeLabel="Close" title="Title">
        body
      </BottomSheet>,
    );
    expect(pushState).not.toHaveBeenCalled();

    rerender(
      <BottomSheet
        open={true}
        onClose={vi.fn()}
        label="Example"
        closeLabel="Close"
        title="Title"
        backStack
      >
        body
      </BottomSheet>,
    );
    expect(pushState).toHaveBeenCalledTimes(1);
    pushState.mockRestore();
  });

  it("android back closes the sheet when backStack is true", () => {
    vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    const onClose = vi.fn();
    render(
      <BottomSheet
        open={true}
        onClose={onClose}
        label="Example"
        closeLabel="Close"
        title="Title"
        backStack
      >
        body
      </BottomSheet>,
    );
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("writes its own suppressRestore into suppressRestoreRef while open", () => {
    const ref = { current: null as (() => void) | null };
    const { rerender } = render(
      <BottomSheet
        open={false}
        onClose={vi.fn()}
        label="Example"
        closeLabel="Close"
        title="Title"
        suppressRestoreRef={ref}
      >
        body
      </BottomSheet>,
    );
    expect(ref.current).not.toBeNull();

    rerender(
      <BottomSheet
        open={true}
        onClose={vi.fn()}
        label="Example"
        closeLabel="Close"
        title="Title"
        suppressRestoreRef={ref}
      >
        body
      </BottomSheet>,
    );
    expect(() => ref.current?.()).not.toThrow();
  });

  // Hermes review on #1454 — the test above only proved the ref gets
  // written, not that calling it actually does what NotificationBell's own
  // row tap relies on: without it, closing the sheet snaps focus back to
  // whatever triggered it (this trap's own restore-on-close), undoing
  // whatever the caller's close action just focused instead (the newly
  // opened session's terminal, here stood in for by `elsewhere`).
  it("suppressRestoreRef actually prevents the restore-on-close focus snap-back", async () => {
    const ref = { current: null as (() => void) | null };
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button>Trigger</button>
          <input aria-label="elsewhere" />
          <BottomSheet
            open={open}
            onClose={vi.fn()}
            label="Example"
            closeLabel="Close"
            title="Title"
            suppressRestoreRef={ref}
          >
            body
          </BottomSheet>
        </>
      );
    }
    const user = userEvent.setup();
    const { rerender } = render(<Harness open={false} />);
    await user.click(screen.getByRole("button", { name: "Trigger" }));
    expect(screen.getByRole("button", { name: "Trigger" })).toHaveFocus();

    rerender(<Harness open={true} />);
    // The trap moved focus into the sheet on open — same restore-on-close
    // baseline every other caller gets.
    expect(screen.getByRole("button", { name: "Trigger" })).not.toHaveFocus();

    // The caller's own action: move focus elsewhere, suppress this trap's
    // restore, THEN close.
    screen.getByLabelText("elsewhere").focus();
    ref.current?.();
    rerender(<Harness open={false} />);

    expect(screen.getByLabelText("elsewhere")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Trigger" })).not.toHaveFocus();
  });
});

// Issue #3008 — the sheet moves on the house spring. jsdom has no layout, so
// these tests give the sheet one (a 400px travel from its top edge to the
// bottom of the backdrop) and drive requestAnimationFrame by hand: no real
// timers, and no assertion on how long anything takes.
describe("BottomSheet motion", () => {
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let nextFrame: number;
  let reduceMotion: boolean;

  function frame(ms = 16) {
    now += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of callbacks) callback(now);
    });
  }

  function runToRest() {
    for (let i = 0; i < 1000 && frames.size > 0; i++) frame();
  }

  beforeEach(() => {
    frames = new Map();
    now = 0;
    nextFrame = 1;
    reduceMotion = false;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: reduceMotion && query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(400);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function Sheet({ open, onClose = () => {} }: { open: boolean; onClose?: () => void }) {
    return (
      <BottomSheet open={open} onClose={onClose} label="Example" closeLabel="Close" title="Title">
        body
      </BottomSheet>
    );
  }

  const sheet = () => document.querySelector(".mobile-session-sheet") as HTMLElement;
  const backdrop = () => document.querySelector(".mobile-session-backdrop") as HTMLElement;
  const header = () => document.querySelector(".mobile-session-sheet-header") as HTMLElement;
  const offset = () => {
    const match = /translateY\((-?[\d.]+)px\)/.exec(sheet().style.transform);
    return match ? Number(match[1]) : 0;
  };

  // jsdom has no PointerEvent; a MouseEvent of the pointer type carries
  // clientY, and the pointer fields are set on the instance. timeStamp is set
  // too, so the release velocity never reads a real clock.
  function pointer(
    target: Element,
    type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    clientY: number,
    time: number,
  ) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    Object.defineProperty(event, "timeStamp", { value: time });
    act(() => void target.dispatchEvent(event));
  }

  it("enters from the bottom edge and comes to rest in place", () => {
    render(<Sheet open={true} />);
    expect(offset()).toBe(400);
    frame();
    frame();
    expect(offset()).toBeGreaterThan(0);
    expect(offset()).toBeLessThan(400);
    runToRest();
    // At rest the inline styles are gone again.
    expect(sheet().style.transform).toBe("");
    expect(backdrop().style.opacity).toBe("");
  });

  it("leaves the way it came, unreachable while it goes, then unmounts", () => {
    const { rerender } = render(<Sheet open={true} />);
    runToRest();
    rerender(<Sheet open={false} />);
    // Still on screen for the exit, but no longer a dialog anyone can reach.
    expect(sheet()).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backdrop()).toHaveAttribute("aria-hidden", "true");
    expect(backdrop()).toHaveAttribute("inert");
    frame();
    frame();
    expect(offset()).toBeGreaterThan(0);
    runToRest();
    expect(document.querySelector(".mobile-session-sheet")).toBeNull();
  });

  it("reverses a sheet that is leaving without starting over", () => {
    const { rerender } = render(<Sheet open={true} />);
    runToRest();
    rerender(<Sheet open={false} />);
    for (let i = 0; i < 4; i++) frame();
    const leaving = sheet();
    const where = offset();
    expect(where).toBeGreaterThan(0);

    rerender(<Sheet open={true} />);
    // Same element, same place: it turns around rather than jumping to the edge.
    expect(sheet()).toBe(leaving);
    expect(offset()).toBe(where);
    runToRest();
    expect(sheet().style.transform).toBe("");
    expect(screen.getByRole("dialog", { name: "Example" })).toBeInTheDocument();
  });

  it("follows a finger on the header and springs back from a short, slow drag", () => {
    const onClose = vi.fn();
    render(<Sheet open={true} onClose={onClose} />);
    runToRest();
    pointer(header(), "pointerdown", 100, 1000);
    pointer(header(), "pointermove", 160, 1100);
    pointer(header(), "pointermove", 200, 1200);
    expect(offset()).toBe(100);
    // Lifted after resting: no speed to hand over, and 100px is short of half.
    pointer(header(), "pointerup", 200, 1500);
    expect(onClose).not.toHaveBeenCalled();
    runToRest();
    expect(sheet().style.transform).toBe("");
  });

  it("dismisses a short drag that is thrown, decided by where it is heading", () => {
    const onClose = vi.fn();
    render(<Sheet open={true} onClose={onClose} />);
    runToRest();
    pointer(header(), "pointerdown", 100, 1000);
    pointer(header(), "pointermove", 130, 1016);
    pointer(header(), "pointermove", 160, 1032);
    // Only 60px down, but moving fast when it lifted.
    pointer(header(), "pointerup", 160, 1040);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses a slow drag that went past half the travel", () => {
    const onClose = vi.fn();
    render(<Sheet open={true} onClose={onClose} />);
    runToRest();
    pointer(header(), "pointerdown", 100, 1000);
    pointer(header(), "pointermove", 350, 1400);
    pointer(header(), "pointerup", 350, 2000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("carries a throw on out when the caller closes it", () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return <Sheet open={open} onClose={() => setOpen(false)} />;
    }
    render(<Harness />);
    runToRest();
    pointer(header(), "pointerdown", 100, 1000);
    pointer(header(), "pointermove", 130, 1016);
    pointer(header(), "pointermove", 160, 1032);
    pointer(header(), "pointerup", 160, 1040);
    frame();
    // Still moving down from where the finger let go, not snapping back first.
    expect(offset()).toBeGreaterThan(60);
    runToRest();
    expect(document.querySelector(".mobile-session-sheet")).toBeNull();
  });

  it("resists a drag upward past its resting place", () => {
    render(<Sheet open={true} />);
    runToRest();
    pointer(header(), "pointerdown", 300, 1000);
    pointer(header(), "pointermove", 200, 1100);
    expect(offset()).toBeLessThan(0);
    expect(offset()).toBeGreaterThan(-100);
  });

  it("can catch the sheet while it is still arriving", () => {
    render(<Sheet open={true} />);
    frame();
    frame();
    const caught = offset();
    expect(caught).toBeGreaterThan(0);
    pointer(header(), "pointerdown", 100, 1000);
    // Stopped under the finger.
    expect(frames.size).toBe(0);
    expect(offset()).toBe(caught);
    pointer(header(), "pointermove", 120, 1100);
    expect(offset()).toBeCloseTo(caught + 20, 6);
  });

  it("lets a sheet tapped while arriving carry on arriving instead of closing", () => {
    const onClose = vi.fn();
    render(<Sheet open={true} onClose={onClose} />);
    frame();
    frame();
    // Still most of its travel away: a position-only decision would dismiss.
    expect(offset()).toBeGreaterThan(200);
    pointer(header(), "pointerdown", 100, 1000);
    pointer(header(), "pointermove", 100, 1010);
    pointer(header(), "pointerup", 100, 1020);
    expect(onClose).not.toHaveBeenCalled();
    runToRest();
    expect(sheet().style.transform).toBe("");
  });

  it("does not start a drag from a button in the header, or after a cancel", () => {
    const onClose = vi.fn();
    render(<Sheet open={true} onClose={onClose} />);
    runToRest();
    const close = screen.getByRole("button", { name: "Close" });
    pointer(close, "pointerdown", 100, 1000);
    pointer(header(), "pointermove", 400, 1100);
    expect(sheet().style.transform).toBe("");

    pointer(header(), "pointerdown", 100, 2000);
    pointer(header(), "pointermove", 400, 2016);
    // The browser took the pointer: no throw, it returns by position alone.
    pointer(header(), "pointercancel", 400, 2020);
    expect(onClose).toHaveBeenCalledTimes(1);
    pointer(header(), "pointermove", 500, 2100);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fades instead of travelling under reduced motion", () => {
    reduceMotion = true;
    const animations: { keyframes: Keyframe[]; finish: () => void; cancel: () => void }[] = [];
    const animate = vi.fn(function (
      this: Element,
      keyframes: Keyframe[],
      _options?: KeyframeAnimationOptions,
    ) {
      const animation = {
        keyframes,
        onfinish: null as null | (() => void),
        finish() {
          this.onfinish?.();
        },
        cancel: vi.fn(),
      };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });
    try {
      const { rerender } = render(<Sheet open={true} />);
      // No travel at all, and no frames: it is in place at once and fades in.
      expect(sheet().style.transform).toBe("");
      expect(frames.size).toBe(0);
      expect(animations[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);

      rerender(<Sheet open={false} />);
      expect(animations[1].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
      // Holds its end state, so the sheet doesn't flash back before unmounting.
      expect(animate.mock.calls[1][1]).toMatchObject({ fill: "forwards" });
      expect(sheet()).not.toBeNull();
      act(() => animations[1].finish());
      expect(document.querySelector(".mobile-session-sheet")).toBeNull();

      // A drag-dismiss fades from where the finger left it, not from the top.
      function Harness() {
        const [open, setOpen] = useState(true);
        return <Sheet open={open} onClose={() => setOpen(false)} />;
      }
      rerender(<Harness />);
      pointer(header(), "pointerdown", 100, 1000);
      pointer(header(), "pointermove", 400, 1400);
      pointer(header(), "pointerup", 400, 2000);
      expect(offset()).toBe(300);
      expect(animations[animations.length - 1].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });
});
