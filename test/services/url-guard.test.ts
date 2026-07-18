import { describe, it, expect } from "vitest";
import { isAllowedHttpUrl } from "../../src/services/url-guard.js";

const ALLOW_ALL = { allowLoopback: true, allowPrivate: true };
const BLOCK_ALL = { allowLoopback: false, allowPrivate: false };

describe("url-guard", () => {
  it("allows a normal public https URL under either policy", () => {
    expect(isAllowedHttpUrl("https://example.com/path", ALLOW_ALL)).toBe(true);
    expect(isAllowedHttpUrl("https://example.com/path", BLOCK_ALL)).toBe(true);
  });

  it("rejects a malformed URL and a non-http(s) scheme under either policy", () => {
    for (const policy of [ALLOW_ALL, BLOCK_ALL]) {
      expect(isAllowedHttpUrl("not-a-url", policy)).toBe(false);
      expect(isAllowedHttpUrl("ftp://example.com", policy)).toBe(false);
    }
  });

  it("always blocks link-local/cloud-IMDS (169.254.0.0/16), regardless of policy", () => {
    for (const policy of [ALLOW_ALL, BLOCK_ALL]) {
      expect(isAllowedHttpUrl("http://169.254.169.254/latest/meta-data", policy)).toBe(false);
      expect(isAllowedHttpUrl("http://169.254.1.1", policy)).toBe(false);
    }
  });

  it("always blocks RFC 6598 shared-NAT (100.64.0.0/10), regardless of policy", () => {
    for (const policy of [ALLOW_ALL, BLOCK_ALL]) {
      expect(isAllowedHttpUrl("http://100.64.0.1", policy)).toBe(false);
      expect(isAllowedHttpUrl("http://100.100.0.1", policy)).toBe(false);
    }
    // Just outside the /10 range on both sides — must NOT be blocked by this
    // specific check (may still be blocked by another rule under BLOCK_ALL).
    expect(isAllowedHttpUrl("http://100.63.255.255", ALLOW_ALL)).toBe(true);
    expect(isAllowedHttpUrl("http://100.128.0.1", ALLOW_ALL)).toBe(true);
  });

  it("always blocks the IPv6 link-local and AWS IMDS forms, regardless of policy", () => {
    for (const policy of [ALLOW_ALL, BLOCK_ALL]) {
      expect(isAllowedHttpUrl("http://[fe80::1]", policy)).toBe(false);
      expect(isAllowedHttpUrl("http://[fd00:ec2::254]", policy)).toBe(false);
    }
  });

  it("blocks an IPv4-mapped IPv6 literal that encodes a blocked IPv4 address", () => {
    // ::ffff:169.254.169.254 normalizes to ::ffff:a9fe:a9fe via URL parsing.
    for (const policy of [ALLOW_ALL, BLOCK_ALL]) {
      expect(isAllowedHttpUrl("http://[::ffff:169.254.169.254]", policy)).toBe(false);
    }
  });

  it("blocks an IPv4-*compatible* IPv6 literal (no ffff: prefix) that encodes a blocked IPv4 address", () => {
    // Distinct bypass from the mapped form above (Hermes review, PR #47's
    // second round): ::169.254.169.254 normalizes to ::a9fe:a9fe (no
    // "ffff:" prefix) via URL parsing, which the mapped-only regex missed.
    for (const policy of [ALLOW_ALL, BLOCK_ALL]) {
      expect(isAllowedHttpUrl("http://[::169.254.169.254]", policy)).toBe(false);
    }
  });

  it("blocks the IPv4-compatible loopback form under allowLoopback: false", () => {
    // ::127.0.0.1 normalizes to ::7f00:1.
    expect(isAllowedHttpUrl("http://[::127.0.0.1]/", BLOCK_ALL)).toBe(false);
    expect(isAllowedHttpUrl("http://[::127.0.0.1]/", ALLOW_ALL)).toBe(true);
  });

  describe("allowLoopback: false", () => {
    it("blocks IPv4 and IPv6 loopback", () => {
      expect(isAllowedHttpUrl("http://127.0.0.1", BLOCK_ALL)).toBe(false);
      expect(isAllowedHttpUrl("http://127.255.255.255", BLOCK_ALL)).toBe(false);
      expect(isAllowedHttpUrl("http://[::1]", BLOCK_ALL)).toBe(false);
    });

    it("blocks the IPv6 unspecified address :: (Hermes review, PR #47 — connects to localhost on most stacks, same as IPv4 0.0.0.0)", () => {
      expect(isAllowedHttpUrl("http://[::]", BLOCK_ALL)).toBe(false);
      expect(isAllowedHttpUrl("http://[::]:1", BLOCK_ALL)).toBe(false);
    });
  });

  describe("allowLoopback: true", () => {
    it("allows IPv4 and IPv6 loopback", () => {
      expect(isAllowedHttpUrl("http://127.0.0.1", ALLOW_ALL)).toBe(true);
      expect(isAllowedHttpUrl("http://[::1]", ALLOW_ALL)).toBe(true);
    });

    it("allows the IPv6 unspecified address ::", () => {
      expect(isAllowedHttpUrl("http://[::]", ALLOW_ALL)).toBe(true);
    });
  });

  describe("allowPrivate: false", () => {
    it("blocks RFC1918 IPv4 private ranges", () => {
      expect(isAllowedHttpUrl("http://10.0.0.1", BLOCK_ALL)).toBe(false);
      expect(isAllowedHttpUrl("http://172.16.0.1", BLOCK_ALL)).toBe(false);
      expect(isAllowedHttpUrl("http://172.31.255.255", BLOCK_ALL)).toBe(false);
      expect(isAllowedHttpUrl("http://192.168.1.1", BLOCK_ALL)).toBe(false);
      expect(isAllowedHttpUrl("http://0.0.0.0", BLOCK_ALL)).toBe(false);
    });

    it("does not block addresses just outside the 172.16.0.0/12 range", () => {
      expect(isAllowedHttpUrl("http://172.15.255.255", BLOCK_ALL)).toBe(true);
      expect(isAllowedHttpUrl("http://172.32.0.0", BLOCK_ALL)).toBe(true);
    });

    it("blocks the IPv6 unique-local range (fc00::/7)", () => {
      expect(isAllowedHttpUrl("http://[fc00::1]", BLOCK_ALL)).toBe(false);
      expect(isAllowedHttpUrl("http://[fd12:3456::1]", BLOCK_ALL)).toBe(false);
    });
  });

  describe("allowPrivate: true", () => {
    it("allows RFC1918 IPv4 private ranges and IPv6 unique-local", () => {
      expect(isAllowedHttpUrl("http://10.0.0.1", ALLOW_ALL)).toBe(true);
      expect(isAllowedHttpUrl("http://172.16.0.1", ALLOW_ALL)).toBe(true);
      expect(isAllowedHttpUrl("http://192.168.1.1", ALLOW_ALL)).toBe(true);
      expect(isAllowedHttpUrl("http://[fc00::1]", ALLOW_ALL)).toBe(true);
    });
  });

  it("does not resolve hostnames — a private-looking hostname is not blocked (documented gap)", () => {
    // No DNS resolution happens here; only IP literals are classified. See
    // the function's own comment on this being the same known gap as
    // remote-host-client.ts's connect-time pinning deferral.
    expect(isAllowedHttpUrl("http://internal.corp.example", BLOCK_ALL)).toBe(true);
  });
});
