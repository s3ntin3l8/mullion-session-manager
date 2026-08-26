import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readDockConfig,
  writeDockConfig,
  validateDockConfig,
  DockConfigValidationError,
  DockConfigTooLargeError,
  DockConfigSymlinkError,
  MAX_DOCK_CONFIG_BYTES,
  __testing,
} from "../../src/services/dock-config.js";

const { resolveDockConfigPath } = __testing;

describe("dock-config service", () => {
  let projectCwd: string;

  beforeEach(() => {
    projectCwd = mkdtempSync(path.join(os.tmpdir(), "mullion-dock-config-project-"));
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
  });

  describe("validateDockConfig", () => {
    it("accepts a minimal valid control", () => {
      const controls = validateDockConfig({
        controls: [{ id: "dev-server", title: "Dev server", command: "make dev" }],
      });
      expect(controls).toEqual([{ id: "dev-server", title: "Dev server", command: "make dev" }]);
    });

    it("accepts every optional field", () => {
      const controls = validateDockConfig({
        controls: [
          {
            id: "dev-server",
            title: "Dev server",
            command: "npm run dev",
            cwd: "packages/frontend",
            height: 300,
            env: { NODE_ENV: "development" },
            worktreeRefresh: true,
          },
        ],
      });
      expect(controls[0]).toEqual({
        id: "dev-server",
        title: "Dev server",
        command: "npm run dev",
        cwd: "packages/frontend",
        height: 300,
        env: { NODE_ENV: "development" },
        worktreeRefresh: true,
      });
    });

    it("rejects a non-object payload", () => {
      expect(() => validateDockConfig([])).toThrow(DockConfigValidationError);
      expect(() => validateDockConfig("nope")).toThrow(DockConfigValidationError);
      expect(() => validateDockConfig(null)).toThrow(DockConfigValidationError);
    });

    it("rejects a payload whose controls field isn't an array", () => {
      expect(() => validateDockConfig({ controls: "nope" })).toThrow(DockConfigValidationError);
    });

    it.each(["id", "title", "command"])("rejects a control missing %s", (field) => {
      const control: Record<string, unknown> = {
        id: "x",
        title: "X",
        command: "echo x",
      };
      delete control[field];
      expect(() => validateDockConfig({ controls: [control] })).toThrow(
        new RegExp(`controls\\[0\\]\\.${field}`),
      );
    });

    it("rejects an empty-string id/title/command", () => {
      expect(() =>
        validateDockConfig({ controls: [{ id: "", title: "X", command: "echo x" }] }),
      ).toThrow(/controls\[0\]\.id/);
    });

    it("rejects a non-positive-integer height", () => {
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", height: 0 }],
        }),
      ).toThrow(/height must be a positive integer/);
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", height: 1.5 }],
        }),
      ).toThrow(/height must be a positive integer/);
    });

    it("rejects a non-string env value", () => {
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", env: { PORT: 3000 } }],
        }),
      ).toThrow(/env\.PORT must be a string/);
    });

    it("rejects a non-object env", () => {
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", env: "nope" }],
        }),
      ).toThrow(/env must be an object/);
    });

    // Issue #822 — a dock control's env is applied before every
    // Mullion-owned env write, so it can never actually override one of
    // these; reject at write time rather than silently doing nothing.
    it.each([
      ["a MULLION_-prefixed key", "MULLION_AUTH_TOKEN"],
      ["SSH_AUTH_SOCK", "SSH_AUTH_SOCK"],
      ["an empty key", ""],
      ["a key with an invalid character", "FOO-BAR"],
      ["a key starting with a digit", "1FOO"],
    ])("rejects %s as a reserved/invalid env key", (_label, key) => {
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", env: { [key]: "value" } }],
        }),
      ).toThrow(/reserved key/);
    });

    it("accepts an ordinary env key", () => {
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", env: { NODE_ENV: "development" } }],
        }),
      ).not.toThrow();
    });

    it("rejects a non-string cwd", () => {
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", cwd: 42 }],
        }),
      ).toThrow(/cwd must be a string/);
    });

    it("rejects a non-boolean worktreeRefresh", () => {
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", worktreeRefresh: "yes" }],
        }),
      ).toThrow(/worktreeRefresh must be a boolean/);
    });

    it("rejects a non-array raw entry (e.g. an array passed as a control)", () => {
      expect(() => validateDockConfig({ controls: [[]] })).toThrow(
        /controls\[0\] must be an object/,
      );
    });

    // project-config.ts's normalizeRawControl deliberately never reads
    // `source`/`docker` so a project's own dock.json "literally cannot set
    // them" — the write path must preserve that invariant by rejecting the
    // fields outright rather than silently stripping them.
    it("rejects an unknown field, including the docker-discovery-only source/docker fields", () => {
      expect(() =>
        validateDockConfig({
          controls: [{ id: "x", title: "X", command: "echo x", source: "docker" }],
        }),
      ).toThrow(/unknown field "source"/);
    });

    it("rejects duplicate ids", () => {
      expect(() =>
        validateDockConfig({
          controls: [
            { id: "dup", title: "A", command: "echo a" },
            { id: "dup", title: "B", command: "echo b" },
          ],
        }),
      ).toThrow(/duplicate control id "dup"/);
    });
  });

  describe("readDockConfig", () => {
    it("returns an empty, valid result when .crs/dock.json doesn't exist", () => {
      expect(readDockConfig(projectCwd)).toEqual({
        controls: [],
        invalid: false,
        reason: null,
        isSymlink: false,
      });
    });

    it("reads back an existing valid file", () => {
      mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      writeFileSync(
        path.join(projectCwd, ".crs", "dock.json"),
        JSON.stringify({ controls: [{ id: "logs", title: "Logs", command: "tail -f log" }] }),
      );
      const result = readDockConfig(projectCwd);
      expect(result.invalid).toBe(false);
      expect(result.controls).toEqual([{ id: "logs", title: "Logs", command: "tail -f log" }]);
    });

    it("reports invalid:true with a reason for unparseable JSON, without throwing", () => {
      mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      writeFileSync(path.join(projectCwd, ".crs", "dock.json"), "{ not json");
      const result = readDockConfig(projectCwd);
      expect(result.invalid).toBe(true);
      expect(result.controls).toEqual([]);
      expect(result.reason).toMatch(/Not valid JSON/);
    });

    it("reports invalid:true with a reason for JSON that doesn't validate", () => {
      mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      writeFileSync(
        path.join(projectCwd, ".crs", "dock.json"),
        JSON.stringify({ controls: [{ id: "x" }] }),
      );
      const result = readDockConfig(projectCwd);
      expect(result.invalid).toBe(true);
      expect(result.reason).toMatch(/title/);
    });

    // Hermes fresh-review nit on PR #586 — this module previously had no
    // isSymlink equivalent to agent-rules.ts's own AgentRuleTarget field,
    // so a symlinked dock.json loaded as a normal, editable config and
    // only failed on Save (DockConfigSymlinkError). content/controls is
    // still populated (informational, following the symlink), same as
    // agent-rules.ts's own statTarget.
    it("reports isSymlink:true for a symlinked dock.json, while still reading its (real) content", () => {
      mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      const outside = mkdtempSync(path.join(os.tmpdir(), "mullion-dock-config-symlink-target-"));
      writeFileSync(
        path.join(outside, "dock.json"),
        JSON.stringify({ controls: [{ id: "x", title: "X", command: "echo x" }] }),
      );
      symlinkSync(path.join(outside, "dock.json"), path.join(projectCwd, ".crs", "dock.json"));
      try {
        const result = readDockConfig(projectCwd);
        expect(result.isSymlink).toBe(true);
        expect(result.invalid).toBe(false);
        expect(result.controls).toEqual([{ id: "x", title: "X", command: "echo x" }]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    // The dangling-symlink case agent-rules.ts's own statTarget documents:
    // existsSync follows the link and reports ENOENT for the missing
    // target, but lstat (used for isSymlink) still sees the link itself.
    it("reports isSymlink:true even for a DANGLING symlink, which existsSync alone would call 'doesn't exist'", () => {
      mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      symlinkSync(
        path.join(projectCwd, ".crs", "nowhere.json"),
        path.join(projectCwd, ".crs", "dock.json"),
      );
      const result = readDockConfig(projectCwd);
      expect(result.isSymlink).toBe(true);
      expect(result.controls).toEqual([]);
      expect(result.invalid).toBe(false);
    });

    it("reports isSymlink:false for an ordinary file", () => {
      writeDockConfig(projectCwd, [{ id: "x", title: "X", command: "echo x" }]);
      expect(readDockConfig(projectCwd).isSymlink).toBe(false);
    });
  });

  describe("writeDockConfig", () => {
    it("creates .crs/ and writes a pretty-printed dock.json", () => {
      writeDockConfig(projectCwd, [{ id: "dev-server", title: "Dev server", command: "make dev" }]);
      const written = readFileSync(path.join(projectCwd, ".crs", "dock.json"), "utf8");
      expect(written).toContain("\n");
      expect(JSON.parse(written)).toEqual({
        controls: [{ id: "dev-server", title: "Dev server", command: "make dev" }],
      });
    });

    it("round-trips through readDockConfig", () => {
      const controls = [{ id: "logs", title: "Logs", command: "tail -f log", height: 200 }];
      writeDockConfig(projectCwd, controls);
      expect(readDockConfig(projectCwd)).toEqual({
        controls,
        invalid: false,
        reason: null,
        isSymlink: false,
      });
    });

    it("overwrites an existing file", () => {
      writeDockConfig(projectCwd, [{ id: "a", title: "A", command: "echo a" }]);
      writeDockConfig(projectCwd, [{ id: "b", title: "B", command: "echo b" }]);
      expect(readDockConfig(projectCwd).controls).toEqual([
        { id: "b", title: "B", command: "echo b" },
      ]);
    });

    it("throws DockConfigTooLargeError and never writes when content exceeds the byte cap", () => {
      const huge = [{ id: "x", title: "X", command: "echo " + "x".repeat(MAX_DOCK_CONFIG_BYTES) }];
      expect(() => writeDockConfig(projectCwd, huge)).toThrow(DockConfigTooLargeError);
      expect(readDockConfig(projectCwd)).toEqual({
        controls: [],
        invalid: false,
        reason: null,
        isSymlink: false,
      });
    });

    // Mirrors agent-rules.ts's own symlink-refusal test — writeFileSync's
    // default flags follow a symlink at the destination and overwrite
    // whatever it points to; O_NOFOLLOW turns that into a catchable error.
    it("refuses to write through a symlink at the destination path", () => {
      mkdirSync(path.join(projectCwd, ".crs"), { recursive: true });
      const outside = mkdtempSync(path.join(os.tmpdir(), "mullion-dock-config-outside-"));
      const outsideTarget = path.join(outside, "dock.json");
      writeFileSync(outsideTarget, "{}");
      symlinkSync(outsideTarget, path.join(projectCwd, ".crs", "dock.json"));
      try {
        expect(() =>
          writeDockConfig(projectCwd, [{ id: "x", title: "X", command: "echo x" }]),
        ).toThrow(DockConfigSymlinkError);
        expect(readFileSync(outsideTarget, "utf8")).toBe("{}");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    // Issue #605 — O_NOFOLLOW on the destination-path test above only
    // protects dock.json's own leaf component. This is the OTHER half: a
    // symlinked `.crs/` itself, the one intermediate directory writeDockConfig
    // creates. Before this fix, mkdirSync(dockDir, {recursive:true}) treated
    // the symlink-to-a-real-directory as "already exists" and silently
    // walked through it, then the O_NOFOLLOW open below happily wrote
    // dock.json into wherever `.crs` actually pointed.
    it("refuses to write through a symlinked .crs/ directory, without creating anything at the real target", () => {
      const outside = mkdtempSync(path.join(os.tmpdir(), "mullion-dock-config-outside-dir-"));
      symlinkSync(outside, path.join(projectCwd, ".crs"));
      try {
        expect(() =>
          writeDockConfig(projectCwd, [{ id: "x", title: "X", command: "echo x" }]),
        ).toThrow(DockConfigSymlinkError);
        expect(existsSync(path.join(outside, "dock.json"))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    // A dangling `.crs/` symlink (target doesn't exist) must be refused the
    // same way — isSymlinkPath (lstat-based) doesn't care whether the link
    // resolves, only that it's an existing directory ENTRY that's a symlink.
    it("refuses to write through a DANGLING symlinked .crs/ directory", () => {
      symlinkSync(path.join(projectCwd, "nonexistent-target"), path.join(projectCwd, ".crs"));
      expect(() =>
        writeDockConfig(projectCwd, [{ id: "x", title: "X", command: "echo x" }]),
      ).toThrow(DockConfigSymlinkError);
    });
  });

  // GitHub Advanced Security's CodeQL flagged every fs sink in this file
  // (existsSync/readFileSync/mkdirSync/openSync) as js/path-injection —
  // "this path depends on a user-provided value" — since `cwd` genuinely
  // does trace back to request input at both call sites (project.cwd,
  // stored from a POST/PATCH /api/projects body; the internal route's own
  // `cwd` query param). resolveDockConfigPath is the real containment gate
  // for that value (mirroring git-worktree.ts/git-branch-delete.ts's own
  // isSafeAbsolutePath-gated calls, which document this identical query
  // re-flagging a real, manually-verified guard it doesn't recognize as a
  // sanitizer shape) — these tests exercise it directly, independent of
  // and in addition to the route-layer resolveWithinRoots check
  // (test/routes/internal.test.ts's own "/internal/dock-config" describe
  // block) that already gates `cwd` before either route ever calls in
  // here.
  describe("resolveDockConfigPath (path-safety guard, CodeQL: uncontrolled data in path expression)", () => {
    it("resolves an ordinary absolute cwd to exactly <cwd>/.crs/dock.json", () => {
      expect(resolveDockConfigPath(projectCwd)).toBe(path.join(projectCwd, ".crs", "dock.json"));
    });

    // node's path.resolve() (called first, inside resolveDockConfigPath)
    // collapses "../" segments and makes the result absolute BEFORE
    // isSafeAbsolutePath ever runs — so a traversal attempt riding on an
    // otherwise-legitimate cwd resolves to a normal, contained path rather
    // than escaping it. This is the same structural guarantee
    // isSafeAbsolutePath's sibling copies in git-ignore.ts/git-worktree.ts
    // rely on: given that guarantee, isSafeAbsolutePath's own throw branch
    // is unreachable through path.resolve()'s output for ANY string input
    // (it can never fail to be absolute, and it can never still contain a
    // literal ".." segment) — which is exactly why none of those sibling
    // copies carry a dedicated test for their own throw branch either. What
    // this test proves instead is the property that actually matters: the
    // traversal doesn't escape.
    it("collapses a traversal attempt via path.resolve rather than escaping the project directory", () => {
      const nested = path.join(projectCwd, "sub");
      mkdirSync(nested);
      const traversal = path.join(nested, "..", "..", path.basename(projectCwd));
      expect(resolveDockConfigPath(traversal)).toBe(path.join(projectCwd, ".crs", "dock.json"));
    });

    // A relative cwd is likewise made absolute (against process.cwd()) by
    // path.resolve() rather than rejected outright — every real caller
    // (routes/dock-config.ts's project.cwd, routes/internal.ts's
    // resolveWithinRoots) already only ever passes an absolute path in, so
    // this documents the function's actual behavior on that input rather
    // than asserting a rejection this function was never designed to do.
    it("resolves a relative cwd against process.cwd() rather than throwing", () => {
      expect(() => resolveDockConfigPath("some/relative/path")).not.toThrow();
      expect(resolveDockConfigPath("some/relative/path")).toBe(
        path.resolve("some/relative/path", ".crs", "dock.json"),
      );
    });
  });
});
