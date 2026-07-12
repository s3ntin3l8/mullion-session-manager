import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  expandHome,
  resolveProjectActions,
  resolveGlobalActions,
  resolveProjectDock,
} from "../../src/services/project-config.js";

// Pure fs-driven service — no PtyManager/fastify involved — so these tests
// just set up real temp dirs (fs.mkdtempSync, same TOCTOU-safe pattern as
// test/plugins/static.test.ts) and assert the merge/precedence behavior.

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

describe("project-config", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  describe("expandHome", () => {
    it("expands a leading ~ to the home dir", () => {
      expect(expandHome("~")).toBe(os.homedir());
      expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
    });

    it("leaves other paths untouched", () => {
      expect(expandHome("/abs/path")).toBe("/abs/path");
      expect(expandHome("relative/path")).toBe("relative/path");
    });
  });

  describe("resolveProjectActions", () => {
    it("returns an empty list for a project with no config sources at all", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      expect(resolveProjectActions(tmpDir)).toEqual([]);
    });

    it("reads package.json scripts as npm-script launchers", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      writeJson(path.join(tmpDir, "package.json"), {
        scripts: { build: "tsc", test: "vitest run" },
      });

      const actions = resolveProjectActions(tmpDir);
      expect(actions).toEqual(
        expect.arrayContaining([
          { id: "npm:build", title: "build", command: "npm run build", kind: "npm-script" },
          { id: "npm:test", title: "test", command: "npm run test", kind: "npm-script" },
        ]),
      );
    });

    it("reads .vscode/tasks.json shell/process tasks, ignoring other types", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      writeJson(path.join(tmpDir, ".vscode", "tasks.json"), {
        version: "2.0.0",
        tasks: [
          { label: "watch", type: "shell", command: "npm", args: ["run", "watch"] },
          { label: "not-a-shell-task", type: "npm", script: "build" },
        ],
      });

      const actions = resolveProjectActions(tmpDir);
      expect(actions).toEqual([
        { id: "task:watch", title: "watch", command: "npm run watch", kind: "task" },
      ]);
    });

    it("merges package.json + tasks.json + .crs/actions.json by default (no override)", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      writeJson(path.join(tmpDir, "package.json"), { scripts: { build: "tsc" } });
      writeJson(path.join(tmpDir, ".crs", "actions.json"), {
        actions: [{ id: "custom:claude", title: "Claude", command: "claude" }],
      });

      const actions = resolveProjectActions(tmpDir);
      const ids = actions.map((a) => a.id).sort();
      expect(ids).toEqual(["custom:claude", "npm:build"]);
    });

    it("lets .crs/actions.json override an auto-read entry by reusing its id", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      writeJson(path.join(tmpDir, "package.json"), { scripts: { build: "tsc" } });
      writeJson(path.join(tmpDir, ".crs", "actions.json"), {
        actions: [{ id: "npm:build", title: "Build (custom)", command: "make build" }],
      });

      const actions = resolveProjectActions(tmpDir);
      expect(actions).toEqual([
        { id: "npm:build", title: "Build (custom)", command: "make build", kind: "custom" },
      ]);
    });

    it("with override: true, ignores package.json/tasks.json entirely", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      writeJson(path.join(tmpDir, "package.json"), { scripts: { build: "tsc" } });
      writeJson(path.join(tmpDir, ".crs", "actions.json"), {
        override: true,
        actions: [{ id: "custom:only", title: "Only this", command: "echo hi" }],
      });

      const actions = resolveProjectActions(tmpDir);
      expect(actions).toEqual([
        { id: "custom:only", title: "Only this", command: "echo hi", kind: "custom" },
      ]);
    });

    it("includes globalPresets underneath project-level sources, overridable by id", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      writeJson(path.join(tmpDir, ".crs", "actions.json"), {
        actions: [{ id: "agent:claude", title: "Claude (custom cwd)", command: "claude --resume" }],
      });

      const globalPresets = [
        { id: "shell:bash", title: "bash", command: "bash", kind: "shell" as const },
        { id: "agent:claude", title: "claude", command: "claude", kind: "agent" as const },
      ];

      const actions = resolveProjectActions(tmpDir, globalPresets);
      const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
      expect(byId["shell:bash"]).toEqual(globalPresets[0]);
      expect(byId["agent:claude"].command).toBe("claude --resume");
    });

    it("skips a malformed .crs/actions.json (invalid JSON) without throwing", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      fs.mkdirSync(path.join(tmpDir, ".crs"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".crs", "actions.json"), "{not valid json");

      expect(() => resolveProjectActions(tmpDir)).not.toThrow();
      expect(resolveProjectActions(tmpDir)).toEqual([]);
    });

    it("skips individual malformed action entries but keeps valid ones", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      writeJson(path.join(tmpDir, ".crs", "actions.json"), {
        actions: [
          { id: "ok", title: "OK", command: "echo ok" },
          { title: "missing id" },
          "not-an-object",
        ],
      });

      const actions = resolveProjectActions(tmpDir);
      expect(actions).toEqual([{ id: "ok", title: "OK", command: "echo ok", kind: "custom" }]);
    });
  });

  describe("resolveGlobalActions", () => {
    it("reads actions.json from the given config dir", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      writeJson(path.join(tmpDir, "actions.json"), {
        actions: [{ id: "g:one", title: "One", command: "one" }],
      });

      expect(resolveGlobalActions(tmpDir)).toEqual([
        { id: "g:one", title: "One", command: "one", kind: "custom" },
      ]);
    });

    it("returns an empty list when the config dir has no actions.json", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      expect(resolveGlobalActions(tmpDir)).toEqual([]);
    });
  });

  describe("resolveProjectDock", () => {
    it("merges global dock.json under repo-level .crs/dock.json, repo wins by id", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-global-"));

      writeJson(path.join(globalDir, "dock.json"), {
        controls: [
          { id: "logs", title: "Global logs", command: "tail -f /var/log/syslog" },
          { id: "shared", title: "Shared", command: "htop" },
        ],
      });
      writeJson(path.join(tmpDir, ".crs", "dock.json"), {
        controls: [{ id: "logs", title: "Project logs", command: "npm run logs" }],
      });

      const controls = resolveProjectDock(tmpDir, globalDir);
      const byId = Object.fromEntries(controls.map((c) => [c.id, c]));
      expect(byId.logs).toEqual({ id: "logs", title: "Project logs", command: "npm run logs" });
      expect(byId.shared.title).toBe("Shared");

      fs.rmSync(globalDir, { recursive: true, force: true });
    });

    it("expands ~ in the global config dir", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-config-test-"));
      // No real ~/.config/crs/dock.json is expected to exist in CI/dev — just
      // confirm this doesn't throw and returns an empty/best-effort result.
      expect(() => resolveProjectDock(tmpDir, "~/.config/crs-nonexistent-test-dir")).not.toThrow();
    });
  });
});
