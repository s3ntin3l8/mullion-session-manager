// Approving or dismissing a proposal is a human decision (see
// docs/tasks-internals.md, "Proposed tasks"). The only thing keeping an agent
// from approving the issue it filed is that no agent-facing surface offers the
// two routes, so this fails if one ever starts to: the control socket's ops,
// the MCP tools and the CLI.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const AGENT_SURFACES = ["src/plugins", "src/mcp", "src/cli"];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|mjs|js)$/.test(e.name) ? [p] : [];
  });
}

describe("proposal routes stay off the agent surface", () => {
  const files = AGENT_SURFACES.flatMap((d) => sourceFiles(path.join(root, d)));

  it("finds the surfaces it is meant to scan", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("control-socket-tasks.ts"))).toBe(true);
  });

  it.each(["approve-proposal", "dismiss-proposal"])("nothing there mentions %s", (route) => {
    const hits = files.filter((f) => fs.readFileSync(f, "utf8").includes(route));
    expect(hits.map((f) => path.relative(root, f))).toEqual([]);
  });
});
