import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import { CANARY_FILE, placeCanary } from "../../src/services/scaffold-canary.js";
import {
  GenerationSpawnError,
  runGenerationTurnInScratchWorktree,
  type SpawnGenerationTurn,
} from "../../src/services/scaffold-generate.js";

describe("placeCanary", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes a fresh value to the canary file and keeps it out of the prompt", () => {
    const a = placeCanary(dir);
    expect(fs.readFileSync(path.join(dir, CANARY_FILE), "utf8").trim()).toBe(a.value);
    const prompt = a.withInstruction("Do the job.");
    expect(prompt).toContain(CANARY_FILE);
    expect(prompt).not.toContain(a.value);
    expect(placeCanary(dir).value).not.toBe(a.value);
  });

  it("accepts an echoed canary and strips its line", () => {
    const c = placeCanary(dir);
    expect(c.verify(`body\nMULLION_CANARY: ${c.value}\n`)).toBe("body\n");
    expect(c.verify(`MULLION_CANARY: ${c.value}`)).toBe("");
  });

  it("strips every echoed copy and handles CRLF", () => {
    const c = placeCanary(dir);
    const echo = `MULLION_CANARY: ${c.value}`;
    expect(c.verify(`${echo}\r\nbody\r\n${echo}\r\n`)).toBe("body\r\n");
  });

  it("rejects an inline echo that the line pattern could not strip", () => {
    const c = placeCanary(dir);
    expect(c.verify(`body \`MULLION_CANARY: ${c.value}\` more\n`)).toBeNull();
  });

  it("rejects a missing or wrong canary", () => {
    const c = placeCanary(dir);
    expect(c.verify("body\n")).toBeNull();
    expect(c.verify("body\nMULLION_CANARY: 0000000000000000\n")).toBeNull();
  });
});

describe("runGenerationTurnInScratchWorktree canary", () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "canary-repo-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env: gitEnv() });
    git(["init", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "README.md"), "# r\n");
    git(["add", "-A"]);
    git(["commit", "-m", "initial", "--no-verify"]);
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  const run = (spawn: SpawnGenerationTurn) =>
    runGenerationTurnInScratchWorktree({
      cwd: repo,
      slug: "demo",
      baseRef: "HEAD",
      agentCommand: "claude",
      prompt: "PROMPT",
      timeoutMs: 5000,
      spawn,
      canary: true,
    });

  it("returns the output without the canary line when the agent read the file", async () => {
    const out = await run(async ({ cwd, prompt }) => {
      expect(prompt).toContain(CANARY_FILE);
      const value = fs.readFileSync(path.join(cwd, CANARY_FILE), "utf8").trim();
      return `answer\nMULLION_CANARY: ${value}\n`;
    });
    expect(out).toBe("answer\n");
  });

  it("rejects, naming the likely causes, when the agent never echoed it", async () => {
    const failure = run(async () => "plausible answer written blind\n");
    await expect(failure).rejects.toBeInstanceOf(GenerationSpawnError);
    await expect(failure).rejects.toThrow(/did not read the repository/);
  });
});
