import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MARKER_START,
  MARKER_END,
  MAX_BRIEFING_BYTES,
  resolveProjectBriefing,
  sessionBriefingPath,
  buildSessionBriefingContent,
  writeSessionBriefing,
} from "../../src/services/project-briefing.js";

function mkProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-"));
}

function marked(body: string): string {
  return `intro\n${MARKER_START}\n${body}\n${MARKER_END}\nfooter`;
}

describe("sessionBriefingPath", () => {
  it("joins sessionsDir and sessionId with the .briefing.md suffix", () => {
    expect(sessionBriefingPath("/tmp/sessions", "42")).toBe(
      path.join("/tmp/sessions", "42.briefing.md"),
    );
  });
});

describe("resolveProjectBriefing", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a marked region in AGENTS.md", () => {
    dir = mkProject();
    writeFileSync(path.join(dir, "AGENTS.md"), marked("worktree rules here"));
    const result = resolveProjectBriefing(dir);
    expect(result?.body).toBe("worktree rules here");
    expect(result?.sourcePath).toBe(path.join(dir, "AGENTS.md"));
  });

  it("falls back to CLAUDE.md when AGENTS.md has no marked region", () => {
    dir = mkProject();
    writeFileSync(path.join(dir, "AGENTS.md"), "no markers here at all");
    writeFileSync(path.join(dir, "CLAUDE.md"), marked("claude rules"));
    const result = resolveProjectBriefing(dir);
    expect(result?.body).toBe("claude rules");
    expect(result?.sourcePath).toBe(path.join(dir, "CLAUDE.md"));
  });

  it("falls back to .agents/briefing.md, whole file, when neither AGENTS.md nor CLAUDE.md resolve", () => {
    dir = mkProject();
    mkdirSync(path.join(dir, ".agents"), { recursive: true });
    writeFileSync(path.join(dir, ".agents", "briefing.md"), "  plain unmarked text  ");
    const result = resolveProjectBriefing(dir);
    expect(result?.body).toBe("plain unmarked text");
    expect(result?.sourcePath).toBe(path.join(dir, ".agents", "briefing.md"));
  });

  it("a marked region inside .agents/briefing.md still wins over that file's full body", () => {
    dir = mkProject();
    mkdirSync(path.join(dir, ".agents"), { recursive: true });
    writeFileSync(path.join(dir, ".agents", "briefing.md"), marked("just this part"));
    const result = resolveProjectBriefing(dir);
    expect(result?.body).toBe("just this part");
  });

  it("AGENTS.md wins over CLAUDE.md when both have marked regions", () => {
    dir = mkProject();
    writeFileSync(path.join(dir, "AGENTS.md"), marked("from agents"));
    writeFileSync(path.join(dir, "CLAUDE.md"), marked("from claude"));
    const result = resolveProjectBriefing(dir);
    expect(result?.body).toBe("from agents");
  });

  it("returns null for an unmarked CLAUDE.md — never dumps the whole file", () => {
    dir = mkProject();
    writeFileSync(path.join(dir, "CLAUDE.md"), "# Just a normal CLAUDE.md\nlots of prose here");
    expect(resolveProjectBriefing(dir)).toBeNull();
  });

  it("returns null when no candidate files exist at all", () => {
    dir = mkProject();
    expect(resolveProjectBriefing(dir)).toBeNull();
  });

  it("refuses to follow a symlinked AGENTS.md (O_NOFOLLOW)", () => {
    dir = mkProject();
    const outside = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-outside-"));
    writeFileSync(path.join(outside, "secret.md"), marked("should never be read"));
    symlinkSync(path.join(outside, "secret.md"), path.join(dir, "AGENTS.md"));
    expect(resolveProjectBriefing(dir)).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a symlinked .agents directory even though the leaf file itself isn't a symlink", () => {
    dir = mkProject();
    const outside = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-outside-"));
    writeFileSync(path.join(outside, "briefing.md"), "outside content");
    symlinkSync(outside, path.join(dir, ".agents"));
    expect(resolveProjectBriefing(dir)).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it("returns null for a source file containing a NUL byte", () => {
    dir = mkProject();
    const buf = Buffer.concat([
      Buffer.from(`intro\n${MARKER_START}\n`),
      Buffer.from([0]),
      Buffer.from(`\n${MARKER_END}`),
    ]);
    writeFileSync(path.join(dir, "AGENTS.md"), buf);
    expect(resolveProjectBriefing(dir)).toBeNull();
  });

  it("follows the given cwd, not process.cwd() — the worktree case", () => {
    const worktreeA = mkProject();
    const worktreeB = mkProject();
    writeFileSync(path.join(worktreeA, "AGENTS.md"), marked("worktree A briefing"));
    writeFileSync(path.join(worktreeB, "AGENTS.md"), marked("worktree B briefing"));

    expect(resolveProjectBriefing(worktreeA)?.body).toBe("worktree A briefing");
    expect(resolveProjectBriefing(worktreeB)?.body).toBe("worktree B briefing");

    rmSync(worktreeA, { recursive: true, force: true });
    rmSync(worktreeB, { recursive: true, force: true });
  });
});

describe("buildSessionBriefingContent", () => {
  it("prepends a self-identifying header naming the source path", () => {
    const content = buildSessionBriefingContent("the body", "/repo/AGENTS.md");
    expect(content).toContain("/repo/AGENTS.md");
    expect(content).toContain("the body");
    expect(content).toContain("Project briefing");
  });
});

describe("writeSessionBriefing", () => {
  let dir: string;
  let cwd: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("writes the resolved briefing, mode 0600, matching buildSessionBriefingContent", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    cwd = mkProject();
    writeFileSync(path.join(cwd, "AGENTS.md"), marked("hello briefing"));

    writeSessionBriefing(dir, "42", cwd);

    const written = readFileSync(sessionBriefingPath(dir, "42"), "utf8");
    expect(written).toBe(
      buildSessionBriefingContent("hello briefing", path.join(cwd, "AGENTS.md")),
    );
    const mode = statSync(sessionBriefingPath(dir, "42")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("truncates a body over MAX_BRIEFING_BYTES and appends the truncation marker", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    cwd = mkProject();
    writeFileSync(path.join(cwd, "AGENTS.md"), marked("a".repeat(MAX_BRIEFING_BYTES * 2)));

    writeSessionBriefing(dir, "42", cwd);

    const written = readFileSync(sessionBriefingPath(dir, "42"), "utf8");
    expect(written).toContain("[mullion: truncated at");
  });

  it("writes nothing when no briefing resolves for cwd", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    cwd = mkProject();

    writeSessionBriefing(dir, "42", cwd);

    expect(existsSync(sessionBriefingPath(dir, "42"))).toBe(false);
  });

  it("unlinks a stale per-session copy once the project's briefing disappears", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    cwd = mkProject();
    writeFileSync(path.join(cwd, "AGENTS.md"), marked("here today"));
    writeSessionBriefing(dir, "42", cwd);
    expect(existsSync(sessionBriefingPath(dir, "42"))).toBe(true);

    writeFileSync(path.join(cwd, "AGENTS.md"), "gone tomorrow, no markers");
    writeSessionBriefing(dir, "42", cwd);

    expect(existsSync(sessionBriefingPath(dir, "42"))).toBe(false);
  });

  it("creates sessionsDir if it doesn't exist yet", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    const nested = path.join(dir, "not-yet-created");
    cwd = mkProject();
    writeFileSync(path.join(cwd, "AGENTS.md"), marked("nested dir test"));

    writeSessionBriefing(nested, "1", cwd);

    expect(readFileSync(sessionBriefingPath(nested, "1"), "utf8")).toContain("nested dir test");
  });

  it("logs and swallows the error instead of throwing when the write target can't be created", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
    cwd = mkProject();
    writeFileSync(path.join(cwd, "AGENTS.md"), marked("won't be written"));
    const blockingFile = path.join(dir, "blocked");
    writeFileSync(blockingFile, "not a directory");
    const sessionsDir = path.join(blockingFile, "sessions");

    const errors: unknown[] = [];
    expect(() =>
      writeSessionBriefing(sessionsDir, "1", cwd, { error: (obj) => errors.push(obj) }),
    ).not.toThrow();
    expect(errors.length).toBe(1);
  });

  // Issue: per-project briefing storage (a follow-up PR) — this PR only
  // wires the channel through writeSessionBriefing's optional `override`
  // param; no producer sets it yet, but the channel itself must already be
  // correct. See CreateSessionOptions.briefingOverride's own doc comment
  // (pty-manager.ts) for the multi-host reasoning this exists for.
  describe("override param", () => {
    it("wins over a repo-authored AGENTS.md region when both are present", () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
      cwd = mkProject();
      writeFileSync(path.join(cwd, "AGENTS.md"), marked("repo-authored briefing"));

      writeSessionBriefing(dir, "42", cwd, console, {
        body: "override briefing",
        sourceLabel: "Mullion's per-project settings",
      });

      const written = readFileSync(sessionBriefingPath(dir, "42"), "utf8");
      expect(written).toBe(
        buildSessionBriefingContent("override briefing", "Mullion's per-project settings"),
      );
      expect(written).not.toContain("repo-authored briefing");
    });

    it("is used even when nothing resolves from cwd at all", () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
      cwd = mkProject();

      writeSessionBriefing(dir, "42", cwd, console, {
        body: "override with no repo briefing present",
        sourceLabel: "Mullion's per-project settings",
      });

      expect(existsSync(sessionBriefingPath(dir, "42"))).toBe(true);
      expect(readFileSync(sessionBriefingPath(dir, "42"), "utf8")).toContain(
        "override with no repo briefing present",
      );
    });

    it("still goes through the same MAX_BRIEFING_BYTES clamp as a resolved file body", () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
      cwd = mkProject();

      writeSessionBriefing(dir, "42", cwd, console, {
        body: "a".repeat(MAX_BRIEFING_BYTES * 2),
        sourceLabel: "Mullion's per-project settings",
      });

      const written = readFileSync(sessionBriefingPath(dir, "42"), "utf8");
      expect(written).toContain("[mullion: truncated at");
    });

    it("does not resolve or read any file from cwd when an override is present", () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-briefing-sessions-"));
      // A cwd that doesn't even exist — if writeSessionBriefing tried to
      // resolve it, resolveProjectBriefing's own existsSync checks would
      // just return null (not throw), so this alone doesn't prove much;
      // the real proof is the previous "wins over a repo-authored AGENTS.md"
      // test. This one guards against a future edit accidentally requiring
      // cwd to exist even when override is supplied.
      cwd = path.join(os.tmpdir(), "mullion-briefing-nonexistent-cwd");

      expect(() =>
        writeSessionBriefing(dir, "42", cwd, console, {
          body: "override body",
          sourceLabel: "Mullion's per-project settings",
        }),
      ).not.toThrow();
      expect(readFileSync(sessionBriefingPath(dir, "42"), "utf8")).toContain("override body");
    });
  });
});
