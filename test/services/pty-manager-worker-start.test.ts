import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNodePtyFactory, mockChildProcessFactory } from "../helpers/task-reconciler-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node-pty", () => mockNodePtyFactory());
vi.mock("node:child_process", (io) => mockChildProcessFactory(io));
const { Session } = await import("../../src/services/pty-manager.js");
const { getScopeBackend } = await import("../../src/services/scope/index.js");
const dirs: string[] = [];
const sessions: InstanceType<typeof Session>[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function session(command: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-worker-start-"));
  dirs.push(dir);
  const s = new Session({
    id: "1",
    cwd: "/tmp/worker-task",
    command,
    socketPath: path.join(dir, "1.sock"),
    cols: 80,
    rows: 24,
    hookSocketPath: path.join(dir, "hooks.sock"),
    controlSocketPath: path.join(dir, "control.sock"),
    sessionsDir: dir,
    scope: getScopeBackend({ sessionsDir: dir, instanceId: "worker-start-test" }),
    env: { CODEX_HOME: path.join(dir, "codex"), CLAUDE_CONFIG_DIR: path.join(dir, "claude") },
  });
  sessions.push(s);
  return { s, dir };
}
describe("worker startup evidence on a real Session", () => {
  it("discovers the session's own Codex home without a hook path", () => {
    const { s, dir } = session("codex");
    expect(s.getTranscriptSource()).toBeNull();
    expect(s.startupTranscriptSearch()).toEqual({
      format: "codex",
      roots: [path.join(dir, "codex", "sessions")],
      cwd: s.cwd,
      since: s.createdAt,
    });
  });
  it("limits Claude discovery to the worker's own project directory", () => {
    const { s, dir } = session("claude");
    expect(s.startupTranscriptSearch()?.roots).toEqual([
      path.join(dir, "claude", "projects", "-tmp-worker-task"),
    ]);
  });
  it("fails open for an unsupported CLI", () => {
    expect(session("bash").s.startupTranscriptSearch()).toBeNull();
  });
  it("records the quoted screen as an ordinary ordered timeline event", () => {
    const { s } = session("codex");
    const note = "Worker has not started a turn.\nTrust these hooks?";
    s.emitTaskStartupNote(note);
    expect(s.getEvents().at(-1)).toMatchObject({
      sessionId: 1,
      kind: "status_change",
      payload: { reason: "worker-not-started", note },
    });
    expect(s.getEvents().at(-1)?.seq).toBeGreaterThan(0);
  });
});
