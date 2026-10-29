import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareWorktreePaths } from "../../src/services/worktree-paths.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("host worktree path comparisons", () => {
  it("resolves aliases, respects component boundaries, and marks dangling links unknown", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-compare-"));
    dirs.push(root);
    const target = path.join(root, "worktree");
    const alias = path.join(root, "alias");
    const dangling = path.join(root, "dangling");
    fs.mkdirSync(path.join(target, "sub"), { recursive: true });
    fs.mkdirSync(`${target}-other`);
    fs.symlinkSync(target, alias, "dir");
    fs.symlinkSync(path.join(root, "missing"), dangling, "dir");
    const result = await compareWorktreePaths(
      target,
      [
        { id: "1", cwd: path.join(alias, "sub") },
        { id: "2", cwd: `${target}-other` },
        { id: "3", cwd: dangling },
        { id: "4", cwd: null },
        { id: "5", cwd: root },
        { id: "6", cwd: path.join(root, "missing") },
      ],
      () => true,
      (id) => (id === "5" ? alias : null),
    );
    expect(result).toEqual(["inside", "outside", "unknown", "unknown", "inside", "unknown"]);
  });

  it("fails closed for paths outside the permitted roots and changing live cwd", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-compare-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, "target"));
    let calls = 0;
    expect(
      await compareWorktreePaths(
        root,
        [{ id: "1", cwd: root }],
        () => false,
        () => null,
      ),
    ).toEqual(["unknown"]);
    expect(
      await compareWorktreePaths(
        path.join(root, "target"),
        [{ id: "1", cwd: root }],
        () => true,
        () => (++calls === 1 ? null : root),
      ),
    ).toEqual(["unknown"]);
  });
});
