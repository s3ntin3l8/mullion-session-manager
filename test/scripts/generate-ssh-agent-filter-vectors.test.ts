// Round 4 (issue #820) — exercises the REAL generator script via execFile
// (precedent: test/scripts/self-update.test.ts, test/scripts/check-briefing-
// sync.test.ts), the drift guard `npm run lint` actually runs
// (check:ssh-agent-filter-vectors). Uses SSH_AGENT_FILTER_VECTORS_FIXTURE_PATH
// to point the script at a per-test tmpdir fixture instead of the real,
// tracked JSON file — the same injectable-override convention
// check-briefing-sync.mjs's own BRIEFING_SYNC_ROOT already established, so
// these tests never touch this repo's own checked-in fixture.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SSH_AGENT_REQUEST_TYPE_VECTORS } from "../../src/services/ssh-agent-filter.js";
import { buildFixture } from "../../scripts/generate-ssh-agent-filter-vectors.js";

const execFileAsync = promisify(execFile);

const root = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(root, "scripts/generate-ssh-agent-filter-vectors.ts");
const REAL_FIXTURE_PATH = path.join(root, "test/fixtures/ssh-agent-filter-vectors.json");

function runScript(fixturePath: string, args: string[] = []) {
  return execFileAsync("npx", ["tsx", SCRIPT, ...args], {
    cwd: root,
    env: { ...process.env, SSH_AGENT_FILTER_VECTORS_FIXTURE_PATH: fixturePath },
  });
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
    const { stdout } = await runScript(REAL_FIXTURE_PATH, ["--check"]);
    expect(stdout).toContain("OK");
  });

  describe("against a tmpdir fixture (never touches the real, tracked JSON)", () => {
    let dir: string;
    let fixturePath: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), "ssh-agent-filter-vectors-test-"));
      fixturePath = path.join(dir, "ssh-agent-filter-vectors.json");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("writes a fresh fixture when run without --check", async () => {
      expect(existsSync(fixturePath)).toBe(false);
      const { stdout } = await runScript(fixturePath);
      expect(stdout).toContain("wrote");
      const written = JSON.parse(readFileSync(fixturePath, "utf8"));
      expect(written.vectors).toEqual(buildFixture().vectors);
    });

    it("--check passes once a fresh fixture has been written", async () => {
      await runScript(fixturePath);
      const { stdout } = await runScript(fixturePath, ["--check"]);
      expect(stdout).toContain("OK");
    });

    it("--check fails when the fixture has drifted from the live TS table", async () => {
      await runScript(fixturePath);
      const drifted = readFileSync(fixturePath, "utf8").replace(
        '"allowed": true',
        '"allowed": false',
      );
      writeFileSync(fixturePath, drifted);

      await expect(runScript(fixturePath, ["--check"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("out of date"),
      });
    });

    it("--check fails when the fixture doesn't exist at all — a genuinely missing file, not an empty one", async () => {
      expect(existsSync(fixturePath)).toBe(false);

      await expect(runScript(fixturePath, ["--check"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("out of date"),
      });
    });
  });
});
