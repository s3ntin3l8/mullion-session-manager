import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotCitedPathExistence } from "../../src/services/scaffold-cited-paths.js";

describe("snapshotCitedPathExistence (issue #2932)", () => {
  it("records cited paths from each section and ignores a turn with none", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cited-snap-"));
    try {
      fs.mkdirSync(path.join(root, "src/routes"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/routes/listings.ts"), "");
      const raw =
        "<<<MULLION_SKILL_START>>>\nSee src/routes/listings.ts.\n<<<MULLION_SKILL_END>>>\n" +
        "<<<MULLION_REVIEWER_START>>>\nSee src/domain/missing.ts.\n<<<MULLION_REVIEWER_END>>>\n" +
        "<<<MULLION_SCAFFOLD_REGION_START>>>\nSee docs/setup.md.\n<<<MULLION_SCAFFOLD_REGION_END>>>\n";
      expect(snapshotCitedPathExistence(root, raw)).toEqual([
        { path: "src/routes/listings.ts", exists: true },
        { path: "src/domain/missing.ts", exists: false },
        { path: "docs/setup.md", exists: false },
      ]);
      expect(snapshotCitedPathExistence(root, "no markers here")).toEqual([]);
      expect(snapshotCitedPathExistence(root, "<<<MULLION_SKILL_START>>>unterminated")).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
