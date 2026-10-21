// The review protocol's rule is stated in several places, because an agent
// reads a different one depending on where it stands: the MCP tool
// description (read when it is about to ask for a review), the CLI's output
// (read right after it asked), the agent guide (read when it looks for how),
// and AGENTS.md (read by the agent CLIs natively). When those drift apart,
// the stale one wins — and the agent follows the rule it happens to be
// reading, which is how the duplicate-review queue came back.
//
// This exercises the check via execFile (precedent:
// test/scripts/check-scaffold-region-sync.test.ts) against per-test fixture
// directories, using the script's REVIEW_PROTOCOL_SYNC_ROOT override so it
// never depends on this repo's own files.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(
  new URL("../../scripts/check-review-protocol-sync.mjs", import.meta.url),
);

const NOTE = [
  "One review per pull request at a time: a review that is already running is not re-requested.",
  "A review takes 10-30 minutes; check review_status once instead of asking again.",
].join(" ");

const FIXTURE_FILES: Record<string, string> = {
  "AGENTS.md": `- **Get a review.** ${NOTE}\n`,
  "docs/agent-guide.md": `## Asking for a review\n\n${NOTE}\n`,
  "src/mcp/tools.mjs": `import { REVIEW_PROTOCOL_NOTE } from "../cli/review-protocol.mjs";\n// ${NOTE}\n`,
  "src/cli/core.mjs": `import { REVIEW_REQUEST_TIMEOUT_MS, REVIEW_PROTOCOL_NOTE } from "./review-protocol.mjs";\n// ${NOTE}\n`,
  "src/mcp/client.mjs": `import { REVIEW_REQUEST_TIMEOUT_MS } from "../cli/review-protocol.mjs";\n`,
  "src/cli/review-protocol.mjs": `export const REVIEW_PROTOCOL_NOTE = "${NOTE}";\n`,
};

function fixture(overrides: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-protocol-sync-"));
  for (const [rel, content] of Object.entries({ ...FIXTURE_FILES, ...overrides })) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function run(root: string) {
  return execFileAsync(process.execPath, [SCRIPT], {
    env: { ...process.env, REVIEW_PROTOCOL_SYNC_ROOT: root },
  });
}

describe("check-review-protocol-sync", () => {
  const dirs: string[] = [];
  const makeFixture = (overrides: Record<string, string> = {}) => {
    const dir = fixture(overrides);
    dirs.push(dir);
    return dir;
  };

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes when every surface carries the rule", async () => {
    const { stdout } = await run(makeFixture());
    expect(stdout).toContain("surfaces carry the rule");
  });

  it("fails when a surface drops the rule", async () => {
    const dir = makeFixture({ "AGENTS.md": "- **Get a review.** Ask for one.\n" });
    await expect(run(dir)).rejects.toThrow(/does not carry the review protocol/);
  });

  it("fails when a client keeps its own copy of the wording", async () => {
    const dir = makeFixture({
      "src/cli/core.mjs": "// the review rule, copied by hand\n",
    });
    await expect(run(dir)).rejects.toThrow(/review-protocol\.mjs/);
  });

  it("fails when the canonical note itself says nothing about the rule", async () => {
    const dir = makeFixture({
      "src/cli/review-protocol.mjs": 'export const REVIEW_PROTOCOL_NOTE = "Just ask nicely.";\n',
    });
    await expect(run(dir)).rejects.toThrow(/REVIEW_PROTOCOL_NOTE/);
  });
});
