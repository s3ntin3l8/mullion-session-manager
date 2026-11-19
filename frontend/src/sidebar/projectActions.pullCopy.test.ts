import { describe, it, expect } from "vitest";
import type { GitPullReason } from "../api/index.js";
import { formatPullReasonMessage } from "./projectActions.js";

// One case per GitPullReason, plus the unknown-reason default: cheap, and it
// locks down copy drift. Moved here from Sidebar.test.tsx when the formatter
// moved to projectActions.ts; that file still covers a refused pull reaching
// the project row.
describe("formatPullReasonMessage copy", () => {
  // The record is EXHAUSTIVE on purpose, and typed as GitPullReason: a
  // new member of the union with no case here is a COMPILE error, not a
  // silent fall-through to the default branch — which would tell the user
  // the pull FAILED for a reason that is not a failure (issue #1896's
  // "busy"). The union is the shared thing; the two renderers' copy is
  // deliberately their own.
  const unionCases: Record<GitPullReason, RegExp> = {
    "not-a-repo": /Not a git repository/i,
    "unborn-head": /unborn branch/i,
    "detached-head": /detached HEAD/i,
    "no-upstream": /no upstream/i,
    "dirty-tree": /Working tree has uncommitted changes/i,
    "not-fast-forward": /diverged from origin/i,
    "already-up-to-date": /Already up to date/i,
    "pull-failed": /The pull operation failed/i,
    busy: /already running/i,
    "stale-lock": /leftover git lock/i,
  };

  const cases: Array<{ reason: string; detail?: string; matches: RegExp }> = [
    ...Object.entries(unionCases).map(([reason, matches]) => ({ reason, matches })),
    { reason: "pull-failed", detail: "conflict on README.md", matches: /conflict on README\.md/i },
    { reason: "totally-unknown-reason", detail: "boom", matches: /Pull failed: boom/i },
    { reason: "totally-unknown-reason", matches: /Pull failed/i },
  ];

  for (const c of cases) {
    it(`has copy for ${c.reason}${c.detail ? ` (with detail "${c.detail}")` : ""}`, () => {
      expect(formatPullReasonMessage(c.reason, c.detail)).toMatch(c.matches);
    });
  }
});
