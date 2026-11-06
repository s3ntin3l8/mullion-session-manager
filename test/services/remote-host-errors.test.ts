import { describe, it, expect } from "vitest";
import {
  HostOutcomeUnknownError,
  HostUnreachableError,
  isOutcomeUnknown,
} from "../../src/services/remote-host-errors.js";

describe("isOutcomeUnknown (#2621)", () => {
  it("is true for HostOutcomeUnknownError", () => {
    expect(isOutcomeUnknown(new HostOutcomeUnknownError("h1", new Error("closed")))).toBe(true);
  });

  it("is true for a duck-typed error carrying outcomeUnknown (module-identity safe)", () => {
    expect(isOutcomeUnknown(Object.assign(new Error("x"), { outcomeUnknown: true }))).toBe(true);
  });

  it("is false for a plain unreachable error, a falsy flag, and non-errors", () => {
    expect(isOutcomeUnknown(new HostUnreachableError("h1", new Error("down")))).toBe(false);
    expect(isOutcomeUnknown(Object.assign(new Error("x"), { outcomeUnknown: false }))).toBe(false);
    expect(isOutcomeUnknown(null)).toBe(false);
    expect(isOutcomeUnknown("outcomeUnknown")).toBe(false);
  });
});
