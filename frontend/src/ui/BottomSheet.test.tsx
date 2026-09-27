// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
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
});
