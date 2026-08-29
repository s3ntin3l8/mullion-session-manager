// Round 4 (issue #820) — exercises the REAL generator script via execFile
// (precedent: test/scripts/self-update.test.ts, test/scripts/check-briefing-
// sync.test.ts), the drift guard `npm run lint` actually runs
// (check:ssh-agent-filter-vectors). Unlike those two scripts, this one has
// no injectable root — it always reads src/services/ssh-agent-filter.ts and
// test/fixtures/ssh-agent-filter-vectors.json at their real repo paths, so
// the discriminating case below temporarily corrupts and restores the real
// checked-in fixture rather than operating against a fixture directory.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SSH_AGENT_REQUEST_TYPE_VECTORS } from "../../src/services/ssh-agent-filter.js";
import { buildFixture } from "../../scripts/generate-ssh-agent-filter-vectors.js";

const execFileAsync = promisify(execFile);

const root = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(root, "scripts/generate-ssh-agent-filter-vectors.ts");
const FIXTURE_PATH = path.join(root, "test/fixtures/ssh-agent-filter-vectors.json");

function runScript(args: string[] = []) {
  return execFileAsync("npx", ["tsx", SCRIPT, ...args], { cwd: root });
}

describe("scripts/generate-ssh-agent-filter-vectors.ts", () => {
  it("buildFixture() produces exactly the live TS table's vectors, faithfully", () => {
    const fixture = buildFixture();
    expect(fixture.vectors).toEqual(
      SSH_AGENT_REQUEST_TYPE_VECTORS.map((v) => ({
        type: v.type,
        name: v.name,
        allowed: v.allowed,
      })),
    );
  });

  it("states the two facts not representable in {type,name,allowed} alone: default-deny and reply-direction-unfiltered", () => {
    const fixture = buildFixture();
    expect(fixture.defaultAllowed).toBe(false);
    expect(fixture.replyDirectionFiltered).toBe(false);
  });

  it("--check passes against the real, checked-in fixture (it must actually be up to date)", async () => {
    const { stdout } = await runScript(["--check"]);
    expect(stdout).toContain("OK");
  });

  describe("drift detection", () => {
    let original: string;

    afterEach(() => {
      writeFileSync(FIXTURE_PATH, original);
    });

    it("--check fails when the checked-in fixture has drifted from the live TS table", async () => {
      original = readFileSync(FIXTURE_PATH, "utf8");
      writeFileSync(FIXTURE_PATH, original.replace('"allowed": true', '"allowed": false'));

      await expect(runScript(["--check"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("out of date"),
      });
    });

    it("--check fails when the fixture doesn't exist at all yet", async () => {
      original = readFileSync(FIXTURE_PATH, "utf8");
      writeFileSync(FIXTURE_PATH, ""); // closest to "missing" without actually unlinking a tracked file mid-test-run

      await expect(runScript(["--check"])).rejects.toMatchObject({ code: 1 });
    });
  });
});
