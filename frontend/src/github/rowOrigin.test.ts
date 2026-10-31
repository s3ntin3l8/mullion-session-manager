import { describe, it, expect } from "vitest";
import type { GitHubIssueListItem, GitHubPROrWithChecks } from "../api/types.js";
import type { MullionLinkEntry, SessionLink } from "../hooks/useMullionLinks.js";
import { issueOrigin, matchesOrigin, needsAttention, originClass, prOrigin } from "./rowOrigin.js";

const pr = (o: Partial<GitHubPROrWithChecks> = {}) => ({ number: 1, ...o }) as GitHubPROrWithChecks;
const issue = (o: Partial<GitHubIssueListItem> = {}) =>
  ({ number: 1, ...o }) as GitHubIssueListItem;
const link = (o: Partial<MullionLinkEntry>) =>
  ({ sessions: [], task: null, ...o }) as MullionLinkEntry;
const session = (id: number): SessionLink => ({
  session: { id } as never,
  severity: "info" as never,
  attention: false,
  children: [],
});

describe("rowOrigin", () => {
  it("calls a PR Task Master's when a task is linked, even before the link join lands", () => {
    expect(prOrigin(pr(), link({ task: { id: 3 } as never }))).toBe("tm");
    expect(prOrigin(pr({ taskId: 3 }), undefined)).toBe("tm");
  });

  it("calls a PR manual when only hand-started sessions are on it", () => {
    expect(prOrigin(pr(), link({ sessions: [session(7)] }))).toBe("manual");
    expect(prOrigin(pr(), undefined)).toBe("none");
  });

  it("keeps a task's own worker out of the manual count, but a second session still counts", () => {
    // The task owns session 9; the join found no task on the row (task null) but sees both.
    const owned = { id: 3, sessionId: 9, reviewSessionId: null } as never;
    expect(prOrigin(pr(), link({ task: owned, sessions: [session(9)] }))).toBe("tm");
    expect(issueOrigin(issue(), link({ sessions: [session(7), session(9)] }))).toBe("manual");
  });

  it("reads an issue's task from the list item's status as well as the link", () => {
    expect(issueOrigin(issue({ taskStatus: "ready" }), undefined)).toBe("tm");
    expect(issueOrigin(issue(), link({ sessions: [session(7)] }))).toBe("manual");
    expect(issueOrigin(issue(), undefined)).toBe("none");
  });

  it("filters by origin, with All matching everything", () => {
    expect(matchesOrigin("all", "none")).toBe(true);
    expect(matchesOrigin("tm", "tm")).toBe(true);
    expect(matchesOrigin("tm", "manual")).toBe(false);
    expect(matchesOrigin("manual", "none")).toBe(false);
  });

  it("marks the row edge by origin, and flags PRs that want the user", () => {
    expect(originClass("tm")).toBe("sb-row--tm");
    expect(originClass("manual")).toBe("sb-row--manual");
    expect(originClass("none")).toBe("");
    expect(needsAttention({ prPhase: "ci_failing" })).toBe(true);
    expect(needsAttention({ prPhase: "ready_to_merge" })).toBe(false);
    expect(needsAttention({})).toBe(false);
  });
});
