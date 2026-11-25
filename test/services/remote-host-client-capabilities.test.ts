// #3511 — the capabilities call's own request budget.
//
// The agent's Xcode probe may legitimately take its worst case (every step
// timing out, retried once) before it answers, so the primary's request must
// outlive it rather than give up at the 5 s default and read as "unknown".
//
// This file is separate from test/services/remote-host-client.test.ts
// because that file is at its file-size ceiling (the audit's guardrail).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { RemoteHostClient } = await import("../../src/services/remote-host-client.js");
const { XCODE_PROBE_WORST_CASE_MS } = await import("../../src/services/xcode-probe-budget.js");

function client() {
  return new RemoteHostClient({
    hostId: "h1",
    baseUrl: "http://example.invalid:1234/",
    token: "tok",
  });
}

describe("RemoteHostClient.detectCapabilities budget (#3511)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sizes its own timeout above the agent's worst-case Xcode probe", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ capabilities: ["xcode"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(client().detectCapabilities()).resolves.toEqual({ capabilities: ["xcode"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/capabilities",
      expect.anything(),
    );
    expect(timeoutSpy.mock.calls.at(-1)?.[0]).toBe(XCODE_PROBE_WORST_CASE_MS + 10_000);
    // 2 attempts × 3 steps × 30 s.
    expect(XCODE_PROBE_WORST_CASE_MS).toBe(180_000);
  });
});
