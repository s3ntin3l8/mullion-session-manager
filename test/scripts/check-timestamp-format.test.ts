// scripts/check-timestamp-format.mjs is the guard that stops one surface
// from rendering a timestamp in a different shape from every other surface.
//
// The audit found exactly one surface that did: the review relay's Settings
// section rendered `new Date(run.dispatchedAt).toLocaleTimeString()` — a raw
// locale-dependent clock time — while the rest of the app says when
// something happened through the shared `formatRelativeAge` ("3m ago").
//
// The guard's matcher is the weak point worth pinning, in BOTH directions:
//
// - It must catch every spelling of the locale-dependent date API the app
//   could reach for (the time form, the date form, with or without a space
//   before the paren).
// - It must NOT catch the things a text scan cannot honestly distinguish:
//   `.toLocaleString()` (which is also how the app formats plain numbers),
//   a comment that merely quotes the call, and the shared time module —
//   where an absolute formatter is supposed to live.
//
// A false positive here would fail `npm run lint` on legal code, so the
// negatives are pinned as firmly as the positives.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-timestamp-format.mjs");

describe("check-timestamp-format.mjs", () => {
  let root: string;
  let srcDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "timestamp-format-test-"));
    srcDir = path.join(root, "frontend", "src");
    fs.mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeSource(name: string, body: string): void {
    fs.writeFileSync(path.join(srcDir, name), body);
  }

  async function run(): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, root]);
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  // Every spelling of the locale-dependent DATE/TIME API the guard must
  // catch. A guard that only catches the spelling in use today is not a
  // guard.
  for (const [description, body] of [
    ["a time format", "const t = d.toLocaleTimeString();"],
    ["a date format", "const d = x.toLocaleDateString();"],
    ["a space before the paren", "const t = d.toLocaleTimeString ();"],
    ["a newline between the name and the paren", "const t = d.toLocaleTimeString\n();"],
    ["a date format on a chained call", "const d = new Date().toLocaleDateString();"],
  ] as const) {
    it(`catches ${description}`, async () => {
      writeSource("probe.ts", `export const probe = () => {\n  ${body}\n};\n`);
      const result = await run();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("locale-dependent Date API");
      expect(result.stderr).toContain("probe.ts");
    });
  }

  // `.toLocaleString()` formats plain numbers too (a byte count, say), and a
  // text scan cannot tell those apart from a Date's — so it is deliberately
  // out of scope. Pinning it keeps a future tightening from being a silent
  // behaviour change.
  it("does not catch .toLocaleString() — it also formats plain numbers", async () => {
    writeSource("probe.ts", "export const bytes = n.toLocaleString();\n");
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("every timestamp is rendered through the shared formatter");
  });

  // The repo's own comments quote the call they are talking about, so a
  // comment must not trip the guard.
  it("does not catch a comment that quotes the call", async () => {
    writeSource(
      "probe.ts",
      [
        "// This used to render a raw `toLocaleTimeString()` before #1890.",
        "/* and a block comment mentioning toLocaleDateString() too */",
        "export const ok = 1;",
        "",
      ].join("\n"),
    );
    const result = await run();
    expect(result.code).toBe(0);
  });

  // A string literal is prose as well — a copy-pasteable snippet must not
  // fail the lint step.
  it("does not catch a string literal that mentions the method", async () => {
    writeSource("probe.ts", 'export const help = "use toLocaleTimeString() here";\n');
    const result = await run();
    expect(result.code).toBe(0);
  });

  // A template literal's `${...}` part is real code, so a date formatted
  // there IS caught — the guard blanks prose, not expressions.
  it("catches a date formatted inside a template interpolation", async () => {
    writeSource("probe.ts", "export const t = `${d.toLocaleTimeString()}`;\n");
    const result = await run();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("locale-dependent Date API");
  });

  // The shared time module is where an absolute formatter belongs; the
  // guard exempts it so a deadline can be rendered there.
  it("exempts the shared time module", async () => {
    writeSource(
      "relativeTime.ts",
      "export const formatAbsolute = (ms: number) => new Date(ms).toLocaleTimeString();\n",
    );
    const result = await run();
    expect(result.code).toBe(0);
  });

  it("passes on a tree that uses the shared formatter", async () => {
    writeSource(
      "probe.ts",
      'import { formatRelativeAge } from "./relativeTime.js";\nexport const age = formatRelativeAge(0);\n',
    );
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("every timestamp is rendered through the shared formatter");
  });

  // The real tree must be clean — the guard runs in `npm run lint`, so a
  // violation that already exists on main would fail the lint step.
  it("passes on this repository's own frontend source", async () => {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT]);
    expect(stdout).toContain("every timestamp is rendered through the shared formatter");
  });
});
