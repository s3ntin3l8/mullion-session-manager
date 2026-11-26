// #3524 — the agent-list call's own request budget.
//
// On a cold cache the agent's /internal/agents first waits on the
// interactive-PATH resolve (10 s by default) and then on the login-shell
// probes, so the 5 s default would time the primary out of exactly the read
// that recovers a slow rc file.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { RemoteHostClient } = await import("../../src/services/remote-host-client.js");
const { AGENTS_REQUEST_TIMEOUT_MS } = await import("../../src/services/remote-host-client-core.js");
const { DEFAULT_RESOLVE_TIMEOUT_MS } = await import("../../src/services/user-shell-env.js");

describe("RemoteHostClient.detectAgents budget (#3524)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("outlives the agent's default interactive-PATH resolve plus its probes", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://example.invalid:1234/",
      token: "tok",
    });

    await expect(client.detectAgents()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/agents",
      expect.anything(),
    );
    expect(timeoutSpy.mock.calls.at(-1)?.[0]).toBe(AGENTS_REQUEST_TIMEOUT_MS);
    // resolve + 2 s kill escalation + the 5 s login-shell probe, with headroom.
    expect(AGENTS_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_RESOLVE_TIMEOUT_MS + 2_000 + 5_000);
  });
});
