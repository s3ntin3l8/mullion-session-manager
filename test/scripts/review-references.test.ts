// scripts/review-references.mjs picks the review references a diff should be
// read against, from the glob index next to the skill. The pick has to be
// deterministic (a reviewer asked to "choose the relevant ones" chooses
// differently every time) and a broken index has to fail loudly rather than
// answer "nothing matches".
//
// The pure functions are imported; the CLI runs via execFile against fixture
// directories using the script's REVIEW_REFERENCES_ROOT override (precedent:
// check-review-protocol-sync.test.ts), so none of it depends on this repo's
// own index.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../../src/services/git-env.js";
import {
  INDEX_PATH,
  formatReferences,
  loadIndex,
  matchReferences,
} from "../../scripts/review-references.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../scripts/review-references.mjs", import.meta.url));

const INDEX = [
  {
    ref: ".claude/skills/x/references/task-loop.md",
    paths: ["src/services/task-reconciler.ts", "src/services/task-*.ts"],
    summary: "the task review loop",
  },
  {
    ref: ".claude/skills/x/references/dock.md",
    paths: ["frontend/src/dock/**"],
    summary: "dock lifecycle",
  },
];

function fixture(index: unknown = INDEX): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-references-"));
  const file = path.join(dir, INDEX_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof index === "string" ? index : JSON.stringify(index));
  return dir;
}

async function run(root: string, args: string[], input?: string) {
  const child = execFileAsync("node", [SCRIPT, ...args], {
    env: { ...process.env, REVIEW_REFERENCES_ROOT: root },
  });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  return child.then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({
      code: e.code,
      stdout: e.stdout,
      stderr: e.stderr,
    }),
  );
}

describe("matchReferences", () => {
  it("returns the entries whose globs match, with the files that matched, in index order", () => {
    const m = matchReferences(INDEX, [
      "docs/x.md",
      "src/services/task-claim.ts",
      "src/services/task-reconciler.ts",
    ]);
    expect(m.map((e) => e.ref)).toEqual([".claude/skills/x/references/task-loop.md"]);
    expect(m[0].matched).toEqual(["src/services/task-claim.ts", "src/services/task-reconciler.ts"]);
  });

  it("matches ** across directory depth and returns nothing for an unrelated diff", () => {
    expect(matchReferences(INDEX, ["frontend/src/dock/a/b/c.tsx"])).toHaveLength(1);
    expect(matchReferences(INDEX, ["README.md", "src/routes/auth.ts"])).toEqual([]);
  });

  it("lists every entry a file matches, not just the first", () => {
    const both = [
      { ref: "a.md", paths: ["src/**"], summary: "a" },
      { ref: "b.md", paths: ["src/services/*.ts"], summary: "b" },
    ];
    expect(matchReferences(both, ["src/services/x.ts"]).map((e) => e.ref)).toEqual([
      "a.md",
      "b.md",
    ]);
  });
});

describe("formatReferences", () => {
  it("says so when nothing matches", () => {
    expect(formatReferences([])).toBe("No area-specific references match this diff.\n");
  });

  it("names each reference with its summary and truncates the matched-file list", () => {
    const out = formatReferences([
      { ...INDEX[0], matched: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] },
    ]);
    expect(out).toContain(`- ${INDEX[0].ref} — the task review loop`);
    expect(out).toContain("matched: a.ts, b.ts, c.ts (+2 more)");
  });
});

describe("loadIndex", () => {
  it("reads a valid index", () => {
    expect(loadIndex(fixture())).toEqual(INDEX);
  });

  it.each([
    ["not json", "{"],
    ["not an array", "{}"],
    ["a missing ref", [{ paths: ["a"], summary: "s" }]],
    ["a missing summary", [{ ref: "r", paths: ["a"] }]],
    ["empty paths", [{ ref: "r", paths: [], summary: "s" }]],
    ["a non-string glob", [{ ref: "r", paths: [1], summary: "s" }]],
  ])("rejects %s", (_name, index) => {
    expect(() => loadIndex(fixture(index))).toThrow();
  });

  it("names the missing file", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "review-references-empty-"));
    expect(() => loadIndex(empty)).toThrow(/cannot read/);
  });
});

describe("review-references.mjs CLI", () => {
  it("reads changed paths from stdin", async () => {
    const r = await run(fixture(), ["--files", "-"], "src/services/task-reconciler.ts\n\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(".claude/skills/x/references/task-loop.md");
    expect(r.stdout).not.toContain("dock.md");
  });

  it("answers an unrelated diff with the no-match line and exit 0", async () => {
    const r = await run(fixture(), ["--files", "-"], "README.md\n");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("No area-specific references match this diff.\n");
  });

  it("prints JSON with --json", async () => {
    const r = await run(fixture(), ["--files", "-", "--json"], "frontend/src/dock/x.tsx\n");
    expect(JSON.parse(r.stdout)).toEqual([{ ...INDEX[1], matched: ["frontend/src/dock/x.tsx"] }]);
  });

  it("exits 2 with a message for a malformed index, a bad flag, or a bad --files value", async () => {
    const bad = await run(fixture("{"), ["--files", "-"], "a\n");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/review-references: cannot read/);
    expect((await run(fixture(), ["--nope"])).code).toBe(2);
    expect((await run(fixture(), ["--files", "x"])).code).toBe(2);
    expect((await run(fixture(), ["--base"])).code).toBe(2);
  });

  it("diffs base...head in a git checkout", async () => {
    const root = fixture();
    // Identity by environment, not `git config`: the guard forbids writing
    // user.name / user.email anywhere, even into a throwaway repo.
    const env = {
      ...gitEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", root, ...a], { env: env, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    fs.mkdirSync(path.join(root, "src/services"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/services/task-reconciler.ts"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(root, "src/services/task-reconciler.ts"), "b\n");
    git("commit", "-q", "-am", "change");

    const r = await run(root, ["--base", "main", "--head", "feature"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("task-loop.md");

    // No origin/* in the fixture: the default base cannot resolve, and the
    // script says to pass --base instead of guessing.
    const noBase = await run(root, []);
    expect(noBase.code).toBe(2);
    expect(noBase.stderr).toMatch(/pass --base/);
  });
});
