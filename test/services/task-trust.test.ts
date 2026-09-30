import { describe, expect, it } from "vitest";
import { isTrustedAuthor } from "../../src/services/task-trust.js";

const none = new Set<string>();

describe("isTrustedAuthor", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR", "owner"])("trusts association %s", (a) => {
    expect(isTrustedAuthor(a, "someone", none)).toBe(true);
  });

  it.each(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "MANNEQUIN"])(
    "does not trust association %s",
    (a) => {
      expect(isTrustedAuthor(a, "someone", none)).toBe(false);
    },
  );

  it("fails closed on a missing association", () => {
    expect(isTrustedAuthor(undefined, "someone", none)).toBe(false);
    expect(isTrustedAuthor(undefined, null, none)).toBe(false);
  });

  it("trusts an allowlisted login case-insensitively, regardless of association", () => {
    const allow = new Set(["hermes-bot"]);
    expect(isTrustedAuthor("NONE", "Hermes-Bot", allow)).toBe(true);
    expect(isTrustedAuthor(undefined, "hermes-bot", allow)).toBe(true);
    expect(isTrustedAuthor("NONE", "other", allow)).toBe(false);
  });
});
