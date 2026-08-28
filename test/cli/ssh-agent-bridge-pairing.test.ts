import { describe, it, expect } from "vitest";
import { encodePairingPayload } from "../../src/services/bridge-registry.js";
import { decodePairingPayload } from "../../src/cli/ssh-agent-bridge-pairing.mjs";

// Issue #820 (PR6) — the discriminating test for the .mjs decoder: it must
// decode exactly what the real server's encodePairingPayload() produces,
// not just whatever this file's own (potentially independently-wrong)
// encoding convention happens to be.
describe("ssh-agent-bridge-pairing.mjs decodePairingPayload vs. the real bridge-registry.ts encodePairingPayload", () => {
  it("round-trips a real server-encoded payload", () => {
    const encoded = encodePairingPayload({
      baseUrl: "https://mullion.example.com",
      code: "abc123",
    });
    expect(decodePairingPayload(encoded)).toEqual({
      baseUrl: "https://mullion.example.com",
      code: "abc123",
    });
  });

  it("returns null for garbage input rather than throwing", () => {
    expect(decodePairingPayload("not-base64url-json")).toBeNull();
    expect(decodePairingPayload("")).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    const encoded = Buffer.from(JSON.stringify({ baseUrl: "https://x" }), "utf8").toString(
      "base64url",
    );
    expect(decodePairingPayload(encoded)).toBeNull();
  });

  it("returns null when a field is present but the wrong type", () => {
    const encoded = Buffer.from(JSON.stringify({ baseUrl: 1, code: "x" }), "utf8").toString(
      "base64url",
    );
    expect(decodePairingPayload(encoded)).toBeNull();
  });
});
