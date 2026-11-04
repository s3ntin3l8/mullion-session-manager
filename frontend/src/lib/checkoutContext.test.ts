import { describe, expect, it } from "vitest";
import { contextKey, describeCheckout, hasOwnCheckout, sessionHostId } from "./checkoutContext.js";
import { makeHost, makeProject, makeSession } from "../test/fixtures.js";

const project = makeProject({ id: 4, cwd: "/work/app", hostId: "local", currentBranch: "main" });
const hosts = [makeHost({ id: "local", name: "Primary" }), makeHost({ id: "mac", name: "Mac" })];

describe("hasOwnCheckout", () => {
  it("is false for a session in the project's own checkout", () => {
    expect(hasOwnCheckout(makeSession({ cwd: "/work/app" }), project)).toBe(false);
    expect(hasOwnCheckout(makeSession({ cwd: "/work/app/src" }), project)).toBe(false);
  });

  it("is true for a worktree, and for a sibling worktree outside the project", () => {
    expect(hasOwnCheckout(makeSession({ cwd: "/work/app/.mullion-worktrees/x" }), project)).toBe(
      true,
    );
    expect(hasOwnCheckout(makeSession({ cwd: "/work/app-wt/x" }), project)).toBe(true);
  });

  it("is true on another host even at the identical path", () => {
    const remote = makeSession({ cwd: "/work/app", resolvedHostId: "mac" });
    expect(sessionHostId(remote, project)).toBe("mac");
    expect(hasOwnCheckout(remote, project)).toBe(true);
  });
});

describe("contextKey", () => {
  it("differs by host, session and project", () => {
    const keys = [
      contextKey(4, null, "local"),
      contextKey(4, 9, "local"),
      contextKey(4, 9, "mac"),
      contextKey(5, 9, "mac"),
    ];
    expect(new Set(keys).size).toBe(4);
  });
});

describe("describeCheckout", () => {
  it("names the project default checkout", () => {
    const d = describeCheckout(project, null, hosts);
    expect(d).toMatchObject({ hostName: "Primary", isRemote: false, branch: "main" });
    expect(d.label).toBe("Primary · Project default · main");
  });

  it("names a remote session's host, checkout and git branch", () => {
    const s = makeSession({ cwd: "/work/app-wt/feat", resolvedHostId: "mac", liveBranch: "hook" });
    expect(describeCheckout(project, s, hosts, "feat/x").label).toBe("Mac · feat · feat/x");
    expect(describeCheckout(project, s, hosts).label).toBe("Mac · feat · hook");
    expect(describeCheckout(project, s, hosts).isRemote).toBe(true);
  });

  it("falls back to the host id for an unknown host", () => {
    const s = makeSession({ cwd: "/x/y", resolvedHostId: "gone", liveBranch: null });
    expect(describeCheckout(project, s, hosts).label).toBe("gone · y");
  });
});
