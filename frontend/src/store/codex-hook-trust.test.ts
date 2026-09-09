// @vitest-environment jsdom
// Issue #882 — the codex hook-trust store slice (ui.ts's checkCodexHookTrust
// /dismissCodexHookTrust) has shipped and driven two live UI surfaces (the
// App.tsx banner and the Settings -> Launchers badge) since issue #259
// (PR #284, 2026-07-24), but had zero test coverage of its own. This covers
// the store logic directly, the same way mute.test.ts covers
// toggleSessionMute — App.tsx itself has no test harness in this codebase
// and building one is out of scope for a coverage-only pass (see #882's
// closing comment).
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useDashboardStore } from "./index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import type { Agent } from "../api/index.js";

const STORAGE_KEY = "crs.dismissedCodexHookTrustVersion";

beforeEach(() => {
  localStorage.clear();
  useDashboardStore.setState({
    codexHookTrust: null,
    dismissedCodexHookTrustVersion: null,
    currentVersion: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Typed as Agent[] (not `unknown`/inline object literals) so a future
// required field added to Agent fails this fixture at compile time rather
// than silently drifting from what /api/agents actually returns.
function stubListAgentsResponse(agents: Agent[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/agents") {
        return Promise.resolve(jsonResponse(200, agents));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
    }),
  );
}

describe("checkCodexHookTrust (issue #259/#882)", () => {
  it("sets codexHookTrust from the agent:codex entry's own hookTrust field", async () => {
    stubListAgentsResponse([
      {
        id: "agent:claude",
        title: "claude",
        command: "claude",
        kind: "agent",
        available: true,
        path: null,
        emits: [],
      },
      {
        id: "agent:codex",
        title: "codex",
        command: "codex",
        kind: "agent",
        available: true,
        path: null,
        emits: [],
        hookTrust: "pending",
      },
    ]);

    await useDashboardStore.getState().checkCodexHookTrust();

    expect(useDashboardStore.getState().codexHookTrust).toBe("pending");
  });

  it("sets codexHookTrust to null when no agent:codex entry is present at all", async () => {
    useDashboardStore.setState({ codexHookTrust: "pending" });
    stubListAgentsResponse([
      {
        id: "agent:claude",
        title: "claude",
        command: "claude",
        kind: "agent",
        available: true,
        path: null,
        emits: [],
      },
    ]);

    await useDashboardStore.getState().checkCodexHookTrust();

    expect(useDashboardStore.getState().codexHookTrust).toBeNull();
  });

  it("sets codexHookTrust to null when agent:codex is present but carries no hookTrust field (trusted/not-codex builds)", async () => {
    stubListAgentsResponse([
      {
        id: "agent:codex",
        title: "codex",
        command: "codex",
        kind: "agent",
        available: true,
        path: null,
        emits: [],
      },
    ]);

    await useDashboardStore.getState().checkCodexHookTrust();

    expect(useDashboardStore.getState().codexHookTrust).toBeNull();
  });

  it("fails silently and leaves codexHookTrust at its last-known state when the fetch rejects", async () => {
    useDashboardStore.setState({ codexHookTrust: "pending" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    await useDashboardStore.getState().checkCodexHookTrust();

    expect(useDashboardStore.getState().codexHookTrust).toBe("pending");
  });
});

describe("dismissCodexHookTrust (issue #259/#882)", () => {
  it("writes the current version to localStorage and to state", () => {
    useDashboardStore.setState({ currentVersion: "0.3.14" });

    useDashboardStore.getState().dismissCodexHookTrust();

    expect(useDashboardStore.getState().dismissedCodexHookTrustVersion).toBe("0.3.14");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("0.3.14");
  });

  it("is a no-op on localStorage when currentVersion is null — nothing to dismiss against yet", () => {
    useDashboardStore.setState({ currentVersion: null });

    useDashboardStore.getState().dismissCodexHookTrust();

    expect(useDashboardStore.getState().dismissedCodexHookTrustVersion).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
