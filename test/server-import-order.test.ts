import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// src/server.ts must import the Windows child-process patch first: ESM
// evaluates imports in order, and any module that captures
// `promisify(execFile)` at module scope is only covered if the patch ran
// before it (see src/services/windows-hide-children.ts).
describe("src/server.ts import order", () => {
  it("imports process-title, then windows-hide-install, before anything else", () => {
    const source = readFileSync(path.join(ROOT, "src/server.ts"), "utf8");
    const imports = source
      .split(/\r?\n/)
      .filter((line) => /^\s*import\b/.test(line) && !line.trim().startsWith("//"));
    expect(imports[0]).toMatch(/^import\s+["']\.\/process-title\.js["'];?\s*$/);
    expect(imports[1]).toMatch(/^import\s+["']\.\/services\/windows-hide-install\.js["'];?\s*$/);
  });
});
