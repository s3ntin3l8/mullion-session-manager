import { describe, expect, it, vi } from "vitest";
import type { GitHubPROrWithChecks } from "../api/types.js";
import { prTriad } from "./prTriad.js";

const pr = (over: Partial<GitHubPROrWithChecks>) =>
  ({
    ciStatus: "success",
    mergeable: "MERGEABLE",
    isDraft: false,
    ...over,
  }) as GitHubPROrWithChecks;

describe("prTriad merge chip", () => {
  const merge = (over: Partial<GitHubPROrWithChecks>) =>
    prTriad(pr(over), vi.fn()).find((i) => i.key === "merge")!;

  it("names a strict-protection behind PR rather than calling it unknown", () => {
    expect(merge({ prPhase: "behind", mergeStateStatus: "BEHIND" })).toMatchObject({
      tone: "warn",
      label: "Behind",
      title: "Blocked: behind base",
    });
  });

  it("still reads ready, blocked and unknown as before", () => {
    expect(merge({ prPhase: "ready_to_merge" }).label).toBe("Ready");
    expect(merge({ mergeStateStatus: "BLOCKED" }).label).toBe("Blocked");
    expect(merge({}).label).toBe("Unknown");
  });
});
