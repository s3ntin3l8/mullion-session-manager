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
  withReadCanary,
  type SpawnGenerationTurn,
} from "../../src/services/scaffold-generate.js";

describe("placeCanary", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes a fresh value to the canary file and keeps it out of the prompt", () => {
    const a = placeCanary(dir, os.tmpdir());
    expect(fs.readFileSync(path.join(dir, CANARY_FILE), "utf8").trim()).toBe(a.value);
    const prompt = a.withInstruction("Do the job.");
    expect(prompt).toContain(CANARY_FILE);
    expect(prompt).not.toContain(a.value);
    expect(placeCanary(dir, os.tmpdir()).value).not.toBe(a.value);
  });

  it("replaces a tracked symlink of that name and refuses a dir outside the root", () => {
    const victim = path.join(dir, "victim");
    fs.writeFileSync(victim, "keep");
    fs.symlinkSync(victim, path.join(dir, CANARY_FILE));
    const c = placeCanary(dir, os.tmpdir());
    expect(fs.readFileSync(victim, "utf8")).toBe("keep");
    expect(fs.lstatSync(path.join(dir, CANARY_FILE)).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dir, CANARY_FILE), "utf8").trim()).toBe(c.value);
    expect(() => placeCanary(dir, path.join(dir, "elsewhere"))).toThrow(/outside the scratch root/);
  });

  it("accepts an echoed canary and strips its line", () => {
    const c = placeCanary(dir, os.tmpdir());
    expect(c.verify(`body\nMULLION_CANARY: ${c.value}\n`)).toBe("body\n");
    expect(c.verify(`MULLION_CANARY: ${c.value}`)).toBe("");
  });

  it("strips every echoed copy and handles CRLF", () => {
    const c = placeCanary(dir, os.tmpdir());
    const echo = `MULLION_CANARY: ${c.value}`;
    expect(c.verify(`${echo}\r\nbody\r\n${echo}\r\n`)).toBe("body\r\n");
  });

  it("accepts a differently formatted echo and strips the decoration with it", () => {
    const c = placeCanary(dir, os.tmpdir());
    const echo = `MULLION_CANARY: ${c.value}`;
    expect(c.verify(`body\n- \`${echo}\`.\n`)).toBe("body\n");
    expect(c.verify(`body\n**${echo}**`)).toBe("body\n");
  });

  it("keeps real output that shares a line with the echo, markers included", () => {
    const c = placeCanary(dir, os.tmpdir());
    const echo = `MULLION_CANARY: ${c.value}`;
    expect(c.verify(`See src/marker.ts for the rule. ${echo}\n`)).toBe(
      "See src/marker.ts for the rule.\n",
    );
    expect(c.verify(`<<<MULLION_SKILL_END>>> ${echo}\nnext\n`)).toBe(
      "<<<MULLION_SKILL_END>>>\nnext\n",
    );
  });

  it("keeps a frontmatter fence or rule that carried the echo", () => {
    const c = placeCanary(dir, os.tmpdir());
    expect(c.verify(`--- MULLION_CANARY: ${c.value}\nname: x\n`)).toBe("---\nname: x\n");
  });

  it("rejects a missing or wrong canary", () => {
    const c = placeCanary(dir, os.tmpdir());
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

  const run = (inner: SpawnGenerationTurn) =>
    runGenerationTurnInScratchWorktree({
      cwd: repo,
      slug: "demo",
      baseRef: "HEAD",
      agentCommand: "claude",
      prompt: "PROMPT",
      timeoutMs: 5000,
      spawn: withReadCanary(inner),
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
