import { describe, expect, it } from "vitest";
import {
  EMPTY_NOTE_ROW_ESTIMATE,
  estimateSidebarRowHeight,
  PROJECT_HEADER_ROW_ESTIMATE,
  SESSION_ROW_ESTIMATE_COLLAPSED,
  SESSION_ROW_ESTIMATE_EXPANDED,
} from "./sidebarRowSizing.js";

describe("estimateSidebarRowHeight", () => {
  it("returns the collapsed session estimate for an undefined row (virtualizer edge case)", () => {
    expect(estimateSidebarRowHeight(undefined, new Set())).toBe(SESSION_ROW_ESTIMATE_COLLAPSED);
  });

  it("returns the project header estimate for a header row", () => {
    expect(estimateSidebarRowHeight({ type: "header" }, new Set())).toBe(
      PROJECT_HEADER_ROW_ESTIMATE,
    );
  });

  it("returns the empty-note estimate for an empty row", () => {
    expect(estimateSidebarRowHeight({ type: "empty" }, new Set())).toBe(EMPTY_NOTE_ROW_ESTIMATE);
  });

  it("returns the collapsed session estimate when the session's id is not in expandedSessionRowIds", () => {
    const row = { type: "session" as const, session: { id: 1 } };
    expect(estimateSidebarRowHeight(row, new Set([2, 3]))).toBe(SESSION_ROW_ESTIMATE_COLLAPSED);
  });

  it("returns the expanded session estimate when the session's id IS in expandedSessionRowIds", () => {
    const row = { type: "session" as const, session: { id: 1 } };
    expect(estimateSidebarRowHeight(row, new Set([1, 2]))).toBe(SESSION_ROW_ESTIMATE_EXPANDED);
  });

  it("is a pure function of its arguments — same inputs, same output, no shared state across calls", () => {
    const expanded = new Set([1]);
    const collapsedRow = { type: "session" as const, session: { id: 2 } };
    const expandedRow = { type: "session" as const, session: { id: 1 } };
    expect(estimateSidebarRowHeight(collapsedRow, expanded)).toBe(SESSION_ROW_ESTIMATE_COLLAPSED);
    expect(estimateSidebarRowHeight(expandedRow, expanded)).toBe(SESSION_ROW_ESTIMATE_EXPANDED);
    // Calling again in the opposite order must produce the same results —
    // nothing here is order-dependent or mutates its inputs.
    expect(estimateSidebarRowHeight(expandedRow, expanded)).toBe(SESSION_ROW_ESTIMATE_EXPANDED);
    expect(estimateSidebarRowHeight(collapsedRow, expanded)).toBe(SESSION_ROW_ESTIMATE_COLLAPSED);
  });
});
