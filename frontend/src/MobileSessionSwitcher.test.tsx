// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileSessionSwitcher } from "./MobileSessionSwitcher.js";
import type {
  MobileSessionItem,
  MobileSessionRow,
  MobileSessionSection,
} from "./MobileSessionSwitcher.js";

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

function rowFor(item: MobileSessionItem, extra: Partial<MobileSessionRow> = {}): MobileSessionRow {
  return {
    key: item.id,
    panelId: item.id,
    title: item.title,
    dotColor: item.dotColor,
    agentLogo: item.agentLogo,
    unreadCount: item.unreadCount,
    needsYou: false,
    searchFields: [item.title],
    ...extra,
  };
}

const SECTIONS: MobileSessionSection[] = [
  { key: "project-1", label: "runway", kind: "project", rows: ITEMS.map((i) => rowFor(i)) },
];

function renderSwitcher(overrides: Partial<Parameters<typeof MobileSessionSwitcher>[0]> = {}) {
  const props = {
    items: ITEMS,
    sections: SECTIONS,
    unreadElsewhere: 1,
    activeId: "p2",
    onSelect: vi.fn(),
    onSelectRow: vi.fn(),
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
    expect(props.onSelectRow).toHaveBeenCalledWith(expect.objectContaining({ panelId: "p3" }));
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
    expect(props.onRenameCancel).toHaveBeenCalledTimes(1);
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
      sections: SECTIONS,
      unreadElsewhere: 0,
      activeId: "p2",
      onSelect: vi.fn(),
      onSelectRow: vi.fn(),
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

  it("cancels an in-flight rename when the sheet is closed from the backdrop", async () => {
    const props = renderSwitcher({ renamingId: "p2", renameDraft: "half-typed" });
    const user = userEvent.setup();
    await user.click(trigger());
    await user.click(document.querySelector(".mobile-session-backdrop") as HTMLElement);
    expect(props.onRenameCancel).toHaveBeenCalled();
    expect(props.onRenameCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape with focus outside the rename input cancels the rename, then closes the sheet", async () => {
    const props = renderSwitcher({ renamingId: "p2", renameDraft: "x" });
    const user = userEvent.setup();
    await user.click(trigger());
    const sheet = screen.getByRole("dialog");
    fireEvent.keyDown(screen.getByText("Sessions (3)"), { key: "Escape" });
    expect(props.onRenameCancel).toHaveBeenCalledTimes(1);
    expect(sheet).toBeInTheDocument();
  });

  it("swiping with no active item enters the list at the first or last item", () => {
    const props = renderSwitcher({ activeId: "floating" });
    const el = screen.getByRole("button", { name: /Sessions/ });
    fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 20 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 100, clientY: 20 }] });
    expect(props.onSelect).toHaveBeenLastCalledWith("p1");
    fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 20 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200, clientY: 20 }] });
    expect(props.onSelect).toHaveBeenLastCalledWith("p3");
  });

  it("shows a New session button when there are no sessions", async () => {
    const props = renderSwitcher({ items: [], sections: [], activeId: null });
    const user = userEvent.setup();
    await user.click(screen.getByText("New session"));
    expect(props.onNewSession).toHaveBeenCalledTimes(1);
  });
  it("groups rows under sticky project headers with counts", async () => {
    renderSwitcher();
    await userEvent.setup().click(trigger());
    const head = screen.getByRole("heading", { name: /runway/ });
    expect(head).toHaveTextContent("3");
  });

  it("dims a session that isn't open, offers no close button, and selects it as a row", async () => {
    const closed = rowFor(
      { id: "s9", title: "elsewhere", dotColor: "gray", agentLogo: null, unreadCount: 0 },
      { key: "session-9", panelId: null },
    );
    const props = renderSwitcher({
      sections: [{ ...SECTIONS[0], rows: [...SECTIONS[0].rows, closed] }],
    });
    const user = userEvent.setup();
    await user.click(trigger());
    const row = screen.getByText("elsewhere").closest("li") as HTMLElement;
    expect(row).toHaveClass("closed");
    expect(screen.queryByLabelText("Close elsewhere")).toBeNull();
    await user.click(screen.getByText("elsewhere"));
    expect(props.onSelectRow).toHaveBeenCalledWith(expect.objectContaining({ panelId: null }));
    // Selecting a closed row must not go through the swipe/open-pane path.
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("pins 'Needs you' rows without actions, close buttons or an active mark", async () => {
    const pinned = rowFor(ITEMS[1], { key: "pin-p2", needsYou: true });
    renderSwitcher({
      sections: [
        { key: "needs-you", label: "Needs you", kind: "needs-you", rows: [pinned] },
        ...SECTIONS,
      ],
    });
    const user = userEvent.setup();
    await user.click(trigger());
    // Pinned copy of the active row: only the real row is active / has ⋮ / ×.
    expect(screen.getAllByText("actions")).toHaveLength(1);
    expect(screen.getAllByLabelText("Close Claude Code · runway")).toHaveLength(1);
    expect(document.querySelectorAll(".mobile-session-row.active")).toHaveLength(1);
    // The pin repeats a row, so the sheet count is distinct rows only.
    expect(screen.getByText("Sessions (3)")).toBeInTheDocument();
  });

  it("shows no search box for a short list", async () => {
    renderSwitcher();
    const user = userEvent.setup();
    await user.click(trigger());
    expect(screen.queryByLabelText("Search sessions")).toBeNull();
  });

  it("filters a long list by search text and reports no matches", async () => {
    const many: MobileSessionItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      title: `task-${i}`,
      dotColor: "gray",
      agentLogo: null,
      unreadCount: 0,
    }));
    renderSwitcher({
      items: many,
      activeId: "m0",
      sections: [
        { key: "project-1", label: "runway", kind: "project", rows: many.map((i) => rowFor(i)) },
      ],
      unreadElsewhere: 0,
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /task-0/ }));
    const search = screen.getByLabelText("Search sessions");
    expect(search).not.toHaveFocus();
    await user.type(search, "task-7");
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("task-7")).toBeInTheDocument();
    expect(within(sheet).queryByText("task-3")).toBeNull();
    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText(/No sessions match/)).toBeInTheDocument();
    // Closing resets the query.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /task-0/ }));
    expect(screen.getByLabelText("Search sessions")).toHaveValue("");
  });

  it("ignores a swipe when nothing is open", () => {
    const closedOnly = rowFor(ITEMS[0], { panelId: null, key: "session-1" });
    const props = renderSwitcher({
      items: [],
      activeId: null,
      sections: [{ ...SECTIONS[0], rows: [closedOnly] }],
    });
    const el = screen.getByRole("button", { name: /Sessions/ });
    fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 20 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 100, clientY: 20 }] });
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("hides the Needs you pin while a search is active", async () => {
    const many: MobileSessionItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      title: `task-${i}`,
      dotColor: "gray",
      agentLogo: null,
      unreadCount: 0,
    }));
    renderSwitcher({
      items: many,
      activeId: "m0",
      unreadElsewhere: 0,
      sections: [
        {
          key: "needs-you",
          label: "Needs you",
          kind: "needs-you",
          rows: [rowFor(many[7], { key: "pin-7", needsYou: true })],
        },
        { key: "project-1", label: "runway", kind: "project", rows: many.map((i) => rowFor(i)) },
      ],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /task-0/ }));
    expect(screen.getByRole("heading", { name: /Needs you/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search sessions"), "task-7");
    expect(screen.queryByRole("heading", { name: /Needs you/ })).toBeNull();
    expect(screen.getAllByText("task-7")).toHaveLength(1);
  });
});
