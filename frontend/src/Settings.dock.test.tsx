// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import { useDashboardStore } from "./store.js";
import { DEFAULT_SETTINGS } from "./api.js";

describe("Settings -> Dock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    unexpectedCalls = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      unexpectedCalls.push(`${method} ${url}`);
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        dock: { defaultWorktreeRefresh: false, autoDetectDevServer: "ask" },
      },
    });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("renders the dock section with default toggle state", async () => {
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    expect(await screen.findByText("Refresh worktree on agent commits")).toBeInTheDocument();
  });

  it("toggles the worktree refresh setting", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    await screen.findByText("Refresh worktree on agent commits");

    const toggle = screen.getByRole("button", { pressed: false });
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByRole("button", { pressed: true })).toBeInTheDocument();
    expect(useDashboardStore.getState().settings.dock.defaultWorktreeRefresh).toBe(true);

    await user.click(screen.getByRole("button", { pressed: true }));
    expect(screen.getByRole("button", { pressed: false })).toBeInTheDocument();
    expect(useDashboardStore.getState().settings.dock.defaultWorktreeRefresh).toBe(false);
  });

  it("renders the auto-detect dev server control, defaulting to Ask (issue #404)", async () => {
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    expect(await screen.findByText("Detect dev servers in plain sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Off" })).not.toHaveClass("active");
  });

  it("switches auto-detect dev server to Off", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    await screen.findByText("Detect dev servers in plain sessions");

    await user.click(screen.getByRole("button", { name: "Off" }));

    expect(screen.getByRole("button", { name: "Off" })).toHaveClass("active");
    expect(useDashboardStore.getState().settings.dock.autoDetectDevServer).toBe("off");
  });
});
