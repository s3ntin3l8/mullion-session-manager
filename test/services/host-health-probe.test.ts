import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";
import { probeHealth } from "../../src/services/host-health-probe.js";

describe("probeHealth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is ok for a 2xx /health and down for anything else or a network failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await expect(probeHealth("http://h:1", 1000, () => undefined)).resolves.toBe("ok");
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 503 }));
    await expect(probeHealth("http://h:1", 1000, () => undefined)).resolves.toBe("down");
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(probeHealth("http://h:1", 1000, () => undefined)).resolves.toBe("down");
  });

  it("reports down, without fetching, when the dispatcher cannot be built", async () => {
    // The factory throws synchronously, as pinnedDispatcher() does for a URL the
    // policy refuses: it must not escape as a rejection.
    await expect(
      probeHealth("http://h:1", 1000, () => {
        throw new Error("blocked by policy");
      }),
    ).resolves.toBe("down");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RemoteHostClient.probe / ping", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("probes a baseUrl the policy now refuses as down instead of throwing", async () => {
    // baseUrl is re-read from the row on every call, so a URL that was fine at
    // registration can be refused by the time it is probed.
    const imds = new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://169.254.169.254",
      token: "tok",
    });
    await expect(imds.probe()).resolves.toBe("down");
    await expect(imds.ping()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps ping and probe prototype methods, not instance fields a prototype spy would miss", () => {
    const names = Object.getOwnPropertyNames(RemoteHostClient.prototype);
    expect(names).toContain("ping");
    expect(names).toContain("probe");
    const own = Object.getOwnPropertyNames(
      new RemoteHostClient({ hostId: "h1", baseUrl: "http://example.invalid:1234/", token: "tok" }),
    );
    expect(own).not.toContain("ping");
    expect(own).not.toContain("probe");
  });
});
