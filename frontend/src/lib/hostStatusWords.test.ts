// Issue #3286 — the plain-text twin of HostStatusLabel, used in SessionRow's
// aria-label so a screen reader hears the same words the label shows.
import { describe, it, expect } from "vitest";
import { hostStatusWords, PARKED_WORD } from "./hostStatusWords.js";
import { makeHost } from "../test/fixtures.js";

describe("hostStatusWords", () => {
  it("says the heartbeat's word", () => {
    expect(hostStatusWords(makeHost({ health: "offline" }))).toBe("unreachable");
    expect(hostStatusWords(makeHost({ health: "online" }))).toBe("online");
  });

  it("adds parked for a drained host", () => {
    expect(hostStatusWords(makeHost({ health: "offline", drained: true }))).toBe(
      "unreachable parked",
    );
  });

  it("says the same parked word HostStatusLabel renders", () => {
    expect(PARKED_WORD).toBe("parked");
    expect(
      hostStatusWords(makeHost({ health: "online", drained: true }))?.endsWith(PARKED_WORD),
    ).toBe(true);
  });

  it("says nothing for a host with no known health", () => {
    expect(
      hostStatusWords(makeHost({ health: "bogus" as unknown as "online", drained: false })),
    ).toBeNull();
  });
});
