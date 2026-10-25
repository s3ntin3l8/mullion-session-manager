// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";

describe("Settings -> Dock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    unexpectedCalls = [];
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      // store.ts's updateSettings debounces a fire-and-forget PATCH
      // /api/settings SETTINGS_PATCH_DEBOUNCE_MS (400ms real time — this
      // suite doesn't use fake timers) after ANY toggle click below. That's
      // a legitimate, intentional side effect this file's tests don't
      // assert against, not something to flag as unexpected — and under
      // load (the full suite running many files/tests concurrently) the
      // real 400ms timer can fire AFTER the click's own test has already
      // returned, landing during a LATER test in this same file. Accepting
      // it here rather than recording it means that stale flush can never
      // fail an unrelated test's `unexpectedCalls` assertion, regardless of
      // how the two tests' timing happens to interleave.
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        );
      }
      unexpectedCalls.push(`${method} ${url}`);
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        dock: {
          defaultWorktreeRefresh: false,
          autoDetectDevServer: "ask",
          dockerServices: true,
          autoAttachDockerLogs: false,
        },
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

    const toggle = screen.getByTestId("dock-worktree-refresh-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(useDashboardStore.getState().settings.dock.defaultWorktreeRefresh).toBe(true);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(useDashboardStore.getState().settings.dock.defaultWorktreeRefresh).toBe(false);
  });

  it("renders the auto-detect dev server control, defaulting to Ask (issue #404)", async () => {
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    expect(await screen.findByText("Detect dev servers in plain sessions")).toBeInTheDocument();
    // The segmented control's options are radios, not plain buttons — the
    // selection used to be carried by the `.active` class alone, which said
    // nothing to a screen reader.
    expect(screen.getByRole("radio", { name: "Ask" })).toHaveClass("active");
    expect(screen.getByRole("radio", { name: "Off" })).not.toHaveClass("active");
  });

  it("switches auto-detect dev server to Off", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    await screen.findByText("Detect dev servers in plain sessions");

    await user.click(screen.getByRole("radio", { name: "Off" }));

    expect(screen.getByRole("radio", { name: "Off" })).toHaveClass("active");
    expect(useDashboardStore.getState().settings.dock.autoDetectDevServer).toBe("off");
  });

  // Issue #73.
  it("renders the Docker Compose services toggle, defaulting to on", async () => {
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    expect(await screen.findByText("Docker Compose services")).toBeInTheDocument();
    expect(screen.getByTestId("dock-docker-services-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("turns off Docker Compose service discovery", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    const toggle = await screen.findByTestId("dock-docker-services-toggle");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(useDashboardStore.getState().settings.dock.dockerServices).toBe(false);
  });

  it("renders the auto-attach Docker logs toggle, defaulting to off", async () => {
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    expect(await screen.findByText("Auto-attach Docker logs")).toBeInTheDocument();
    expect(screen.getByTestId("dock-docker-autoattach-toggle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("turns on auto-attach Docker logs", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    const toggle = await screen.findByTestId("dock-docker-autoattach-toggle");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(useDashboardStore.getState().settings.dock.autoAttachDockerLogs).toBe(true);
  });

  // Issue #1881 — the Dock is hidden on touch-only devices (tablet.css's
  // `(pointer: coarse)` block, which is also what Dock.tsx itself checks),
  // but this section offered its Dock settings with no word about it. The
  // palette's Dock command says the same thing.
  it("says why the Dock is unavailable under a coarse pointer", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    expect(await screen.findByText(/The Dock is hidden on touch-only devices/)).toBeInTheDocument();
  });

  it("says nothing about the Dock where the Dock can be shown", async () => {
    render(<Settings onClose={vi.fn()} initialSection="dock" />);
    expect(await screen.findByText("Refresh worktree on agent commits")).toBeInTheDocument();
    expect(screen.queryByText(/The Dock is hidden on touch-only devices/)).toBeNull();
  });
});
