import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitEnv } from "../../src/services/git-env.js";
import { LOCAL_HOST_ID } from "../../src/services/host-registry.js";
import {
  buildGenerationPrompt,
  generateScaffoldContent,
  type SpawnGenerationTurn,
} from "../../src/services/scaffold-generate.js";
import { CODEX_REVIEWER_DELEGATION_CLAUSE } from "../../src/services/mullion-scaffold.js";
import { computeScaffold } from "../../src/services/mullion-scaffold.js";
import { commandsTableConflict } from "../../src/services/scaffold-commands.js";

const table = [
  "| Command | What |",
  "| --- | --- |",
  "| `make install` | deps |",
  "| `make test` | tests |",
  "| `make lint` | lint |",
  "| `npm run build` | bundle |",
].join("\n");

describe("commandsTableConflict (issue #2933)", () => {
  it("reports an AGENTS.md conflict with no disposition when fewer than half survive", () => {
    const conflict = commandsTableConflict(
      [table, "- `make dev`\n- not a command"],
      "# P\n\nmake test\n",
    );
    expect(conflict).toMatchObject({ file: "AGENTS.md", kind: "commands" });
    expect(conflict).not.toHaveProperty("disposition");
    expect(conflict?.excerpt).toContain("make install");
    expect(conflict?.excerpt).toContain("make lint");
    expect(conflict?.excerpt).toContain("npm run build");
    expect(conflict?.excerpt).toContain("make dev");
    expect(conflict?.excerpt).not.toContain("make test");
  });

  it("stays quiet when the rewrite keeps at least half, and ignores prose", () => {
    expect(
      commandsTableConflict([table], "Run make install, make test, npm run build, and make lint."),
    ).toBeUndefined();
    expect(commandsTableConflict(["make test is mentioned in prose"], "# P\n")).toBeUndefined();
    expect(commandsTableConflict([table], undefined)).toBeUndefined();
  });

  it("does not treat a longer command name as covering the shorter one", () => {
    const conflict = commandsTableConflict(["- `make test`\n- `make lint`"], "make test-coverage");
    expect(conflict?.excerpt).toContain("make test");
    expect(conflict?.excerpt).toContain("make lint");
  });

  it("ignores a prose list item that merely starts with make", () => {
    const prose = [
      "- `make test`",
      "- `make lint`",
      "- `npm run build`",
      "- make sure the lockfile is committed",
      "- make it obvious",
    ].join("\n");
    expect(commandsTableConflict([prose], "make test\nmake lint")).toBeUndefined();
  });

  it("counts a bare command written as a whole table cell", () => {
    const bare = [
      "| Command | What |",
      "| --- | --- |",
      "| make test | tests |",
      "| make lint | lint |",
      "| npm run build | bundle |",
    ].join("\n");
    const conflict = commandsTableConflict([bare], "make test");
    expect(conflict?.excerpt).toContain("make lint");
    expect(conflict?.excerpt).toContain("npm run build");
    expect(conflict?.excerpt).not.toContain("make test");
  });
});

describe("restructure prompt and result (issue #2933)", () => {
  it("tells only a restructure turn to keep the commands table", () => {
    const base = {
      slug: "demo",
      seed: {},
      hasSkill: false,
      hasReviewer: false,
      hasScaffoldRegion: false,
    };
    expect(buildGenerationPrompt({ ...base, existingInstructions: "restructure" })).toContain(
      "commands table or list",
    );
    expect(buildGenerationPrompt({ ...base, existingInstructions: "report" })).not.toContain(
      "commands table or list",
    );
  });

  it("appends the conflict on a restructure turn and does not block a deliberate CLAUDE.md drop", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "commands-table-"));
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "README.md"), "# test\n");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "init", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    const agents = `# P\n\nIntro.\n\n<<<MULLION_REGION>>>\n\n## Commands\n${table}\n`;
    const stdout =
      `<<<MULLION_SKILL_START>>>\n---\nname: demo\n---\nReal invariant.\n<<<MULLION_SKILL_END>>>\n` +
      `<<<MULLION_REVIEWER_START>>>\n---\nname: demo-reviewer\ndescription: "Review changes. ${CODEX_REVIEWER_DELEGATION_CLAUSE}"\n---\nRead .claude/skills/demo/SKILL.md first.\n<<<MULLION_REVIEWER_END>>>\n` +
      `<<<MULLION_SCAFFOLD_REGION_START>>>\nPointer.\n<<<MULLION_SCAFFOLD_REGION_END>>>\n` +
      `<<<MULLION_AGENTS_MD_START>>>\n# P\n\n<<<MULLION_REGION>>>\n\n## Repo specifics\n- make test\n<<<MULLION_AGENTS_MD_END>>>\n` +
      `<<<MULLION_CONFLICTS_START>>>\n${JSON.stringify({ file: "CLAUDE.md", excerpt: "old", kind: "other", note: "gone", disposition: "dropped-obsolete" })}\n<<<MULLION_CONFLICTS_END>>>\n`;
    const spawn: SpawnGenerationTurn = async () => stdout;
    try {
      const result = await generateScaffoldContent({
        app: {} as never,
        hostId: LOCAL_HOST_ID,
        cwd,
        slug: "demo",
        agentCommand: "claude",
        seed: {},
        hasSkill: false,
        hasReviewer: false,
        hasScaffoldRegion: false,
        existingInstructions: "restructure",
        originalAgentsMd: agents,
        spawn,
      });
      const added = result.conflicts?.find((c) => c.kind === "commands");
      expect(added).toMatchObject({ file: "AGENTS.md" });
      expect(added?.disposition).toBeUndefined();
      const longClaude = `# Title\n\n${Array.from({ length: 40 }, () => "rule").join("\n")}\n`;
      const claude = computeScaffold(
        { "CLAUDE.md": longClaude, "AGENTS.md": agents },
        {
          slug: "demo",
          generated: {
            agentsMdBody: result.agentsMdBody,
            conflicts: result.conflicts?.map((c) => ({ file: c.file, disposition: c.disposition })),
          },
        },
      ).find((e) => e.path === "CLAUDE.md");
      expect((claude as { contents: string }).contents).not.toContain("rule");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("sees a commands table that lives only in CLAUDE.md", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "commands-claude-"));
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    fs.writeFileSync(path.join(cwd, "README.md"), "# test\n");
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe", env: gitEnv() });
    execFileSync("git", ["commit", "-m", "init", "--no-verify"], {
      cwd,
      stdio: "pipe",
      env: gitEnv(),
    });
    const agents = "# P\n\nIntro.\n\n<<<MULLION_REGION>>>\n";
    const claudeMd = `# Claude\n\n## Commands\n${table}\n`;
    const stdout =
      `<<<MULLION_SKILL_START>>>\n---\nname: demo\n---\nReal invariant.\n<<<MULLION_SKILL_END>>>\n` +
      `<<<MULLION_REVIEWER_START>>>\n---\nname: demo-reviewer\ndescription: "Review changes. ${CODEX_REVIEWER_DELEGATION_CLAUSE}"\n---\nRead .claude/skills/demo/SKILL.md first.\n<<<MULLION_REVIEWER_END>>>\n` +
      `<<<MULLION_SCAFFOLD_REGION_START>>>\nPointer.\n<<<MULLION_SCAFFOLD_REGION_END>>>\n` +
      `<<<MULLION_AGENTS_MD_START>>>\n# P\n\n<<<MULLION_REGION>>>\n\n## Repo specifics\n- make test\n<<<MULLION_AGENTS_MD_END>>>\n`;
    const spawn: SpawnGenerationTurn = async () => stdout;
    try {
      const result = await generateScaffoldContent({
        app: {} as never,
        hostId: LOCAL_HOST_ID,
        cwd,
        slug: "demo",
        agentCommand: "claude",
        seed: {},
        hasSkill: false,
        hasReviewer: false,
        hasScaffoldRegion: false,
        existingInstructions: "restructure",
        originalAgentsMd: agents,
        originalClaudeMd: claudeMd,
        spawn,
      });
      expect(result.conflicts?.find((c) => c.kind === "commands")).toMatchObject({
        file: "AGENTS.md",
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
