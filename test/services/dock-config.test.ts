import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
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
} from "../../src/services/dock-config.js";

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
      expect(readDockConfig(projectCwd)).toEqual({ controls: [], invalid: false, reason: null });
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
      expect(readDockConfig(projectCwd)).toEqual({ controls, invalid: false, reason: null });
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
      expect(readDockConfig(projectCwd)).toEqual({ controls: [], invalid: false, reason: null });
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
  });
});
