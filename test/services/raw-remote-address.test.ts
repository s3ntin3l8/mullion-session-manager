import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { getRawRemoteAddress } from "../../src/services/raw-remote-address.js";

// A minimal fake, not a real FastifyRequest — only the shape this function
// actually reads. `.ip` is deliberately given a DIFFERENT value than
// `.raw.socket.remoteAddress` in the first test: this app never enables
// trustProxy (so the two are identical in every real request this process
// handles today — see enrollment.test.ts's own note on why that makes an
// app.inject()-level regression test for AS7 impossible to fail on the
// unfixed code), so a fake request is the only way to actually pin "this
// reads the raw socket value, not request.ip" as a unit-level invariant.
function fakeRequest(remoteAddress: string | undefined, ip = "203.0.113.99"): FastifyRequest {
  return {
    ip,
    raw: { socket: { remoteAddress } },
  } as unknown as FastifyRequest;
}

describe("getRawRemoteAddress (finding AS7)", () => {
  it("reads request.raw.socket.remoteAddress, ignoring a different request.ip", () => {
    const request = fakeRequest("127.0.0.1", "203.0.113.99");
    expect(getRawRemoteAddress(request)).toBe("127.0.0.1");
  });

  it("falls back to '' (never undefined) when the raw socket has no remoteAddress", () => {
    const request = fakeRequest(undefined);
    expect(getRawRemoteAddress(request)).toBe("");
  });
});
