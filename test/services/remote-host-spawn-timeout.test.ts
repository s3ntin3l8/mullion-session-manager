import { describe, it, expect, vi, afterEach } from "vitest";

const { RemoteHostClient } = await import("../../src/services/remote-host-client.js");

// #3557 — the agent answers a spawn once the launch has run (bounded by its own
// 30 s supervisor timeout), so the primary waits longer than its 5 s default:
// otherwise a slow but successful launch on a loaded Mac reads as an unknown
// outcome.
describe("RemoteHostClient.spawn's budget", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("gives a spawn time for the agent's launch to finish", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const client = new RemoteHostClient({
        hostId: "h1",
        baseUrl: "http://example.invalid:1234/",
        token: "tok",
      });
      await client.spawn({ id: "1", cwd: "/w", command: "bash", cols: 80, rows: 24 });
      expect(timeout).toHaveBeenCalledWith(45_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
