// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Settings } from "../../Settings.js";
import type { Agent } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Guards against the misalignment fixed here: shell rows (no icon, no
// toggles) and agent rows (icon, conditional skip-perms toggle) used to
// render through variable-width flex, so "available" landed at a different
// x position depending on which cells a given row happened to populate.
// Every row now emits all seven grid cells unconditionally.

describe("Settings -> Launchers", () => {
  let agentsDb: Agent[];
  let skipFlags: Record<string, string>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    agentsDb = [
      {
        id: "zsh",
        title: "zsh",
        command: "/usr/bin/zsh",
        kind: "shell",
        available: true,
        path: "/usr/bin/zsh",
        emits: [],
      },
      {
        id: "claude",
        title: "claude",
        command: "claude",
        kind: "agent",
        available: true,
        path: "/home/bjoern/.local/bin/claude",
        emits: [],
      },
      {
        id: "pi",
        title: "pi",
        command: "pi",
        kind: "agent",
        available: true,
        path: "/usr/local/bin/pi",
        emits: [],
      },
      // Issue #882 — codex's hookTrust field is only ever set for the
      // codex binary (agent-detect.ts:174); undefined for every other
      // agent/shell above, which the "renders no badge" tests rely on.
      {
        id: "codex",
        title: "codex",
        command: "codex",
        kind: "agent",
        available: true,
        path: "/usr/local/bin/codex",
        emits: [],
        hookTrust: "pending",
      },
    ];
    skipFlags = { claude: "--dangerously-skip-permissions" };
    unexpectedCalls = [];

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/agents/skip-permissions-flags")) {
        return Promise.resolve(jsonResponse(200, skipFlags));
      }
      if (url.startsWith("/api/agents")) {
        return Promise.resolve(jsonResponse(200, agentsDb));
      }
      if (url === "/api/server-info") {
        return Promise.resolve(jsonResponse(200, { crsConfigDir: "/home/bjoern/.config/crs" }));
      }

      unexpectedCalls.push(`${method} ${url}`);
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("renders shell rows under 'Shells' with empty skip-perms/show cells", async () => {
    render(<Settings onClose={vi.fn()} initialSection="launchers" />);

    const row = await screen.findByTestId("launcher-row-zsh");
    expect(within(row.parentElement!).getByText("Shells")).toBeInTheDocument();
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });

  it("aligns the status cell for an agent without a skip-perms flag the same as one with it", async () => {
    render(<Settings onClose={vi.fn()} initialSection="launchers" />);

    const claudeRow = await screen.findByTestId("launcher-row-claude");
    const piRow = await screen.findByTestId("launcher-row-pi");

    // claude has a skip-perms flag (2 toggles), pi does not (1 toggle) —
    // both still render both toggle cells, one of them just empty, so the
    // "available" label sits at the same grid column for both rows.
    expect(
      within(claudeRow).getAllByRole("button", { name: /skip permissions|show/i }),
    ).toHaveLength(2);
    expect(within(piRow).getAllByRole("button", { name: /show/i })).toHaveLength(1);
    expect(
      within(piRow).queryByRole("button", { name: /skip permissions/i }),
    ).not.toBeInTheDocument();

    expect(within(claudeRow).getByText("available")).toBeInTheDocument();
    expect(within(piRow).getByText("available")).toBeInTheDocument();
  });

  it("shows column headers for the toggle columns", async () => {
    render(<Settings onClose={vi.fn()} initialSection="launchers" />);

    await screen.findByTestId("launcher-row-zsh");
    expect(screen.getByText("Skip perms")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Show")).toBeInTheDocument();
  });

  // Issue #882 — this badge (and the config-column remediation text) is the
  // ONLY frontend surface of getCodexHookTrust() that had no test coverage
  // at all; the store-slice logic that produces `hookTrust` is covered
  // separately in store/codex-hook-trust.test.ts.
  describe("codex hook-trust badge (issue #259/#882)", () => {
    it("renders 'trust pending' and the remediation text for an agent with hookTrust: 'pending'", async () => {
      render(<Settings onClose={vi.fn()} initialSection="launchers" />);

      const codexRow = await screen.findByTestId("launcher-row-codex");
      expect(within(codexRow).getByText("trust pending")).toBeInTheDocument();
      expect(
        within(codexRow).getByTitle(
          "Hook trust pending — run /hooks in a Codex session to enable structured events",
        ),
      ).toBeInTheDocument();
      // The badge REPLACES "available", it doesn't sit alongside it.
      expect(within(codexRow).queryByText("available")).not.toBeInTheDocument();
    });

    it("renders the ordinary 'available' status, not the badge, when hookTrust is 'trusted'", async () => {
      agentsDb = agentsDb.map((a) => (a.id === "codex" ? { ...a, hookTrust: "trusted" } : a));
      render(<Settings onClose={vi.fn()} initialSection="launchers" />);

      const codexRow = await screen.findByTestId("launcher-row-codex");
      expect(within(codexRow).getByText("available")).toBeInTheDocument();
      expect(within(codexRow).queryByText("trust pending")).not.toBeInTheDocument();
    });

    it("renders no badge for an agent with no hookTrust field at all (every non-codex agent/shell)", async () => {
      render(<Settings onClose={vi.fn()} initialSection="launchers" />);

      const claudeRow = await screen.findByTestId("launcher-row-claude");
      expect(within(claudeRow).getByText("available")).toBeInTheDocument();
      expect(within(claudeRow).queryByText("trust pending")).not.toBeInTheDocument();
    });

    // CodexHookTrust's third value (hooks never merged at all, as opposed
    // to merged-but-untrusted) deliberately renders identically to
    // "trusted"/absent today — LaunchersSection.tsx's badge is gated on
    // `=== "pending"` specifically, not `!== "trusted"`.
    it("renders the ordinary 'available' status, not the badge, when hookTrust is 'not-installed'", async () => {
      agentsDb = agentsDb.map((a) => (a.id === "codex" ? { ...a, hookTrust: "not-installed" } : a));
      render(<Settings onClose={vi.fn()} initialSection="launchers" />);

      const codexRow = await screen.findByTestId("launcher-row-codex");
      expect(within(codexRow).getByText("available")).toBeInTheDocument();
      expect(within(codexRow).queryByText("trust pending")).not.toBeInTheDocument();
    });
  });
});
