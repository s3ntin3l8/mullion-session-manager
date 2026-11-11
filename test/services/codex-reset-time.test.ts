import { describe, expect, it } from "vitest";
import { parseCodexResetTime } from "../../src/services/codex-reset-time.js";

const before = new Date(2026, 0, 1, 0, 0, 0, 0);

describe("parseCodexResetTime", () => {
  it("parses Codex's ordinal date", () => {
    const parsed = parseCodexResetTime("try again at Nov 4th, 2026 3:39 AM", before);
    expect(parsed).not.toBeNull();
    expect(parsed!.getFullYear()).toBe(2026);
    expect(parsed!.getMonth()).toBe(10);
    expect(parsed!.getDate()).toBe(4);
    expect(parsed!.getHours()).toBe(3);
    expect(parsed!.getMinutes()).toBe(39);
  });

  it("parses a comma after the year and a trailing period", () => {
    const parsed = parseCodexResetTime("try again at Aug 10, 2026, 5:59 AM.", before);
    expect(parsed).not.toBeNull();
    expect(parsed!.getMonth()).toBe(7);
    expect(parsed!.getDate()).toBe(10);
    expect(parsed!.getHours()).toBe(5);
    expect(parsed!.getMinutes()).toBe(59);
  });

  it("parses an ISO instant", () => {
    const parsed = parseCodexResetTime("try again at 2026-08-10T03:59:00.000Z", before);
    expect(parsed?.toISOString()).toBe("2026-08-10T03:59:00.000Z");
  });

  it("treats 12 AM as midnight and 12 PM as noon", () => {
    expect(parseCodexResetTime("try again at Jan 2nd, 2026 12:00 AM", before)!.getHours()).toBe(0);
    expect(parseCodexResetTime("try again at Jan 2nd, 2026 12:00 PM", before)!.getHours()).toBe(12);
  });

  it("rejects a time-only phrase, a missing phrase, and a non-date", () => {
    expect(parseCodexResetTime("try again at 8:00 PM", before)).toBeNull();
    expect(parseCodexResetTime("exceeded retry limit, last status: 429", before)).toBeNull();
    expect(parseCodexResetTime(null, before)).toBeNull();
  });

  it("rejects a calendar date that does not exist", () => {
    expect(parseCodexResetTime("try again at Feb 31st, 2026 1:00 AM", before)).toBeNull();
  });

  it("rejects a reset that is not still in the future", () => {
    const now = new Date(2026, 10, 4, 3, 39, 0, 0);
    expect(parseCodexResetTime("try again at Nov 4th, 2026 3:39 AM", now)).toBeNull();
    expect(
      parseCodexResetTime("try again at Nov 4th, 2026 3:39 AM", new Date(now.getTime() + 1)),
    ).toBeNull();
  });
});
