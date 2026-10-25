import { describe, it, expect } from "vitest";
import type { GitPullReason } from "../api/types.js";
import { pullReasonMessage, reasonMessage } from "./gitReasons.js";

// The pull refusals have their own renderer — pullReasonMessage, the Git
// panel's — and their own copy, because the sidebar's one-line slot needs
// different words. This file is THAT copy's guard: the sidebar's copy has its
// own table in Sidebar.test.tsx.
//
// The table is a Record over GitPullReason, so it is EXHAUSTIVE by type: a
// new member of the union with no row here is a COMPILE error, not a silent
// fall-through to the default branch — which would tell the user the pull
// FAILED for a reason that is not a failure (issue #1896's "busy").
describe("pullReasonMessage copy", () => {
  const unionCases: Record<GitPullReason, RegExp> = {
    "not-a-repo": /Not a git repository/i,
    "unborn-head": /no commits/i,
    "detached-head": /detached HEAD/i,
    "no-upstream": /No upstream tracking branch/i,
    "dirty-tree": /uncommitted changes/i,
    "not-fast-forward": /diverged from upstream/i,
    "already-up-to-date": /Already up to date/i,
    "pull-failed": /The pull operation failed/i,
    busy: /already running/i,
  };

  for (const [reason, matches] of Object.entries(unionCases)) {
    it(`explains ${reason}`, () => {
      expect(pullReasonMessage(reason as GitPullReason, undefined)).toMatch(matches);
    });
  }

  it("includes the detail in a pull-failed message", () => {
    expect(pullReasonMessage("pull-failed", "conflict on README.md")).toMatch(
      /conflict on README\.md/i,
    );
  });

  it("says something sensible for a reason it has never heard of", () => {
    // A NEWER backend can send a reason this build does not know. That must
    // not throw, and must not claim the pull succeeded.
    const unknown = "a-reason-from-the-future" as GitPullReason;
    expect(pullReasonMessage(unknown, undefined)).toMatch(/failed/i);
  });

  it("says the pull failed when there is no reason at all", () => {
    // Not /failed/i: both "Action failed." and "Pull failed — try again."
    // match that, so it could not tell them apart. The copy says PULL.
    expect(pullReasonMessage(undefined, undefined)).toMatch(/^Pull failed/i);
  });

  // The shared renderer's default branch is the forward-compatibility path
  // for the branch and worktree refusals too: a reason this build has never
  // heard of must not throw, and must not claim the action succeeded.
  it("says something sensible for a refusal reason it has never heard of", () => {
    expect(reasonMessage("a-reason-from-the-future", undefined)).toMatch(/failed/i);
  });

  // The one reason the pull and the branch/worktree refusals share is
  // rendered by reasonMessage — one copy of that copy, on purpose.
  it("shares the not-a-repo copy with the branch and worktree refusals", () => {
    expect(pullReasonMessage("not-a-repo", undefined)).toBe(reasonMessage("not-a-repo", undefined));
  });
});
