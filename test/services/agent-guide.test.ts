import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentGuideSourceExists,
  buildSessionAgentGuideContent,
  sessionAgentGuidePath,
  writeSessionAgentGuide,
} from "../../src/services/agent-guide.js";

// Issue #405 — writeSessionAgentGuide() is the helper Session.bootstrapMaster()
// calls unconditionally at spawn time to copy the shipped docs/agent-guide.md
// into a per-session file. `vitest run` (like `make dev`) has process.cwd()
// at the repo root, so docs/agent-guide.md resolves the same way it does for
// the real running server — no fixture/mock needed for the happy path.

describe("sessionAgentGuidePath", () => {
  it("joins sessionsDir and sessionId with the .agent-guide.md suffix", () => {
    expect(sessionAgentGuidePath("/tmp/sessions", "42")).toBe(
      path.join("/tmp/sessions", "42.agent-guide.md"),
    );
  });
});

describe("agentGuideSourceExists", () => {
  it("is true in this checkout (docs/agent-guide.md ships with the repo)", () => {
    expect(agentGuideSourceExists()).toBe(true);
  });
});

describe("writeSessionAgentGuide", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the shipped guide content, self-identifying header prepended, to the right per-session path", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-agent-guide-"));
    writeSessionAgentGuide(dir, "42");

    const written = readFileSync(sessionAgentGuidePath(dir, "42"), "utf8");
    const shipped = readFileSync(path.resolve(process.cwd(), "docs", "agent-guide.md"), "utf8");
    expect(written).toBe(buildSessionAgentGuideContent(shipped, sessionAgentGuidePath(dir, "42")));
    // Self-identifying: an agent whose only view of this is an unlabeled
    // `instructions` blob (opencode) still sees what it is and where it
    // lives, not just the guide's own body.
    expect(written).toContain("Mullion agent guide");
    expect(written).toContain(sessionAgentGuidePath(dir, "42"));
  });

  it("writes the per-session copy with 0600 permissions", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-agent-guide-"));
    writeSessionAgentGuide(dir, "7");

    const mode = statSync(sessionAgentGuidePath(dir, "7")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates sessionsDir if it doesn't exist yet (mirrors hook-adapters' own settingsFiles writer)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-agent-guide-"));
    const nested = path.join(dir, "not-yet-created");
    writeSessionAgentGuide(nested, "1");
    expect(readFileSync(sessionAgentGuidePath(nested, "1"), "utf8")).toContain("Mullion");
  });

  it("logs and swallows the error instead of throwing when the write target can't be created", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-agent-guide-"));
    // A regular file where a directory is expected — mkdirSync(..., {
    // recursive: true }) fails against this (ENOTDIR/EEXIST depending on
    // platform), giving a real, not-hand-thrown write failure to exercise
    // the defensive catch.
    const blockingFile = path.join(dir, "blocked");
    writeFileSync(blockingFile, "not a directory");
    const sessionsDir = path.join(blockingFile, "sessions");

    const errors: unknown[] = [];
    expect(() =>
      writeSessionAgentGuide(sessionsDir, "1", { error: (obj) => errors.push(obj) }),
    ).not.toThrow();
    expect(errors.length).toBe(1);
  });
});
