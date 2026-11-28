// @vitest-environment jsdom
//
// The phone's Inbox: the notification feed as a page beside the tab bar, which
// stays on screen and usable. It was a modal bottom sheet that covered the bar
// (#3288, #3461). On the real store.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NotificationBell } from "./NotificationBell.js";
import { resetPhoneBackStackForTests } from "./hooks/usePhoneBackStack.js";
import { useDashboardStore } from "./store/index.js";
import { makeSession } from "./test/fixtures.js";
import { resetStore } from "./test/resetStore.js";

const entry = () => screen.getByRole("button", { name: /^(Notifications|Inbox),/ });
const page = () => screen.queryByRole("region", { name: /^(Notifications|Inbox)$/ });
const tap = (el: Element) =>
  act(() => {
    fireEvent.click(el);
  });

function Bell(props: Partial<Parameters<typeof NotificationBell>[0]> = {}) {
  return <NotificationBell onOpenSession={vi.fn()} onOpenBrowser={vi.fn()} page {...props} />;
}

beforeEach(() => {
  resetStore();
  resetPhoneBackStackForTests();
  useDashboardStore.setState({ sessions: [makeSession({ id: 1, name: "calm" })], tasks: [] });
});
afterEach(() => {
  resetPhoneBackStackForTests();
  vi.restoreAllMocks();
});

describe("the phone's Inbox page", () => {
  it("is a pressed tab bar entry, and a region rather than a dialog", () => {
    // No dialog, so no popup token: the entry is pressed while its page
    // shows, as the bar's Workspace and Tasks entries are.
    render(<Bell />);
    expect(entry()).not.toHaveAttribute("aria-haspopup");
    expect(entry()).not.toHaveAttribute("aria-expanded");
    expect(entry()).toHaveAttribute("aria-pressed", "false");

    tap(entry());

    expect(entry()).toHaveAttribute("aria-pressed", "true");
    expect(entry()).toHaveClass("active");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(page()).not.toHaveAttribute("aria-modal");
    expect(document.querySelector(".mobile-session-backdrop")).toBeNull();
  });

  it("is headed by the entry's label, or Notifications without one", () => {
    const { unmount } = render(<Bell label="Inbox" />);
    tap(entry());
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    unmount();
    render(<Bell />);
    tap(entry());
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
  });

  it("is named by its heading, and Tab off either end goes to its entry", () => {
    render(<Bell label="Inbox" />);
    tap(entry());
    expect(screen.getByRole("region", { name: "Inbox" })).toBe(page());
    const stops = page()!.querySelectorAll<HTMLElement>("button");
    // From the page itself (where focus lands) and from its first control.
    for (const from of [page()!, stops[0]]) {
      from.focus();
      fireEvent.keyDown(from, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(entry());
    }
    const last = stops[stops.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(entry());
    // Inside the page, Tab is the browser's.
    stops[0].focus();
    fireEvent.keyDown(stops[0], { key: "Tab" });
    expect(document.activeElement).toBe(stops[0]);
  });

  it("mounts in the host it is given, and nowhere until that host exists", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { rerender } = render(<Bell pageHost={null} />);
    tap(entry());
    expect(page()).toBeNull();

    rerender(<Bell pageHost={host} />);
    expect(host).toContainElement(page());
    // Inside the app's themed subtree already: no theme class of its own.
    expect(page()!.className).toBe("phone-inbox-page mobile-notif-sheet");
    // Focus follows the page once it is on screen.
    expect(document.activeElement).toBe(page());
    host.remove();
  });

  it("carries the theme itself when it mounts in <body>", () => {
    useDashboardStore.setState({ theme: "light" });
    render(<Bell />);
    tap(entry());
    expect(page()).toHaveClass("light", "phone-inbox-page");
  });

  it("closes from its own entry, Escape, the back gesture and the tab bar's signal", () => {
    const { rerender } = render(<Bell closeSeq={0} />);
    tap(entry());
    expect(page()).not.toBeNull();
    tap(entry());
    expect(page()).toBeNull();

    tap(entry());
    act(() => {
      fireEvent.keyDown(page()!, { key: "Escape" });
    });
    expect(page()).toBeNull();
    // Nothing else took focus, so it is back on the entry.
    expect(document.activeElement).toBe(entry());

    tap(entry());
    // Other keys are the page's own business.
    fireEvent.keyDown(page()!, { key: "a" });
    expect(page()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(page()).toBeNull();

    // Another tab bar entry was tapped (PhoneModeBar bumps this).
    tap(entry());
    rerender(<Bell closeSeq={1} />);
    expect(page()).toBeNull();
    // The same value again closes nothing.
    tap(entry());
    rerender(<Bell closeSeq={1} />);
    expect(page()).not.toBeNull();
  });

  it("leaves focus with what was focused as it closed", () => {
    const { rerender } = render(
      <>
        <Bell closeSeq={0} />
        <button>Elsewhere</button>
      </>,
    );
    tap(entry());
    // The tab bar's entries focus themselves when tapped.
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(
      <>
        <Bell closeSeq={1} />
        <button>Elsewhere</button>
      </>,
    );
    expect(page()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});
