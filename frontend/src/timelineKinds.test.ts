import { describe, it, expect } from "vitest";
import { ALL_KINDS } from "./eventDescriptions.js";
import {
  IMPORTANT_KINDS,
  KIND_GROUPS,
  KIND_OPTION_LABELS,
  timelinePreset,
} from "./timelineKinds.js";
import type { TimelineKind } from "./timelineKinds.js";

describe("KIND_GROUPS", () => {
  it("puts every kind in ALL_KINDS in exactly one group, so a new kind cannot miss the popover", () => {
    const seen = new Map<TimelineKind, number>();
    for (const group of KIND_GROUPS) {
      for (const kind of group.kinds) seen.set(kind, (seen.get(kind) ?? 0) + 1);
    }
    const missing = ALL_KINDS.filter((kind) => !seen.has(kind));
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([kind]) => kind);
    const unknown = [...seen.keys()].filter((kind) => !ALL_KINDS.includes(kind));
    expect({ missing, duplicated, unknown }).toEqual({ missing: [], duplicated: [], unknown: [] });
  });

  it("gives every kind in the popover its own label (the two PR CI kinds share one pill label)", () => {
    expect(KIND_OPTION_LABELS.pr_ci_failed).not.toBe(KIND_OPTION_LABELS.pr_ci_passed);
  });
});

describe("timelinePreset", () => {
  it("reads the default selection as Important, which leaves out title and file changes", () => {
    expect(IMPORTANT_KINDS).not.toContain("title_change");
    expect(IMPORTANT_KINDS).not.toContain("file_change");
    expect(timelinePreset(new Set(IMPORTANT_KINDS))).toBe("important");
  });

  it("reads every kind as All", () => {
    expect(timelinePreset(new Set(ALL_KINDS))).toBe("all");
  });

  it("reads any other selection as Custom", () => {
    expect(timelinePreset(new Set<TimelineKind>(["attention"]))).toBe("custom");
    expect(timelinePreset(new Set<TimelineKind>())).toBe("custom");
    // One kind short of Important, and Important plus one extra.
    expect(timelinePreset(new Set(IMPORTANT_KINDS.slice(1)))).toBe("custom");
    expect(timelinePreset(new Set([...IMPORTANT_KINDS, "file_change" as const]))).toBe("custom");
  });
});
