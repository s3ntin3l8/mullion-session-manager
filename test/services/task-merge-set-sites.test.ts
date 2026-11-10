import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every site that records a merge (assigns `mergedAt` in a write) must build
// its `.set()` through `mergeRecordedSet`, so none can forget to clear the
// review-post marker or the merge-tied reason.
const SRC = path.resolve(__dirname, "../../src");
const HELPER = path.join("services", "task-merge-human.ts");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "db" ? [] : walk(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

// `mergedAt:` / `mergedAt,` as an object-literal key or shorthand, not a type member.
const ASSIGNS_MERGED_AT =
  /^\s*(?:[\w.]+\(.*)?\{?\s*mergedAt(?::(?!\s*(?:string|Date|boolean|number)\b)|,)/m;

// Files whose `mergedAt:` is a read (a GitHub PR mapping or a select column),
// never a write to `tasks`.
const READ_ONLY = new Set([
  "services/github-merged-prs.ts",
  "services/github-request.ts",
  "services/github-write.ts",
  "services/task-store.ts",
]);

describe("merge-recording sites", () => {
  const files = walk(SRC).filter((f) => !f.endsWith(HELPER));

  it("route every mergedAt write through mergeRecordedSet", () => {
    const offenders = files
      .filter((f) => {
        const text = fs.readFileSync(f, "utf8");
        if (READ_ONLY.has(path.relative(SRC, f))) return false;
        return ASSIGNS_MERGED_AT.test(text) && !text.includes("mergeRecordedSet");
      })
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("find the six known sites (guards the pattern against going blind)", () => {
    const users = files
      .filter((f) => fs.readFileSync(f, "utf8").includes("mergeRecordedSet"))
      .map((f) => path.relative(SRC, f))
      .sort();
    expect(users).toEqual([
      "routes/tasks.ts",
      "routes/webhooks.ts",
      "services/task-github-sync.ts",
      "services/task-merged.ts",
      "services/task-reconciler.ts",
      "services/task-review-end.ts",
    ]);
  });

  it("keep the reason clear private to the helper", () => {
    const offenders = files
      .filter((f) => fs.readFileSync(f, "utf8").includes("clearNeedsHumanOnMerge"))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
