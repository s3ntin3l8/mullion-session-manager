// scripts/review-references.mjs picks the review references a diff should be
// read against, from the glob index next to the skill. The pick has to be
// deterministic (a reviewer asked to "choose the relevant ones" chooses
// differently every time) and a broken index has to fail loudly rather than
// answer "nothing matches".
//
// The pure functions and the CLI body (runCli) are imported and driven in-process,
// so their lines are covered; one execFile test checks the real entry point against fixture
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
  CONTENT_CAP,
  formatReferences,
  formatReferencesWithContent,
  loadIndex,
  matchReferences,
  runCli,
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

// In-process: arguments in, { code, stdout, stderr } out.
function run(root: string, args: string[], input?: string) {
  return runCli(args, { root, readStdin: () => input ?? "" });
}

// The real entry point, as a subprocess: the shebang/entry guard, the stdout
// and stderr writes and the exit code.
async function runProcess(root: string, args: string[], input?: string) {
  const child = execFileAsync("node", [SCRIPT, ...args], {
    env: { ...process.env, REVIEW_REFERENCES_ROOT: root },
  });
  if (input !== undefined) child.child.stdin?.end(input);
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

describe("--content", () => {
  const BOTH = ["src/services/task-reconciler.ts", "frontend/src/dock/x.tsx"].join("\n") + "\n";

  function withFiles(sizes: Record<string, number>): string {
    const root = fixture();
    for (const [ref, size] of Object.entries(sizes)) {
      const file = path.join(root, ref);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `BODY-${path.basename(ref)}\n` + "x".repeat(size));
    }
    return root;
  }

  it("inlines the full text of every matched reference after the list", () => {
    const root = withFiles({ [INDEX[0].ref]: 10, [INDEX[1].ref]: 10 });
    const plain = run(root, ["--files", "-"], BOTH).stdout;
    const r = run(root, ["--files", "-", "--content"], BOTH);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith(plain)).toBe(true);
    expect(r.stdout).toContain(`===== ${INDEX[0].ref} =====`);
    expect(r.stdout).toContain("BODY-task-loop.md");
    expect(r.stdout).toContain("BODY-dock.md");
    expect(r.stdout).not.toContain("Not inlined");
  });

  it("leaves the default output unchanged and says so when nothing matches", () => {
    const root = withFiles({ [INDEX[0].ref]: 10 });
    expect(run(root, ["--files", "-"], BOTH).stdout).not.toContain("BODY-");
    expect(run(root, ["--files", "-", "--content"], "README.md\n").stdout).toBe(
      "No area-specific references match this diff.\n",
    );
  });

  it("stops at the cap and names the references it left out", () => {
    const root = withFiles({ [INDEX[0].ref]: CONTENT_CAP - 100, [INDEX[1].ref]: 500 });
    const r = run(root, ["--files", "-", "--content"], BOTH);
    expect(r.stdout).toContain("BODY-task-loop.md");
    expect(r.stdout).not.toContain("BODY-dock.md");
    expect(r.stdout).toMatch(
      /Not inlined \(read these too\):\n- \.claude\/skills\/x\/references\/dock\.md/,
    );
  });

  it("does not inline a later reference once an earlier one overflowed", () => {
    const m = [
      { ref: "a.md", paths: ["a"], summary: "a", matched: ["a"] },
      { ref: "b.md", paths: ["b"], summary: "b", matched: ["b"] },
      { ref: "c.md", paths: ["c"], summary: "c", matched: ["c"] },
    ];
    const text: Record<string, string> = { "a.md": "AA", "b.md": "BBBBBB", "c.md": "C" };
    const out = formatReferencesWithContent(m, (r: string) => text[r], 5);
    expect(out).toContain("AA");
    expect(out).not.toContain("BBBBBB");
    expect(out).not.toMatch(/^C$/m);
    expect(out).toMatch(/Not inlined[^]*- b\.md\n- c\.md/);
  });

  it("adds a content field per match with --json", () => {
    const root = withFiles({ [INDEX[1].ref]: 5 });
    const r = run(root, ["--files", "-", "--json", "--content"], "frontend/src/dock/x.tsx\n");
    const [m] = JSON.parse(r.stdout);
    expect(m.content).toBe("BODY-dock.md\nxxxxx");
    expect(m.ref).toBe(INDEX[1].ref);
  });

  it("exits 2 when a matched reference file is missing", () => {
    const r = run(fixture(), ["--files", "-", "--content"], BOTH);
    expect(r.code).toBe(2);
  });

  it("still prints the notes it can read, and names the one it cannot", () => {
    const root = withFiles({ [INDEX[1].ref]: 10 });
    const r = run(root, ["--files", "-", "--content"], BOTH);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(INDEX[0].ref);
    expect(r.stdout).toContain("BODY-dock.md");
    expect(r.stdout).toMatch(/Could not read[^]*- \.claude\/skills\/x\/references\/task-loop\.md/);
  });

  it("counts the listing and each note's header against the cap, not only the bodies", () => {
    const m = [
      { ref: "a.md", paths: ["a"], summary: "a", matched: ["a"] },
      { ref: "b.md", paths: ["b"], summary: "b", matched: ["b"] },
    ];
    const text: Record<string, string> = { "a.md": "A".repeat(1000), "b.md": "B".repeat(1000) };
    // 2,000 characters of bodies fit a 2,100 cap; the printed text does not.
    const out = formatReferencesWithContent(m, (r: string) => text[r], 2100);
    expect(out).toContain("A".repeat(1000));
    expect(out).not.toContain("B".repeat(1000));
    expect(out.split("Not inlined")[0].length).toBeLessThanOrEqual(2100);
  });

  it("always inlines the first note, even when it alone is over the cap", () => {
    const m = [
      { ref: "a.md", paths: ["a"], summary: "a", matched: ["a"] },
      { ref: "b.md", paths: ["b"], summary: "b", matched: ["b"] },
    ];
    const text: Record<string, string> = { "a.md": "A".repeat(2000), "b.md": "B" };
    const out = formatReferencesWithContent(m, (r: string) => text[r], 100);
    expect(out).toContain("A".repeat(2000));
    expect(out).toMatch(/Not inlined[^]*- b\.md/);
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

  it("works as a real process: stdin in, listing out, exit 2 on a bad index", async () => {
    const ok = await runProcess(fixture(), ["--files", "-"], "src/services/task-reconciler.ts\n");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("task-loop.md");
    const bad = await runProcess(fixture("{"), ["--files", "-"], "a\n");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/review-references: cannot read/);
  });

  it("defaults the base to origin/main, then origin/master", () => {
    const root = fixture();
    const env = {
      ...gitEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", root, ...a], { env: env, stdio: "ignore" });
    git("init", "-q", "-b", "trunk");
    fs.mkdirSync(path.join(root, "src/services"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/services/task-reconciler.ts"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(root, "src/services/task-reconciler.ts"), "b\n");
    git("commit", "-q", "-am", "change");

    // Only origin/master exists: the first candidate fails, the second answers.
    git("update-ref", "refs/remotes/origin/master", "trunk");
    const viaMaster = run(root, []);
    expect(viaMaster.code).toBe(0);
    expect(viaMaster.stdout).toContain("task-loop.md");

    // origin/main wins when both exist: pointed at the feature head itself, a
    // diff against it is empty, which origin/master (the trunk) would not give.
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(run(root, []).stdout).toBe("No area-specific references match this diff.\n");
  });

  it("reports the original git error when neither diff form resolves", () => {
    const root = fixture();
    execFileSync("git", ["-C", root, "init", "-q"], { env: gitEnv(), stdio: "ignore" });
    const r = run(root, ["--base", "no-such-ref", "--head", "HEAD"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^review-references: /);
  });

  it("rejects a flag with no value", () => {
    expect(run(fixture(), ["--head"]).stderr).toMatch(/--head needs a value/);
    expect(run(fixture(), ["--files"]).stderr).toMatch(/only accepts "-"/);
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

    // A history with no merge base (what a shallow clone of base and head
    // looks like): the three-dot diff fails and the two-dot fallback answers.
    git("checkout", "-q", "--orphan", "unrelated");
    fs.writeFileSync(path.join(root, "src/services/task-reconciler.ts"), "c\n");
    git("add", "-A");
    git("commit", "-q", "-m", "orphan");
    const shallow = await run(root, ["--base", "main", "--head", "unrelated"]);
    expect(shallow.code).toBe(0);
    expect(shallow.stdout).toContain("task-loop.md");

    // No origin/* in the fixture: the default base cannot resolve, and the
    // script says to pass --base instead of guessing.
    const noBase = await run(root, []);
    expect(noBase.code).toBe(2);
    expect(noBase.stderr).toMatch(/pass --base/);
  });
});
