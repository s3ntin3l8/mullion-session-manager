// @vitest-environment jsdom
// The phone's top bar (#3009, #3014). From 700px there is no top bar: its
// controls are the left rail's (LeftRail.test.tsx). NotificationBell is
// stubbed so a bell the bar must not render (#3288) would show up as its test id.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toolbar } from "./Toolbar.js";

let viewMode: string;

function storeState() {
  return { viewMode };
}

vi.mock("./store/index.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

vi.mock("./NotificationBell.js", () => ({
  NotificationBell: ({ sheet, sheetClassName }: { sheet?: boolean; sheetClassName?: string }) => (
    <span data-testid="bell" data-sheet={String(!!sheet)} data-sheet-class={sheetClassName ?? ""} />
  ),
}));

const NOOP_PROPS = {
  onOpenLauncher: vi.fn(),
};

beforeEach(() => {
  viewMode = "list";
});

describe("Toolbar — the phone's top bar", () => {
  it("renders the session picker slot, in both modes", () => {
    const { rerender } = render(
      <Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />,
    );
    expect(screen.getByText("switcher")).toBeInTheDocument();
    viewMode = "kanban";
    rerender(<Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />);
    expect(screen.getByText("switcher")).toBeInTheDocument();
  });

  it("has no drawer toggle, workspace summary, theme, settings or ⋯ menu (#3014)", () => {
    const { container } = render(
      <Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />,
    );
    expect(container.querySelector("[data-toggle-sidebar]")).toBeNull();
    expect(container.querySelector(".toolbar-center")).toBeNull();
    expect(container.querySelector(".toolbar-app-menu")).toBeNull();
    expect(screen.queryByTitle(/^Theme:/)).toBeNull();
    expect(screen.queryByTitle(/^Settings/)).toBeNull();
  });

  // Issue #1880 — the command palette was hidden on the phone tier by a CSS
  // rule, so the phone had no route to the palette at all. The CSS half is
  // guarded by `scripts/check-phone-palette.mjs` (vitest stubs CSS imports);
  // this is the JS half: the button is there, it is one of the phone's own
  // icon buttons, it is named, and it opens the palette.
  it("keeps the command palette reachable", async () => {
    const onOpenLauncher = vi.fn();
    const { container } = render(<Toolbar {...NOOP_PROPS} onOpenLauncher={onOpenLauncher} />);
    const button = container.querySelector(".run-cmd-btn")!;
    expect(button).not.toBeNull();
    expect(button).toHaveClass("toolbar-icon-btn");

    await userEvent.click(button);
    expect(onOpenLauncher).toHaveBeenCalledTimes(1);
  });

  it("names the icon-only palette button", () => {
    const { container } = render(<Toolbar {...NOOP_PROPS} />);
    const button = container.querySelector(".run-cmd-btn")!;
    expect(button).toHaveAttribute("aria-label", "Command palette");
    expect(screen.getByRole("button", { name: "Command palette" })).toBe(button);
  });

  it("omits the palette button in Task view instead of disabling it", () => {
    // The Task view has no palette on purpose (issue #730); touch never shows
    // a `title`, so a disabled button would be a dead icon with no
    // explanation.
    viewMode = "kanban";
    const { container } = render(<Toolbar {...NOOP_PROPS} />);
    expect(container.querySelector(".run-cmd-btn")).toBeNull();
  });

  // #3288 — the notifications are the tab bar's Inbox entry
  // (PhoneModeBar.test.tsx), so the phone has exactly one bell.
  it("has no bell, in either mode", () => {
    const { rerender } = render(<Toolbar {...NOOP_PROPS} />);
    expect(screen.queryByTestId("bell")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
    viewMode = "kanban";
    rerender(<Toolbar {...NOOP_PROPS} />);
    expect(screen.queryByTestId("bell")).toBeNull();
  });

  it("is the session picker and the palette button in Workspace mode, the picker alone in Tasks", () => {
    const { container, rerender } = render(
      <Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />,
    );
    expect(container.querySelectorAll(".toolbar-actions > *")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Command palette" })).toBeInTheDocument();
    viewMode = "kanban";
    rerender(<Toolbar {...NOOP_PROPS} mobileSessionSlot={<span>switcher</span>} />);
    expect(container.querySelectorAll(".toolbar-actions > *")).toHaveLength(0);
    expect(screen.getByText("switcher")).toBeInTheDocument();
  });
});
