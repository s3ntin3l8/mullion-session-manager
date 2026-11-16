import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: () => ({ opencode: { implementerModel: null, reviewerModel: null } }),
}));

import { stripFencedCode } from "../../src/services/issue-body-directives.js";
import { parsePlacementRequirement } from "../../src/services/task-placement-resolve.js";
import { issueDirectiveAgents } from "../../src/services/task-agent-resolve.js";
import { resolveOpenCodeModel } from "../../src/services/task-model-resolve.js";
import { isManualOnly } from "../../src/services/task-watcher.js";

const app = { log: { warn: vi.fn() }, db: {} } as unknown as FastifyInstance;
const model = (body: string) => resolveOpenCodeModel(app, { issueBody: body });

// #3101's snippet: `host: app.config.HOST,` inside a TypeScript block.
const SNIPPET = "Spec.\n\n```ts\nconst o = {\n  host: app.config.HOST,\n};\n```\n";
const fenced = (line: string) => `\`\`\`\n${line}\n\`\`\`\n`;

describe("stripFencedCode", () => {
  it("blanks ``` and ~~~ blocks, keeps surrounding lines and line count", () => {
    const body = "a\n```ts\nx\n```\nb\n~~~\ny\n~~~\nc";
    expect(stripFencedCode(body)).toBe("a\n\n\n\nb\n\n\n\nc");
  });
  it("blanks to the end of the body for an unterminated fence", () => {
    expect(stripFencedCode("a\n```\nHost: x\nmore")).toBe("a\n\n\n");
  });
  it("only closes on the same fence char, at least as long", () => {
    expect(stripFencedCode("````\nHost: x\n```\nHost: y\n````\nz")).toBe("\n\n\n\n\nz");
    expect(stripFencedCode("```\nHost: x\n~~~\nHost: y\n```\nz")).toBe("\n\n\n\n\nz");
  });
  it("leaves inline triple-backtick code alone", () => {
    expect(stripFencedCode("use ```x``` here\nHost: a")).toBe("use ```x``` here\nHost: a");
  });
});

describe("directives inside code fences are ignored", () => {
  it("Host:/Platform:", () => {
    expect(parsePlacementRequirement(SNIPPET)).toBeNull();
    expect(parsePlacementRequirement(fenced("Platform: darwin"))).toBeNull();
    expect(parsePlacementRequirement("```\nHost: x")).toBeNull();
    expect(parsePlacementRequirement(`${SNIPPET}\nHost: foo`)).toEqual({ hostId: "foo" });
    expect(parsePlacementRequirement(`${fenced("Platform: linux")}Platform: darwin`)).toEqual({
      platform: "darwin",
    });
  });
  it("Agent:/ReviewAgent:", () => {
    expect(issueDirectiveAgents(app, fenced("Agent: codex")).issueAgent).toBeNull();
    expect(issueDirectiveAgents(app, `${fenced("Agent: codex")}Agent: claude`).issueAgent).toBe(
      "claude",
    );
  });
  it("Model:", () => {
    expect(model(fenced("Model: a/b"))).toBeNull();
    expect(model(`${fenced("Model: a/b")}Model: c/d`)).toBe("c/d");
  });
  it("Manual:", () => {
    expect(isManualOnly(fenced("Manual: true"))).toBe(false);
    expect(isManualOnly("~~~\nManual: true\n~~~\n")).toBe(false);
    expect(isManualOnly(`${fenced("x")}Manual: true`)).toBe(true);
  });
});
