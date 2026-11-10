import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
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

// Every object-literal key or shorthand named `mergedAt`, as `file#function`
// (the nearest named function, method or variable around it). A write to
// `tasks` through any of them would bypass `mergeRecordedSet`, so the set is
// pinned: a new entry must be added below on purpose.
function mergedAtLiterals(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  // The enclosing function wins; a module-level literal falls back to its variable.
  const nameOf = (n: ts.Node): string => {
    let variable: string | undefined;
    for (let x: ts.Node | undefined = n; x; x = x.parent) {
      if ((ts.isFunctionDeclaration(x) || ts.isMethodDeclaration(x)) && x.name) {
        return x.name.getText(sf);
      }
      if (!variable && ts.isVariableDeclaration(x) && ts.isIdentifier(x.name))
        variable = x.name.text;
    }
    return variable ?? "<module>";
  };
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        const name =
          p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
        if (name === "mergedAt") found.push(`${path.relative(SRC, file)}#${nameOf(p)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// The literals that read or relay a merge date, never write `tasks.mergedAt`:
// GitHub PR mappings, the webhook/reconciler hand-offs into
// `endReviewingOnPrState`, and the task-row column list.
const NOT_A_TASKS_WRITE = [
  "routes/webhooks.ts#webhookRoutes",
  "services/github-merged-prs.ts#toRecord",
  "services/github-merged-prs.ts#isPullRequestMerged",
  "services/github-request.ts#getPullRequestByNumber",
  "services/github-write.ts#getMergedClosingPullRequest",
  "services/github-write.ts#listClosedPullRequests",
  "services/task-reconciler.ts#fetchCurrentCiStatus",
  "services/task-reconciler.ts#finishTaskForMergedPr",
  "services/task-reconciler.ts#fetchPrLifecycle",
  "services/task-reconciler.ts#endReviewingFromPr",
  "services/task-store.ts#TASK_ROW_COLUMNS",
];

describe("merge-recording sites", () => {
  const files = walk(SRC).filter((f) => !f.endsWith(HELPER));

  it("write mergedAt only through mergeRecordedSet: no other object literal carries the key", () => {
    const literals = new Set(files.flatMap(mergedAtLiterals));
    const offenders = [...literals].filter((l) => !NOT_A_TASKS_WRITE.includes(l));
    expect(offenders).toEqual([]);
    // An entry that no longer matches means the scan went blind or the list is stale.
    expect(NOT_A_TASKS_WRITE.filter((l) => !literals.has(l))).toEqual([]);
  });

  it("flags a bypass inside a file that already uses the helper, and a one-line shorthand", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-sites-"));
    const file = path.join(dir, "x.ts");
    fs.writeFileSync(
      file,
      [
        'import { mergeRecordedSet } from "./task-merge-human.js";',
        "export function ok(db: any, d: Date) { db.set(mergeRecordedSet(d)); }",
        "export function bypass(db: any, mergedAt: Date) { db.set({ status: 'done', mergedAt }); }",
      ].join("\n"),
    );
    expect(mergedAtLiterals(file).map((l) => l.replace(/^.*#/, ""))).toEqual(["bypass"]);
    fs.rmSync(dir, { recursive: true });
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
