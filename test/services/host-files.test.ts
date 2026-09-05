import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";

// Issue #895 — host-files.ts's whole job is dispatching (app, hostId, cwd,
// ...) calls to either the real local read/write helpers or a
// RemoteHostClient method, mapping errors onto host-git.ts's
// HostGitResult — same "mock every collaborator, test dispatch/mapping
// only" posture as test/services/host-git.test.ts. readFilesLocally/
// writeEntriesLocally themselves are exercised against a REAL temp
// directory below (they're pure fs functions, cheap and safe to run for
// real, unlike git-status.ts/git-push.ts's shell-outs the sibling test
// file mocks) — this also doubles as a regression test for the exact
// behavior moved verbatim out of routes/project-setup.ts.

const mockGetRemoteHostClient = vi.fn();

vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: mockGetRemoteHostClient,
  HostRequestError: class extends Error {
    statusCode: number;
    constructor(hostId: string, statusCode: number, body: string) {
      super(`Host ${hostId} rejected the request: HTTP ${statusCode}${body ? ` — ${body}` : ""}`);
      this.name = "HostRequestError";
      this.statusCode = statusCode;
    }
  },
  HostUnreachableError: class extends Error {
    constructor(hostId: string, cause: unknown) {
      super(
        `Host ${hostId} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.name = "HostUnreachableError";
    }
  },
}));

const { readHostFiles, writeHostFiles, readFilesLocally, writeEntriesLocally } =
  await import("../../src/services/host-files.js");
const { PathEscapeError } = await import("../../src/services/safe-path.js");
const { HostUnreachableError, HostRequestError } =
  await import("../../src/services/remote-host-client.js");

const fakeApp = { config: {} } as never;

function initRepo(cwd: string) {
  execFileSync("git", ["init", "-b", "main"], { cwd, env: gitEnv() });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, env: gitEnv() });
  execFileSync("git", ["config", "user.name", "Test"], { cwd, env: gitEnv() });
}

function gitStatusPorcelain(cwd: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd, env: gitEnv() }).toString().trim();
}

describe("host-files.ts", () => {
  let cwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(path.join(os.tmpdir(), "host-files-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("readFilesLocally", () => {
    it("reads existing files, and represents a missing path as a missing key", () => {
      writeFileSync(path.join(cwd, "AGENTS.md"), "hello\n");

      const result = readFilesLocally(cwd, ["AGENTS.md", "MISSING.md"]);

      expect(result["AGENTS.md"]).toBe("hello\n");
      expect("MISSING.md" in result).toBe(false);
    });

    it("represents a directory as an empty-string existence sentinel (EISDIR)", () => {
      mkdirSync(path.join(cwd, "adir"));

      const result = readFilesLocally(cwd, ["adir"]);

      expect(result["adir"]).toBe("");
    });

    it("throws PathEscapeError for a traversal path", () => {
      expect(() => readFilesLocally(cwd, ["../../etc/passwd"])).toThrow(PathEscapeError);
    });
  });

  describe("writeEntriesLocally", () => {
    it("writes a file entry", () => {
      writeEntriesLocally(cwd, [{ path: "AGENTS.md", kind: "file", contents: "hi\n" }]);

      expect(readFileSync(path.join(cwd, "AGENTS.md"), "utf8")).toBe("hi\n");
    });

    it("writes a symlink entry with its target verbatim, not resolved", () => {
      // Two ".." segments — matches computeScaffold's own (issue #895-fixed)
      // target: a relative symlink target resolves relative to the LINK'S
      // OWN DIRECTORY (.agents/skills), not its full path including its
      // own name. See mullion-scaffold.test.ts's own regression test for
      // the bug this used to have (a three-segment target).
      writeEntriesLocally(cwd, [
        {
          path: path.join(".agents", "skills", "demo"),
          kind: "symlink",
          target: "../../.claude/skills/demo",
        },
      ]);

      const linkPath = path.join(cwd, ".agents", "skills", "demo");
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe("../../.claude/skills/demo");
    });

    it("throws PathEscapeError for a symlink target that would resolve outside cwd", () => {
      expect(() =>
        writeEntriesLocally(cwd, [
          {
            path: path.join(".agents", "skills", "demo"),
            kind: "symlink",
            target: "../../../etc/passwd",
          },
        ]),
      ).toThrow(PathEscapeError);
    });

    it("throws PathEscapeError for an ABSOLUTE symlink target, not silently mangled into an in-bounds one", () => {
      // mullion-reviewer review, PR #1102 — `path.join` (unlike
      // `path.resolve`) does not reset on an absolute second argument, so a
      // naive `resolveWithin(cwd, path.join(dir, target))` containment check
      // would validate "/etc/passwd" as if it were the harmless relative
      // string "etc/passwd" while `symlinkSync` itself still received and
      // honored the real, unmangled absolute target — a containment bypass
      // for exactly the wire-reachable input this check exists to guard.
      expect(() =>
        writeEntriesLocally(cwd, [
          {
            path: path.join(".agents", "skills", "demo"),
            kind: "symlink",
            target: "/etc/passwd",
          },
        ]),
      ).toThrow(PathEscapeError);

      expect(
        lstatSync(path.join(cwd, ".agents", "skills", "demo"), { throwIfNoEntry: false }),
      ).toBe(undefined);
    });

    it("replaces a stale symlink pointing at a different target", () => {
      mkdirSync(path.join(cwd, ".agents", "skills"), { recursive: true });
      symlinkSync("old-target", path.join(cwd, ".agents", "skills", "demo"));

      writeEntriesLocally(cwd, [
        { path: path.join(".agents", "skills", "demo"), kind: "symlink", target: "new-target" },
      ]);

      expect(readlinkSync(path.join(cwd, ".agents", "skills", "demo"))).toBe("new-target");
    });

    it("removes a stale symlinked PARENT directory before writing a plain file into it (Hermes review, PR #896 round 2) — the switching-from-symlink-mode scenario", () => {
      // Mirrors a same-slug re-preview that switches OFF symlinkAgentsSkills:
      // an earlier symlink-mode preview left `.agents/skills/demo` as a
      // symlink; the file-mode variant needs to write
      // `.agents/skills/demo/SKILL.md`, whose PARENT is that stale symlink.
      mkdirSync(path.join(cwd, ".agents", "skills"), { recursive: true });
      symlinkSync("/nonexistent", path.join(cwd, ".agents", "skills", "demo"));

      writeEntriesLocally(cwd, [
        {
          path: path.join(".agents", "skills", "demo", "SKILL.md"),
          kind: "file",
          contents: "real content\n",
        },
      ]);

      const dirPath = path.join(cwd, ".agents", "skills", "demo");
      expect(lstatSync(dirPath).isSymbolicLink()).toBe(false);
      expect(readFileSync(path.join(dirPath, "SKILL.md"), "utf8")).toBe("real content\n");
    });

    it("stages every change via git add -A when opts.stage is set", () => {
      initRepo(cwd);

      writeEntriesLocally(cwd, [{ path: "AGENTS.md", kind: "file", contents: "hi\n" }], {
        stage: true,
      });

      expect(gitStatusPorcelain(cwd)).toBe("A  AGENTS.md");
    });

    it("does NOT stage when opts.stage is omitted", () => {
      initRepo(cwd);

      writeEntriesLocally(cwd, [{ path: "AGENTS.md", kind: "file", contents: "hi\n" }]);

      expect(gitStatusPorcelain(cwd)).toBe("?? AGENTS.md");
    });
  });

  describe("readHostFiles", () => {
    it("local: reads real files", async () => {
      writeFileSync(path.join(cwd, "AGENTS.md"), "hi\n");

      const result = await readHostFiles(fakeApp, "local", cwd, ["AGENTS.md"]);

      expect(result).toEqual({ ok: true, value: { "AGENTS.md": "hi\n" } });
    });

    it("remote: proxies to the remote client's readFiles", async () => {
      const mockReadFiles = vi.fn().mockResolvedValue({ "AGENTS.md": "remote content\n" });
      mockGetRemoteHostClient.mockReturnValue({ readFiles: mockReadFiles });

      const result = await readHostFiles(fakeApp, "remote-host-1", "/remote/cwd", ["AGENTS.md"]);

      expect(mockReadFiles).toHaveBeenCalledWith("/remote/cwd", ["AGENTS.md"]);
      expect(result).toEqual({ ok: true, value: { "AGENTS.md": "remote content\n" } });
    });

    it("remote: an unreachable host maps to reason 'unreachable'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        readFiles: vi.fn().mockRejectedValue(new HostUnreachableError("h1", new Error("timeout"))),
      });

      const result = await readHostFiles(fakeApp, "remote-host-1", "/x", ["AGENTS.md"]);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unreachable");
    });
  });

  describe("writeHostFiles", () => {
    it("local: writes real files", async () => {
      const result = await writeHostFiles(fakeApp, "local", cwd, [
        { path: "AGENTS.md", kind: "file", contents: "hi\n" },
      ]);

      expect(result).toEqual({ ok: true, value: undefined });
      expect(readFileSync(path.join(cwd, "AGENTS.md"), "utf8")).toBe("hi\n");
    });

    it("remote: proxies entries and stage to the remote client's writeFiles", async () => {
      const mockWriteFiles = vi.fn().mockResolvedValue(undefined);
      mockGetRemoteHostClient.mockReturnValue({ writeFiles: mockWriteFiles });
      const entries = [{ path: "AGENTS.md", kind: "file" as const, contents: "hi\n" }];

      const result = await writeHostFiles(fakeApp, "remote-host-1", "/remote/cwd", entries, {
        stage: true,
      });

      expect(mockWriteFiles).toHaveBeenCalledWith("/remote/cwd", entries, true);
      expect(result).toEqual({ ok: true, value: undefined });
    });

    it("remote: an old agent build (404) maps to reason 'unsupported'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        writeFiles: vi.fn().mockRejectedValue(new HostRequestError("h1", 404, "")),
      });

      const result = await writeHostFiles(fakeApp, "remote-host-1", "/x", []);

      expect(result).toEqual({ ok: false, reason: "unsupported" });
    });
  });
});
