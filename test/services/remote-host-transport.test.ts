import { describe, it, expect } from "vitest";
import { RemoteHostTransport } from "../../src/services/remote-host-transport.js";

// MULLION_ALLOW_TAILNET_HOSTS reaches connect time through the transport's
// own policy (the literal re-check, ahead of the pinned lookup).
describe("RemoteHostTransport tailnet policy", () => {
  const make = (baseUrl: string, allowSharedNat?: boolean) =>
    new RemoteHostTransport({ hostId: "h", baseUrl, token: "t", allowSharedNat });

  it("refuses a 100.64.0.0/10 baseUrl by default, for HTTP and WS", () => {
    const t = make("http://100.101.102.103:4000");
    expect(() => t.pinnedDispatcher()).toThrow();
    expect(() => t.pinnedWsOptions()).toThrow();
  });

  it("dials a 100.64.0.0/10 baseUrl when opted in", () => {
    const t = make("http://100.101.102.103:4000", true);
    expect(t.pinnedDispatcher()).toBeDefined();
    expect(t.pinnedWsOptions().agent).toBeDefined();
  });

  it("refuses IMDS even when opted in", () => {
    const t = make("http://169.254.169.254", true);
    expect(() => t.pinnedDispatcher()).toThrow();
    expect(() => t.pinnedWsOptions()).toThrow();
  });
});
