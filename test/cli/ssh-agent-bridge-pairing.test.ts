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

  // Issue #1055 — a very large base64url payload must be rejected up
  // front, not decoded to a multi-MB UTF-8 string and parsed by JSON.parse.
  it("returns null for an oversized payload (defense-in-depth, max 8KB)", () => {
    const oversized = "A".repeat(16_000);
    expect(decodePairingPayload(oversized)).toBeNull();
  });

  // Issue #1055 — defense-in-depth: baseUrl must be a well-formed HTTP(S)
  // URL at decode time, not just at the helper's later isValidHttpBaseUrl
  // check. Catches the failure class earlier.
  it("returns null when baseUrl isn't a well-formed HTTP(S) URL", () => {
    const encoded = Buffer.from(
      JSON.stringify({ baseUrl: "not a url", code: "abc" }),
      "utf8",
    ).toString("base64url");
    expect(decodePairingPayload(encoded)).toBeNull();
  });

  it("returns null when baseUrl uses a non-http scheme (file://, ssh://, javascript:)", () => {
    for (const scheme of ["file:///etc/passwd", "ssh://example.com", "javascript:alert(1)"]) {
      const encoded = Buffer.from(
        JSON.stringify({ baseUrl: scheme, code: "abc" }),
        "utf8",
      ).toString("base64url");
      expect(decodePairingPayload(encoded)).toBeNull();
    }
  });
});
