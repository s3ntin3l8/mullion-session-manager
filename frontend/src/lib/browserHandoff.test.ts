import { describe, expect, it } from "vitest";
import { addressHandoffRefusal, HANDOFF_LOOPBACK, isLoopbackAddress } from "./browserHandoff.js";

// #3373 — the same loopback vectors the server's isLoopbackHostname is tested
// against (test/routes/browser-handoff.test.ts), so the two copies of the
// predicate cannot drift apart.
// import.meta.glob rather than node:fs (browser-only tsconfig).
const files = import.meta.glob("../../../test/fixtures/loopback-hosts.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const vectors = JSON.parse(Object.values(files)[0]!) as {
  loopback: string[];
  notLoopback: string[];
};

describe("isLoopbackAddress", () => {
  it.each(vectors.loopback)("treats %s as loopback", (url) => {
    expect(isLoopbackAddress(url)).toBe(true);
  });
  it.each(vectors.notLoopback)("does not treat %s as loopback", (url) => {
    expect(isLoopbackAddress(url)).toBe(false);
  });
});

describe("addressHandoffRefusal", () => {
  it("refuses a root-qualified localhost. address", () => {
    expect(addressHandoffRefusal("http://localhost.:5173/")).toBe(HANDOFF_LOOPBACK);
  });
});
