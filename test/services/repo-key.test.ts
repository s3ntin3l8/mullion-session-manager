import { describe, it, expect } from "vitest";
import { pickRepoOwners, repoKey } from "../../src/services/repo-key.js";

describe("repo-key", () => {
  it("lower-cases owner/repo", () => {
    expect(repoKey({ owner: "Acme", repo: "Widgets" })).toBe("acme/widgets");
  });

  it("the first (oldest) project on a repo owns it", () => {
    const keys = new Map<number, string | null>([
      [1, "a/b"],
      [2, "a/b"],
      [3, null],
      [4, "c/d"],
    ]);
    const owners = pickRepoOwners([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], keys);
    expect(owners.get("a/b")).toBe(1);
    expect(owners.get("c/d")).toBe(4);
  });

  it("defers a repo first seen after an unresolvable project (owner 0)", () => {
    const keys = new Map<number, string | null>([
      [2, "a/b"],
      [3, "c/d"],
    ]);
    // project 1 is absent from `keys`: its host could not be resolved
    const owners = pickRepoOwners([{ id: 1 }, { id: 2 }, { id: 3 }], keys);
    expect(owners.get("a/b")).toBe(0);
    expect(owners.get("c/d")).toBe(0);
  });
});
