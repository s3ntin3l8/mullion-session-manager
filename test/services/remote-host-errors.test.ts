import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  HostOutcomeUnknownError,
  isIdempotentRequest,
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

// The mutations among the agent's `/internal` POST routes: an after-send close
// on one of these is an unknown outcome. Every route in routes/internal.ts must
// be here or classified read-only by isIdempotentRequest, so adding a route
// forces a decision (#2637).
const MUTATING_INTERNAL_POSTS = [
  "/internal/updates/apply",
  "/internal/git-pull",
  "/internal/git-checkout",
  "/internal/git-branch-create",
  "/internal/git-rebase",
  "/internal/git-push",
  "/internal/git-clone",
  "/internal/write-files",
  "/internal/project-files/write",
  "/internal/project-files/mkdir",
  "/internal/project-files/delete",
  "/internal/project-files/rename",
  "/internal/project-files/upload",
  "/internal/git-commit-wip",
  "/internal/run-generation-turn",
  "/internal/run-setup",
  "/internal/bundle-sync/remove",
  "/internal/git-worktree/resume",
  "/internal/git-worktree",
  "/internal/git-worktree/remove",
  "/internal/git-worktree/checkout",
  "/internal/git-worktree/force-remove",
  "/internal/git-worktree/sync",
  "/internal/git-worktree/clear-orphan",
  "/internal/git-worktree/prune",
  "/internal/git-branch-delete",
  "/internal/git-worktree/remove-listed",
  "/internal/git-worktree/prune-metadata",
  "/internal/sessions",
  "/internal/sessions/:id/terminate",
  "/internal/sessions/:id/stash-seed",
  "/internal/sessions/:id/promote",
  "/internal/sessions/:id/review-gate",
  "/internal/sessions/:id/attention/ack",
  "/internal/sessions/:id/prompt",
  "/internal/sessions/:id/wait-output",
  "/internal/uploads",
];

// Routes whose class depends on the body: git-repair plans unless confirm:true.
const BODY_DEPENDENT = ["/internal/git-repair"];

describe("isIdempotentRequest (#2637)", () => {
  const routes = [
    ...readFileSync("src/routes/internal.ts", "utf8").matchAll(
      /app\.post<[^\n]*>\(\s*"(\/internal\/[^"]+)"/g,
    ),
  ].map((m) => m[1]);

  it("finds the internal POST routes", () => {
    expect(routes.length).toBeGreaterThan(30);
  });

  it("classifies every /internal POST route as read-only or as a listed mutation", () => {
    const unclassified = routes.filter((r) => {
      if (MUTATING_INTERNAL_POSTS.includes(r) || BODY_DEPENDENT.includes(r)) return false;
      return !isIdempotentRequest("POST", r.replace(":id", "7"));
    });
    expect(unclassified).toEqual([]);
  });

  it("treats a listed mutation as non-idempotent and a read-only route as idempotent", () => {
    for (const r of MUTATING_INTERNAL_POSTS) {
      expect(isIdempotentRequest("POST", r.replace(":id", "7")), r).toBe(false);
    }
    expect(isIdempotentRequest("POST", "/internal/read-files")).toBe(true);
    expect(isIdempotentRequest("POST", "/internal/worktrees/compare-paths")).toBe(true);
    expect(isIdempotentRequest("GET", "/internal/config")).toBe(true);
  });

  it("treats git-repair as read-only only for the confirm:false plan", () => {
    const path = "/internal/git-repair";
    expect(isIdempotentRequest("POST", path, JSON.stringify({ cwd: "/w", confirm: false }))).toBe(
      true,
    );
    expect(isIdempotentRequest("POST", path, JSON.stringify({ cwd: "/w", confirm: true }))).toBe(
      false,
    );
    expect(isIdempotentRequest("POST", path)).toBe(false);
    expect(isIdempotentRequest("POST", path, "not json")).toBe(false);
  });
});
