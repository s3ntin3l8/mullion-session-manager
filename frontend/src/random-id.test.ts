// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { randomPanelId } from "./random-id.js";

describe("randomPanelId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID() when available (a secure context)", () => {
    expect(randomPanelId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to a random id without throwing when crypto.randomUUID is unavailable (a plain-http LAN/Tailscale deployment — a non-secure context)", () => {
    vi.stubGlobal("crypto", { ...crypto, randomUUID: undefined });
    expect(() => randomPanelId()).not.toThrow();
    const id = randomPanelId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
