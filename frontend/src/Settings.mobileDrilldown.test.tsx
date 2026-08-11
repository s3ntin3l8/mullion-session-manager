// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import { useDashboardStore } from "./store.js";
import { DEFAULT_SETTINGS } from "./api.js";

// Mobile UI/UX overhaul, item D — Settings.tsx's drill-down is pure JS state
// (`mobileNavOpen`) gated entirely by CSS at the <700px breakpoint (see
// styles.css's `.settings-modal-body-showing-content` rules and
// `.settings-back-btn`'s base `display: none`), not a matchMedia check —
// unlike BrowserPanel.tsx's autofocus suppression (item B.5), so these tests
// don't need to stub window.matchMedia at all. They assert the state
// machine and the class/attribute contract CSS reads, not viewport-driven
// layout (jsdom doesn't evaluate CSS anyway).
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/settings" && method === "PATCH") {
      return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Settings mobile drill-down", () => {
  it("opens on the nav list, with no back button, when no section was explicitly requested", () => {
    const { container } = render(<Settings onClose={vi.fn()} />);

    expect(container.querySelector(".settings-modal-body")).not.toHaveClass(
      "settings-modal-body-showing-content",
    );
    expect(screen.queryByLabelText("Back to settings list")).not.toBeInTheDocument();
  });

  it("picking a section swaps to its content and shows the back chevron", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /terminal behavior/i }));

    expect(document.querySelector(".settings-modal-body")).toHaveClass(
      "settings-modal-body-showing-content",
    );
    expect(screen.getByLabelText("Back to settings list")).toBeInTheDocument();
    expect(document.querySelector(".settings-content-title")).toHaveTextContent(
      "Terminal behavior",
    );
  });

  it("the back chevron returns to the nav list", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /terminal behavior/i }));
    await user.click(screen.getByLabelText("Back to settings list"));

    expect(document.querySelector(".settings-modal-body")).not.toHaveClass(
      "settings-modal-body-showing-content",
    );
    expect(screen.queryByLabelText("Back to settings list")).not.toBeInTheDocument();
  });

  // Hermes review, PR #621 — both drill-down pane swaps used to hide
  // whatever held focus (the nav goes `display: none`; the back chevron
  // unmounts), dropping focus to <body> with nothing announced to a
  // screen-reader user.
  it("moves focus to the back chevron on forward nav", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /terminal behavior/i }));

    expect(screen.getByLabelText("Back to settings list")).toHaveFocus();
  });

  it("restores focus to the active nav item on back nav", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /terminal behavior/i }));
    await user.click(screen.getByLabelText("Back to settings list"));

    expect(screen.getByRole("button", { name: /terminal behavior/i })).toHaveFocus();
  });

  it("does not steal focus on initial mount — the focus trap owns that", () => {
    const { container } = render(<Settings onClose={vi.fn()} />);

    const closeBtn = container.querySelector(".settings-modal-close");
    expect(closeBtn).toHaveFocus();
  });

  it("an explicit deep link (initialSection) opens straight into that section's content", () => {
    render(<Settings onClose={vi.fn()} initialSection="server" />);

    expect(document.querySelector(".settings-modal-body")).toHaveClass(
      "settings-modal-body-showing-content",
    );
    expect(screen.getByLabelText("Back to settings list")).toBeInTheDocument();
  });

  it("a generic open (default 'appearance') opens on the nav list, not straight to Appearance", () => {
    render(<Settings onClose={vi.fn()} initialSection="appearance" />);

    expect(document.querySelector(".settings-modal-body")).not.toHaveClass(
      "settings-modal-body-showing-content",
    );
    expect(screen.queryByLabelText("Back to settings list")).not.toBeInTheDocument();
  });
});
