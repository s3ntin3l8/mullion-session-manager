// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RailPaneList, RailPanes } from "./RailPaneList.js";
import type { RailPaneEntry } from "../lib/railPanes.js";
import { useDashboardStore } from "../store/index.js";
import { makeProject, makeSession } from "../test/fixtures.js";

const entry = (over: Partial<RailPaneEntry>): RailPaneEntry => ({
  panelId: "session-1",
  label: "login",
  fullTitle: "claude · login fix",
  projectName: "aurora-web",
  logo: null,
  isSession: true,
  needsYou: false,
  unreadCount: 0,
  active: false,
  ...over,
});

describe("RailPaneList", () => {
  it("gives every entry a full accessible name and a tooltip with title and project", () => {
    render(
      <RailPaneList
        entries={[
          entry({ needsYou: true, unreadCount: 2 }),
          entry({ panelId: "git-1", label: "Git", fullTitle: "Git", projectName: null }),
        ]}
        onFocus={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    const list = screen.getByRole("group", { name: "Open panes" });
    const first = within(list).getByRole("button", {
      name: "claude · login fix — aurora-web, needs you, 2 unread",
    });
    expect(first).toHaveAttribute("title", "claude · login fix — aurora-web");
    expect(first).toHaveTextContent("login");
    expect(first.querySelector(".rail-pane-needs-you")).not.toBeNull();
    expect(first.querySelector(".rail-pane-unread")).toHaveTextContent("2");
    const git = within(list).getByRole("button", { name: "Git" });
    expect(git).toHaveAttribute("title", "Git");
    expect(git.querySelector(".rail-pane-needs-you")).toBeNull();
  });

  it("marks the focused pane, and caps the unread count", () => {
    render(
      <RailPaneList
        entries={[entry({ active: true, unreadCount: 14 })]}
        onFocus={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /login fix/ });
    expect(btn).toHaveAttribute("aria-current", "true");
    expect(btn).toHaveClass("active");
    expect(btn.querySelector(".rail-pane-unread")).toHaveTextContent("9+");
  });

  it("focuses the tapped pane and starts a new session from the +", async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    const onAdd = vi.fn();
    render(
      <RailPaneList
        entries={[entry({}), entry({ panelId: "session-2", fullTitle: "codex · orders" })]}
        onFocus={onFocus}
        onAdd={onAdd}
      />,
    );
    await user.click(screen.getByRole("button", { name: /codex · orders/ }));
    expect(onFocus).toHaveBeenCalledWith("session-2");
    await user.click(screen.getByRole("button", { name: "New session" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    // The + sits directly under the entries.
    const buttons = within(screen.getByRole("group")).getAllByRole("button");
    expect(buttons.at(-1)).toHaveAccessibleName("New session");
  });

  it("still offers the + with no panes open", () => {
    render(<RailPaneList entries={[]} onFocus={vi.fn()} onAdd={vi.fn()} />);
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();
  });

  it("shows the agent logo when there is one, a glyph otherwise", () => {
    const { container } = render(
      <RailPaneList
        entries={[entry({ logo: "/claude.svg" }), entry({ panelId: "s2", logo: null })]}
        onFocus={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    const imgs = container.querySelectorAll("img.rail-pane-logo");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute("src", "/claude.svg");
    expect(imgs[0]).toHaveAttribute("alt", "");
  });
});

describe("RailPanes", () => {
  beforeEach(() =>
    useDashboardStore.setState({
      sessions: [
        makeSession({ id: 7, projectId: 3, lastTitle: "task #7 worker", attention: true }),
      ],
      projects: [makeProject({ id: 3, name: "orbit-api" })],
      events: {},
      lastSeenSeq: {},
      dismissedEventKeys: {},
      mutedSessionIds: [],
    }),
  );

  it("builds its entries from the store for the panes it is given", () => {
    render(
      <RailPanes
        panes={[{ id: "session-7", title: "worker", sessionId: 7 }]}
        activePanelId="session-7"
        onFocus={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: "task #7 worker — orbit-api, needs you" });
    expect(btn).toHaveTextContent("#7");
    expect(btn).toHaveAttribute("aria-current", "true");
  });
});

// #3010 — a long press (or a right click) on a rail entry offers to move it.
describe("RailPaneList long-press menu", () => {
  const items = (onSelect: () => void) => () => [{ label: "Move to the right half", onSelect }];

  it("opens on a long press, runs the choice, and does not also focus the pane", async () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const onFocus = vi.fn();
    render(
      <RailPaneList
        entries={[entry({})]}
        onFocus={onFocus}
        onAdd={vi.fn()}
        menuItems={items(onSelect)}
      />,
    );
    const btn = screen.getByRole("button", { name: /login fix/ });
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.pointerDown(btn);
    act(() => {
      vi.advanceTimersByTime(520);
    });
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);
    expect(onFocus).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu", { name: "claude · login fix" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to the right half" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    // An ordinary tap afterwards focuses as usual.
    fireEvent.click(btn);
    expect(onFocus).toHaveBeenCalledWith("session-1");
    vi.useRealTimers();
  });

  it("opens on a right click and closes on Escape; a short press is just a tap", () => {
    const onFocus = vi.fn();
    render(
      <RailPaneList
        entries={[entry({})]}
        onFocus={onFocus}
        onAdd={vi.fn()}
        menuItems={items(vi.fn())}
      />,
    );
    const btn = screen.getByRole("button", { name: /login fix/ });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.contextMenu(btn);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.click(btn);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("offers no menu when there is nothing to offer", () => {
    render(
      <RailPaneList entries={[entry({})]} onFocus={vi.fn()} onAdd={vi.fn()} menuItems={() => []} />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: /login fix/ }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
