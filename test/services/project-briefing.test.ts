import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_BRIEFING_BYTES,
  sessionBriefingPath,
  buildSessionBriefingContent,
  writeSessionBriefing,
} from "../../src/services/project-briefing.js";

describe("sessionBriefingPath", () => {
  it("joins sessionsDir and sessionId with the .briefing.md suffix", () => {
    expect(sessionBriefingPath("/tmp/sessions", "42")).toBe(
      path.join("/tmp/sessions", "42.briefing.md"),
    );
  });
});

describe("buildSessionBriefingContent", () => {
  it("prepends a self-identifying, always-additive header", () => {
    const content = buildSessionBriefingContent("the body");
    expect(content).toContain("the body");
    expect(content).toContain("pinned note");
    expect(content).toContain("AGENTS.md");
  });
});

describe("writeSessionBriefing", () => {
  let dir: string;

  it("writes the note, mode 0600, matching buildSessionBriefingContent", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    try {
      writeSessionBriefing(dir, "42", console, "hello note");

      const written = readFileSync(sessionBriefingPath(dir, "42"), "utf8");
      expect(written).toBe(buildSessionBriefingContent("hello note"));
      const mode = statSync(sessionBriefingPath(dir, "42")).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates a note over MAX_BRIEFING_BYTES and appends the truncation marker", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    try {
      writeSessionBriefing(dir, "42", console, "a".repeat(MAX_BRIEFING_BYTES * 2));

      const written = readFileSync(sessionBriefingPath(dir, "42"), "utf8");
      expect(written).toContain("[mullion: truncated at");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when no note is passed (undefined)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    try {
      writeSessionBriefing(dir, "42", console, undefined);

      expect(existsSync(sessionBriefingPath(dir, "42"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Hermes review, PR #893 — an empty-string note is a real, reachable
  // state (select-all-delete in the UI, then Save) and is NOT the same as
  // `undefined` (no row at all): it still gets written, producing a
  // per-session file with just the header and no body. Only DELETE
  // (project-tooling.ts's deleteProjectBriefing) — a genuinely different
  // action — clears the column back to null and stops injection entirely.
  it("still writes a file (header only) for an empty-string note — not the same as undefined", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    try {
      writeSessionBriefing(dir, "42", console, "");

      expect(existsSync(sessionBriefingPath(dir, "42"))).toBe(true);
      const written = readFileSync(sessionBriefingPath(dir, "42"), "utf8");
      expect(written).toBe(buildSessionBriefingContent(""));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unlinks a stale per-session copy once the project's note is cleared", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    try {
      writeSessionBriefing(dir, "42", console, "here today");
      expect(existsSync(sessionBriefingPath(dir, "42"))).toBe(true);

      writeSessionBriefing(dir, "42", console, undefined);

      expect(existsSync(sessionBriefingPath(dir, "42"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates sessionsDir if it doesn't exist yet", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    const nested = path.join(dir, "not-yet-created");
    try {
      writeSessionBriefing(nested, "1", console, "nested dir test");

      expect(readFileSync(sessionBriefingPath(nested, "1"), "utf8")).toContain("nested dir test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs and swallows the error instead of throwing when the write target can't be created", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    try {
      const blockingFile = path.join(dir, "blocked");
      writeFileSync(blockingFile, "not a directory");
      const sessionsDir = path.join(blockingFile, "sessions");

      const errors: unknown[] = [];
      expect(() =>
        writeSessionBriefing(
          sessionsDir,
          "1",
          { error: (obj) => errors.push(obj) },
          "won't be written",
        ),
      ).not.toThrow();
      expect(errors.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
