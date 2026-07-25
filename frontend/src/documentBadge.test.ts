import { describe, it, expect } from "vitest";
import { countAttentionRequired, formatDocumentTitle, BASE_TITLE } from "./documentBadge.js";

describe("countAttentionRequired", () => {
  it("returns 0 for no sessions", () => {
    expect(countAttentionRequired([])).toBe(0);
  });

  it("counts only sessions with sessionStatusAttentionRequired true", () => {
    const sessions = [
      { sessionStatusAttentionRequired: true },
      { sessionStatusAttentionRequired: false },
      { sessionStatusAttentionRequired: true },
    ];
    expect(countAttentionRequired(sessions)).toBe(2);
  });
});

describe("formatDocumentTitle", () => {
  it("returns the bare base title when count is zero", () => {
    expect(formatDocumentTitle(0)).toBe(BASE_TITLE);
  });

  it("prefixes the count when positive", () => {
    expect(formatDocumentTitle(3)).toBe(`(3) ${BASE_TITLE}`);
  });

  it("caps the visible count at 9+", () => {
    expect(formatDocumentTitle(10)).toBe(`(9+) ${BASE_TITLE}`);
    expect(formatDocumentTitle(9)).toBe(`(9) ${BASE_TITLE}`);
  });

  it("accepts a custom base title", () => {
    expect(formatDocumentTitle(2, "Custom")).toBe("(2) Custom");
    expect(formatDocumentTitle(0, "Custom")).toBe("Custom");
  });
});
