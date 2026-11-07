import { describe, expect, it } from "vitest";
import { ALLOWLIST, scanForBypass, scanRepo } from "../../scripts/check-checkout-removal.mjs";

// The guard keeps every project worktree removal on src/services/
// checkout-removal.ts, which also closes the checkout's browsers and deletes
// their stored state (#2700). It reads the syntax tree, so these pin what a
// line regex let through (#2725).
describe("check-checkout-removal guard", () => {
  it("passes on the repository as it is", () => {
    // The repo-wide scan also runs under `make lint`; here it fails the test
    // suite (and so CI) with the offending file and line.
    expect(scanRepo()).toEqual([]);
  });

  it("is not vacuous: with nothing allowlisted it finds the implementations themselves", () => {
    expect(scanRepo([]).length).toBeGreaterThan(20);
  });

  describe("finds a use outside the allowlist", () => {
    it.each([
      ["a call", "await backend.removeWorktree(p, c);"],
      ["a bare function call", "await removeWorktreeIfClean(p);"],
      ["an aliased import", 'import { removeWorktree as rw } from "./git-worktree.js";'],
      ["a destructured method", "const { removeWorktree: rw } = backend;"],
      ["a bracket-accessed method", 'await backend["removeWorktree"](p);'],
      ["a bare reference passed along", "run(backend.removeWorktreeIfClean);"],
      ["`git worktree remove` as argv", 'runGit(["worktree", "remove", p]);'],
      ["`git worktree remove` as text", "exec(`git worktree remove ${p}`);"],
    ])("%s", (_name, code) => {
      expect(scanForBypass("src/services/new-thing.ts", code)).toEqual([
        expect.objectContaining({ file: "src/services/new-thing.ts", line: 1 }),
      ]);
    });
  });

  it("names the line of a use deep in a file", () => {
    const found = scanForBypass(
      "src/services/new-thing.ts",
      "const a = 1;\n\nbackend.pruneWorktrees(c, []);",
    );
    expect(found).toEqual([expect.objectContaining({ line: 3 })]);
  });

  it("ignores a mention in a comment or an unrelated string", () => {
    expect(scanForBypass("src/x.ts", "// removeWorktree(p) is the old way\nconst a = 1;")).toEqual(
      [],
    );
    expect(scanForBypass("src/x.ts", 'log.warn("abandon: removeWorktree threw");')).toEqual([]);
  });

  it("allows the helper's own file and the implementing functions, but not a new caller beside them", () => {
    expect(scanForBypass("src/services/checkout-removal.ts", "removeWorktree(p);")).toEqual([]);
    const implementation =
      "export async function removeWorktree() { run(['worktree', 'remove', 'p']); }\n" +
      "export async function sneaky() { return removeWorktree('a', 'b'); }\n";
    // Inside git-worktree.ts the implementation is allowed ...
    const found = scanForBypass("src/services/git-worktree.ts", implementation);
    // ... and a function that is not one of the allowlisted ones is found.
    expect(found).toEqual([expect.objectContaining({ line: 2 })]);
  });

  it("caps the agent endpoints at their five, so a sixth call there is found", () => {
    const route = (n: number) =>
      "async function internalRoutes() {\n" +
      Array.from({ length: n }, () => "  await removeWorktree(p);").join("\n") +
      "\n}\n";
    expect(scanForBypass("src/routes/internal.ts", route(5))).toEqual([]);
    expect(scanForBypass("src/routes/internal.ts", route(6))).toHaveLength(1);
  });

  it("gives every allowlist entry a reason", () => {
    for (const entry of ALLOWLIST) expect(entry.why.length).toBeGreaterThan(5);
  });
});
