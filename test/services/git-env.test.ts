import { describe, it, expect, afterEach } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";

// Issue #442, Hermes review on PR #505 — `%(upstream:track)`'s "ahead N" /
// "behind N" / "gone" text (git-refs.ts's listBranches) is gettext-
// localized by git's own ref-filter.c, and git-branch-delete.ts's
// `/not fully merged/i` stderr classification has the identical exposure.
// Asserted here as a unit-level contract on gitEnv() itself rather than an
// end-to-end non-C-locale integration test: this sandbox's git build has no
// installed NLS translations (empirically verified — a de_DE locale doesn't
// actually localize `for-each-ref`'s output here), so a locale-dependent
// integration test would be a false negative in exactly the environment
// most likely to run this suite, not a reliable regression guard.
describe("gitEnv (issue #442)", () => {
  const originalLcAll = process.env.LC_ALL;
  const originalLang = process.env.LANG;

  afterEach(() => {
    if (originalLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
    if (originalLang === undefined) delete process.env.LANG;
    else process.env.LANG = originalLang;
  });

  it("forces LC_ALL=C regardless of the ambient process locale", () => {
    process.env.LANG = "de_DE.UTF-8";
    process.env.LC_ALL = "de_DE.UTF-8";
    expect(gitEnv().LC_ALL).toBe("C");
  });

  it("still strips every GIT_* var alongside the locale pin (#205)", () => {
    process.env.GIT_DIR = "/tmp/should-be-stripped";
    try {
      const env = gitEnv();
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.LC_ALL).toBe("C");
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
