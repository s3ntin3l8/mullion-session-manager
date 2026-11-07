import Fastify from "fastify";
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
// forces a decision (#2637). Read from the registered route table (onRoute), so
// a route in any file, with or without the `app.post<...>` generic, is seen.
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
  // Live-browser actions (click, type, navigate, find) and proxied dev-server POSTs
  // act on a running page or server: never assume a repeat is safe.
  "/internal/sessions/:id/browser",
  "/internal/sessions/:id/browser/find",
  "/internal/browser/close",
  "/internal/browser/forget",
  "/internal/configured-preview",
  "/internal/preview/:port/*",
  "/internal/uploads",
];

// Routes whose class depends on the body: git-repair plans unless confirm:true.
const BODY_DEPENDENT = ["/internal/git-repair"];

const internalRoutes = await (async () => {
  const { internalRoutes: plugin } = await import("../../src/routes/internal.js");
  const app = Fastify();
  const posts: string[] = [];
  app.addHook("onRoute", (o) => {
    if ([o.method].flat().includes("POST")) posts.push(o.url);
  });
  await app.register(plugin);
  await app.ready();
  await app.close();
  return posts;
})();

describe("isIdempotentRequest (#2637)", () => {
  const routes = internalRoutes;
  const concrete = (r: string) =>
    r.replaceAll(":id", "7").replaceAll(":port", "3000").replaceAll("*", "x");

  it("finds the internal POST routes", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes).toContain("/internal/sessions/:id/wait-output");
  });

  it("classifies every /internal POST route as read-only or as a listed mutation", () => {
    const unclassified = routes.filter((r) => {
      if (MUTATING_INTERNAL_POSTS.includes(r) || BODY_DEPENDENT.includes(r)) return false;
      return !isIdempotentRequest("POST", concrete(r));
    });
    expect(unclassified).toEqual([]);
  });

  it("has no stale entry: every listed mutation and body-dependent route is registered", () => {
    const registered = new Set(routes);
    expect(
      [...MUTATING_INTERNAL_POSTS, ...BODY_DEPENDENT].filter((r) => !registered.has(r)),
    ).toEqual([]);
  });

  it("does not list a read-only route as a mutation", () => {
    const both = MUTATING_INTERNAL_POSTS.filter((r) => isIdempotentRequest("POST", concrete(r)));
    expect(both).toEqual([]);
  });

  it("treats a listed mutation as non-idempotent and a read-only route as idempotent", () => {
    for (const r of MUTATING_INTERNAL_POSTS) {
      expect(isIdempotentRequest("POST", concrete(r)), r).toBe(false);
    }
    expect(isIdempotentRequest("POST", "/internal/read-files")).toBe(true);
    expect(isIdempotentRequest("POST", "/internal/sessions/7/wait-output")).toBe(true);
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
