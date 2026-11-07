// Issue #2413 / #2414 — the import-boundary guardrail.
//
// scripts/check-import-boundaries.mjs is the check that keeps the layering
// (routes -> services -> db, plugins above both) and the absence of import
// cycles from drifting. This exercises it against per-test fixture trees
// (precedent: test/scripts/check-case-collision.test.ts, which drives its
// script through execFile the same way).
//
// What matters here is not that the check passes on a clean tree — that is
// the easy half — but that it FAILS on each of the four ways the boundaries
// can move: a new cycle, a new layering inversion, a baseline entry that no
// longer describes anything, and a baseline entry that describes a violation
// the tree no longer has. A guard that only knows how to say "OK" is not a
// guard.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL("../../scripts/check-import-boundaries.mjs", import.meta.url));

const EMPTY_BASELINE = {
  cycles: [],
  inversions: [],
};

describe("check-import-boundaries.mjs", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "import-boundaries-test-"));
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts/import-boundaries.baseline.json"),
      `${JSON.stringify(EMPTY_BASELINE, null, 2)}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string, contents: string): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  function writeBaseline(baseline: unknown): void {
    fs.writeFileSync(
      path.join(root, "scripts/import-boundaries.baseline.json"),
      `${JSON.stringify(baseline, null, 2)}\n`,
    );
  }

  async function run(): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, root]);
      return { code: 0, stdout, stderr };
    } catch (err) {
      const failure = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: failure.code ?? 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  }

  it("passes on a tree with no cycle and no inversion", async () => {
    write("src/services/thing.ts", "export const thing = 1;\n");
    write(
      "src/routes/thing.ts",
      'import { thing } from "../services/thing.js";\nexport { thing };\n',
    );
    write(
      "src/plugins/thing.ts",
      'import { thing } from "../services/thing.js";\nexport { thing };\n',
    );

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("OK — no new import cycles");
  });

  it("fails on a new layering inversion (a service importing a route)", async () => {
    write("src/routes/thing.ts", "export const thing = 1;\n");
    write(
      "src/services/thing.ts",
      'import { thing } from "../routes/thing.js";\nexport { thing };\n',
    );

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NEW LAYERING INVERSION");
    expect(result.stderr).toContain("src/services/thing.ts -> src/routes/thing.ts");
  });

  it("fails on a new layering inversion (a plugin importing a route)", async () => {
    write("src/routes/thing.ts", "export const thing = 1;\n");
    write(
      "src/plugins/thing.ts",
      'import { thing } from "../routes/thing.js";\nexport { thing };\n',
    );

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NEW LAYERING INVERSION");
  });

  it("fails on a new import cycle", async () => {
    write("src/services/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
    write("src/services/b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NEW IMPORT CYCLE");
    expect(result.stderr).toContain("src/services/a.ts -> src/services/b.ts");
  });

  it("fails on a cycle closed by a type-only import", async () => {
    write("src/services/a.ts", 'import type { B } from "./b.js";\nexport type A = B;\n');
    write("src/services/b.ts", 'import type { A } from "./a.js";\nexport type B = A;\n');

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NEW IMPORT CYCLE");
  });

  it("fails on a baseline entry that no longer describes a violation", async () => {
    write("src/services/a.ts", "export const a = 1;\n");
    writeBaseline({
      cycles: [],
      inversions: [
        {
          from: "src/services/gone.ts",
          to: "src/routes/gone.ts",
          note: "a violation that was fixed",
        },
      ],
    });

    const result = await run();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("STALE BASELINE ENTRY");
    expect(result.stderr).toContain("src/services/gone.ts -> src/routes/gone.ts");
  });

  it("passes a baselined inversion and says so", async () => {
    write("src/routes/thing.ts", "export const thing = 1;\n");
    write(
      "src/services/thing.ts",
      'import { thing } from "../routes/thing.js";\nexport { thing };\n',
    );
    writeBaseline({
      cycles: [],
      inversions: [
        {
          from: "src/services/thing.ts",
          to: "src/routes/thing.ts",
          note: "deliberate: the service reads the route's own constant",
        },
      ],
    });

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no new layering inversions");
  });

  it("passes a baselined cycle", async () => {
    write("src/services/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
    write("src/services/b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');
    writeBaseline({
      cycles: [
        {
          note: "deliberate: the two halves really do need each other",
          edges: [
            "src/services/a.ts -> src/services/b.ts",
            "src/services/b.ts -> src/services/a.ts",
          ],
        },
      ],
      inversions: [],
    });

    const result = await run();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no new import cycles");
  });

  it("--update writes a baseline that the check then accepts", async () => {
    write("src/services/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
    write("src/services/b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');
    write("src/routes/thing.ts", "export const thing = 1;\n");
    write(
      "src/services/thing.ts",
      'import { thing } from "../routes/thing.js";\nexport { thing };\n',
    );

    const update = await execFileAsync(process.execPath, [SCRIPT, root, "--update"]);
    expect(update.stdout).toContain("1 cycle group(s), 1 inversion(s)");

    const baseline = JSON.parse(
      fs.readFileSync(path.join(root, "scripts/import-boundaries.baseline.json"), "utf8"),
    );
    expect(baseline.cycles).toHaveLength(1);
    expect(baseline.cycles[0].edges).toEqual(
      expect.arrayContaining([
        "src/services/a.ts -> src/services/b.ts",
        "src/services/b.ts -> src/services/a.ts",
      ]),
    );
    expect(baseline.inversions).toHaveLength(1);
    expect(baseline.inversions[0].from).toBe("src/services/thing.ts");

    // The freshly written baseline must satisfy the check that wrote it.
    const result = await run();
    expect(result.code).toBe(0);
  });

  it("ignores a worktree checkout of the same repository", async () => {
    write("src/services/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
    write("src/services/b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');
    // The same cycle, inside the directory the audit excludes as a
    // developer worktree (.wt/) — it must not be counted.
    write(".wt/other/src/services/a.ts", 'import { b } from "./b.js";\nexport const a = b;\n');
    write(".wt/other/src/services/b.ts", 'import { a } from "./a.js";\nexport const b = a;\n');

    const result = await run();

    expect(result.code).toBe(1);
    // Only the real tree's two files are reported, and the worktree copy
    // is not among them.
    expect(result.stderr).toContain("src/services/a.ts -> src/services/b.ts");
    expect(result.stderr).not.toContain(".wt/");
  });
});
