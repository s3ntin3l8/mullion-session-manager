// Issue #2412 — the shared-type guardrail.
//
// scripts/check-shared-type-twins.mjs fails when a frontend type duplicates a
// backend type by name, which is how a hand-maintained mirror of an API shape
// is written. Driven through execFile against per-test fixture trees, the same
// way test/scripts/check-import-boundaries.test.ts drives its script.
//
// The case that matters most is the one the check exists for: a type that has
// already moved to src/shared/ (the backend only re-exports it now, so no
// backend module declares it) being hand-copied back into the frontend.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL("../../scripts/check-shared-type-twins.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("check-shared-type-twins.mjs", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-type-twins-test-"));
    // The post-#2412 layout: the shape lives in src/shared/, the backend
    // module that produces it re-exports it, the frontend imports it.
    write(
      "src/shared/api-types/storage.ts",
      "export interface CleanupJob {\n  id: string;\n  mode: string;\n}\n",
    );
    write("src/shared/types.ts", 'export type * from "./api-types/storage.js";\n');
    write(
      "src/services/disk-cleanup-job.ts",
      'export type { CleanupJob } from "../shared/types.js";\n' +
        "export interface CleanupOptions {\n  dryRun: boolean;\n}\n" +
        "interface Entry {\n  key: string;\n}\n" +
        "export function noop(_e: Entry): void {}\n",
    );
    write(
      "frontend/src/api/types.ts",
      'export type { CleanupJob } from "../../../src/shared/types.js";\n' +
        "export interface StorageView {\n  open: boolean;\n}\n",
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

  function writeAllowlist(
    allowed: Record<string, string>,
    mirrors: Record<string, string> = {},
  ): void {
    write(
      "scripts/shared-type-twins.allowlist.json",
      JSON.stringify({ allowed, mirrors }, null, 2),
    );
  }

  async function run(dir = root): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, dir]);
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("passes when the frontend imports the shared declaration", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no frontend type duplicates a backend type");
  });

  it("fails when a type already moved to src/shared/ is hand-copied back into the frontend", async () => {
    write(
      "frontend/src/api/types.ts",
      "export interface CleanupJob {\n  id: string;\n  mode: string;\n}\n",
    );
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CleanupJob  frontend/src/api/types.ts:1");
    expect(result.stderr).toContain("src/shared/api-types/storage.ts:1");
  });

  it("fails when the frontend copies an exported backend type that is not shared yet", async () => {
    write("frontend/src/settings/useCleanup.ts", "type CleanupOptions = { dryRun?: boolean };\n");
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CleanupOptions  frontend/src/settings/useCleanup.ts:1");
  });

  it("counts a .tsx file and an enum, not only interfaces in .ts files", async () => {
    write(
      "frontend/src/Storage.tsx",
      "enum CleanupJob {\n  A,\n}\nexport const x = CleanupJob.A;\n",
    );
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CleanupJob  frontend/src/Storage.tsx:1");
  });

  it("ignores a backend module's unexported helper type", async () => {
    write("frontend/src/hooks/useStack.ts", "interface Entry {\n  id: number;\n}\nexport {};\n");
    expect((await run()).code).toBe(0);
  });

  it("ignores frontend test files and test fixtures", async () => {
    write("frontend/src/Storage.test.tsx", "interface CleanupJob {\n  id: string;\n}\n");
    write("frontend/src/test/fixtures.ts", "export type CleanupOptions = { dryRun: boolean };\n");
    expect((await run()).code).toBe(0);
  });

  it("lets an allowlisted name through, and fails on an allowlist entry that matches nothing", async () => {
    write("frontend/src/api/types.ts", "export type CleanupOptions = { dryRun: boolean };\n");
    writeAllowlist({ CleanupOptions: "fixture: deliberately different" });
    expect((await run()).code).toBe(0);

    writeAllowlist({
      CleanupOptions: "fixture: deliberately different",
      StorageView: "no longer has a backend twin",
    });
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no longer have a twin");
    expect(result.stderr).toContain("StorageView");
  });

  it("matches an allowlist entry by own name only, so an inherited key like constructor is not allowed", async () => {
    write("frontend/src/api/types.ts", "export type constructor = { id: string };\n");
    write("src/services/odd.ts", "export type constructor = { id: string };\n");
    writeAllowlist({});
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("constructor  frontend/src/api/types.ts:1");
  });

  it("fails loudly on an unreadable allowlist and on --allowlist without a path", async () => {
    write("scripts/shared-type-twins.allowlist.json", "{ not json");
    const bad = await run();
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("not valid JSON");

    write("scripts/shared-type-twins.allowlist.json", JSON.stringify({ allowed: ["x"] }));
    const shape = await run();
    expect(shape.code).toBe(1);
    expect(shape.stderr).toContain("must be an object");

    const usage = await execFileAsync(process.execPath, [SCRIPT, root, "--allowlist"]).catch(
      (err: { code: number; stderr: string }) => err,
    );
    expect((usage as { code: number }).code).toBe(2);
    expect((usage as { stderr: string }).stderr).toContain("usage:");
  });

  it("fails on a renamed copy that says it mirrors a backend shape, unless allowlisted", async () => {
    write(
      "frontend/src/api/types.ts",
      "// Mirrors src/services/disk-cleanup-job.ts's CleanupOptions 1:1.\n" +
        "export interface CleanupFlags {\n  dryRun: boolean;\n}\n" +
        "// Mirrors GET /api/storage's response (not a file path).\n" +
        "export interface StorageView {\n  open: boolean;\n}\n",
    );
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "CleanupFlags  frontend/src/api/types.ts:2  (mirrors src/services/disk-cleanup-job.ts)",
    );
    expect(result.stderr).not.toContain("StorageView");

    writeAllowlist({}, { CleanupFlags: "fixture: known copy" });
    expect((await run()).code).toBe(0);

    writeAllowlist({}, { CleanupFlags: "fixture: known copy", Gone: "matches nothing" });
    const stale = await run();
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("Gone");
  });

  it("passes on this repository as it stands", async () => {
    const result = await run(REPO_ROOT);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });
});
