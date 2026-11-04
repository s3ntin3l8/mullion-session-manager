import { describe, it, expect } from "vitest";
import { buildPairingLink, parsePairingLink } from "../../src/shared/pairing-link.js";

const code = "ab".repeat(32);

describe("pairing link (issue #2449)", () => {
  it("round-trips the primary url and code, and carries nothing else", () => {
    const link = buildPairingLink({ url: "https://m.example.com:8443", code });
    expect(link).toBe(
      `mullion://pair?url=${encodeURIComponent("https://m.example.com:8443")}&code=${code}`,
    );
    expect(parsePairingLink(` ${link} `)).toEqual({ url: "https://m.example.com:8443", code });
  });

  it.each([
    ["not a url", "garbage"],
    ["wrong scheme", `https://pair?url=https%3A%2F%2Fx&code=${"ab".repeat(32)}`],
    ["wrong action", `mullion://other?url=https%3A%2F%2Fx.test&code=${"ab".repeat(32)}`],
    ["missing code", "mullion://pair?url=https%3A%2F%2Fx.test"],
    ["short code", "mullion://pair?url=https%3A%2F%2Fx.test&code=abc"],
    ["non-http url", `mullion://pair?url=ftp%3A%2F%2Fx.test&code=${"ab".repeat(32)}`],
    ["extra param", `mullion://pair?url=https%3A%2F%2Fx.test&code=${"ab".repeat(32)}&token=x`],
  ])("rejects %s", (_name, link) => {
    expect(parsePairingLink(link)).toBeNull();
  });
});
