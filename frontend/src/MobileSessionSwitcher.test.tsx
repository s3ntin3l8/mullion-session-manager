// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileSessionSwitcher } from "./MobileSessionSwitcher.js";
import type { MobileSessionItem } from "./MobileSessionSwitcher.js";

vi.mock("./store/index.js", () => {
  const state = { theme: "dark" };
  const useDashboardStore = (selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state;
  return { useDashboardStore };
});

const ITEMS: MobileSessionItem[] = [
  { id: "p1", title: "session-1251", dotColor: "red", agentLogo: null, unreadCount: 0 },
  { id: "p2", title: "Claude Code · runway", dotColor: "green", agentLogo: null, unreadCount: 2 },
  { id: "p3", title: "session-1254", dotColor: "gray", agentLogo: null, unreadCount: 1 },
];

function renderSwitcher(overrides: Partial<Parameters<typeof MobileSessionSwitcher>[0]> = {}) {
  const props = {
    items: ITEMS,
    activeId: "p2",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNewSession: vi.fn(),
    renderActiveActions: () => <button>actions</button>,
    renamingId: null,
    renameDraft: "",
    renameInputRef: createRef<HTMLInputElement>(),
    onRenameDraftChange: vi.fn(),
    onRenameCommit: vi.fn(),
    onRenameCancel: vi.fn(),
    ...overrides,
  };
  render(<MobileSessionSwitcher {...props} />);
  return props;
}

function trigger() {
  return screen.getByRole("button", { name: /Claude Code · runway/ });
}

describe("MobileSessionSwitcher", () => {
  it("shows the active session, its position, and unread counts from other sessions", () => {
    renderSwitcher();
    expect(trigger()).toHaveTextContent("Claude Code · runway");
    expect(trigger()).toHaveTextContent("2/3");
    // p2's own 2 unread are excluded; p3's 1 is shown.
    expect(screen.getByLabelText("1 unread elsewhere")).toBeInTheDocument();
  });

  it("opens a sheet listing every session and switches on tap", async () => {
    const props = renderSwitcher();
    const user = userEvent.setup();
    await user.click(trigger());
    const sheet = screen.getByRole("dialog", { name: "Sessions" });
    expect(within(sheet).getByText("Sessions (3)")).toBeInTheDocument();
    await user.click(within(sheet).getByText("session-1254"));
    expect(props.onSelect).toHaveBeenCalledWith("p3");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the active row's actions and closes any row", async () => {
    const props = renderSwitcher();
    const user = userEvent.setup();
    await user.click(trigger());
    expect(screen.getByText("actions")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Close session-1251"));
    expect(props.onClose).toHaveBeenCalledWith("p1");
  });

  it("starts a new session from the sheet footer", async () => {
    const props = renderSwitcher();
    const user = userEvent.setup();
    await user.click(trigger());
    await user.click(screen.getByText("New session"));
    expect(props.onNewSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the sheet on Escape and on backdrop tap", async () => {
    renderSwitcher();
    const user = userEvent.setup();
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(trigger());
    const backdrop = document.querySelector(".mobile-session-backdrop") as HTMLElement;
    await user.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switches to the next session on a leftward swipe without opening the sheet", () => {
    const props = renderSwitcher();
    const el = trigger();
    fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 20 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 100, clientY: 24 }] });
    fireEvent.click(el);
    expect(props.onSelect).toHaveBeenCalledWith("p3");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("treats a short or vertical drag as a tap, not a swipe", () => {
    const props = renderSwitcher();
    const el = trigger();
    fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 20 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 170, clientY: 90 }] });
    fireEvent.click(el);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("swaps the row for a rename input and wires its keys", async () => {
    const props = renderSwitcher({ renamingId: "p2", renameDraft: "new name" });
    const user = userEvent.setup();
    await user.click(trigger());
    const input = screen.getByLabelText("Session name");
    expect(input).toHaveValue("new name");
    // Escape cancels the rename, not the whole sheet.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onRenameCancel).toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRenameCommit).toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "x" } });
    expect(props.onRenameDraftChange).toHaveBeenCalledWith("x");
  });

  it("names no session when the active panel isn't one of the items", () => {
    renderSwitcher({ activeId: "floating-panel" });
    const el = screen.getByRole("button", { name: /Sessions/ });
    expect(el).toHaveTextContent("3");
    expect(el.querySelector(".mobile-session-dot")).toBeNull();
  });

  it("only swallows a click that immediately follows a swipe", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const props = renderSwitcher();
      const el = trigger();
      fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 20 }] });
      fireEvent.touchEnd(el, { changedTouches: [{ clientX: 100, clientY: 24 }] });
      expect(props.onSelect).toHaveBeenCalledWith("p3");
      // No trailing click from the browser; a keyboard activation later on
      // must still open the sheet.
      now.mockReturnValue(20_000);
      fireEvent.click(el);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    } finally {
      now.mockRestore();
    }
  });

  it("returns focus to the active row when a rename ends", async () => {
    const props = {
      items: ITEMS,
      activeId: "p2",
      onSelect: vi.fn(),
      onClose: vi.fn(),
      onNewSession: vi.fn(),
      renderActiveActions: () => null,
      renameDraft: "x",
      renameInputRef: createRef<HTMLInputElement>(),
      onRenameDraftChange: vi.fn(),
      onRenameCommit: vi.fn(),
      onRenameCancel: vi.fn(),
    };
    const { rerender } = render(<MobileSessionSwitcher {...props} renamingId={null} />);
    await userEvent.setup().click(trigger());
    rerender(<MobileSessionSwitcher {...props} renamingId="p2" />);
    rerender(<MobileSessionSwitcher {...props} renamingId={null} />);
    expect(document.activeElement).toHaveAttribute("aria-current", "true");
  });

  it("shows a New session button when there are no sessions", async () => {
    const props = renderSwitcher({ items: [], activeId: null });
    const user = userEvent.setup();
    await user.click(screen.getByText("New session"));
    expect(props.onNewSession).toHaveBeenCalledTimes(1);
  });
});
