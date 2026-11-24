import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCommand } from "../../src/cli/core.mjs";

// `mullion dock …` (#2494: list/start/stop go through the narrow `docks.*`
// ops; a Docker-discovered control and a raw session id keep the legacy path).

function fakeIo() {
  return {
    stdin: new EventEmitter(),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    written: [] as Buffer[],
    getSize: () => ({ cols: 80, rows: 24 }),
    onResize: () => () => {},
    onInterrupt: () => {},
    setRawMode: vi.fn(),
    env: {},
    gitTarget: (): { repo?: string; branch?: string } => ({}),
  };
}

function fakeClient(overrides: Partial<{ request: unknown }> = {}) {
  return {
    tokenSource: "MULLION_AUTH_TOKEN",
    close: vi.fn(),
    request: vi.fn(async () => ({ ok: true })),
    openStream: vi.fn(),
    ...overrides,
  };
}

describe("mullion dock", () => {
  it("dock list with no project falls back to all dock sessions at full scope (400)", async () => {
    const client = fakeClient({
      request: vi.fn(async (op: string) => {
        if (op === "docks.list")
          throw Object.assign(new Error("projectId required"), { status: 400 });
        return [{ id: 1 }];
      }),
    });
    await runCommand(["dock", "list"], { client, io: fakeIo() });
    expect(client.request).toHaveBeenCalledWith("sessions.list", { kind: "dock" });
  });

  it("dock list requests docks.list (own project in a session, or a named one)", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["dock", "list"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.list", {});
    await runCommand(["dock", "list", "4"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.list", { projectId: "4" });
  });

  it("dock start asks docks.start — a lone id is the caller's own project's control", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["dock", "start", "web"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.start", { dockControlId: "web" });
    await runCommand(["dock", "start", "1", "web", "--branch", "feat/x"], { client, io });
    await runCommand(["dock", "start", "web", "--branch", "feat/y"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.start", {
      dockControlId: "web",
      branch: "feat/y",
    });
    expect(client.request).toHaveBeenCalledWith("docks.start", {
      projectId: "1",
      dockControlId: "web",
      branch: "feat/x",
    });
  });

  it("dock start names a docker-sourced control's session by its stable containerName identity, not its title", async () => {
    // Issue #73 follow-up plan (5b) — mirrors the identical MCP client
    // test/fix; see that test's own comment for why command/title alone
    // isn't a reliable session identity for a docker-sourced control.
    const client = fakeClient({
      request: vi.fn(async (op: string) => {
        if (op === "docks.start") throw Object.assign(new Error("not found"), { status: 404 });
        if (op === "projects.dock") {
          return [
            {
              id: "docker:sanctuary:web",
              title: "web",
              command: "docker compose -p sanctuary logs -f web",
              source: "docker",
              docker: { containerName: "sanctuary-web" },
            },
          ];
        }
        return { id: 10 };
      }),
    });
    const io = fakeIo();
    await runCommand(["dock", "start", "1", "docker:sanctuary:web"], { client, io });
    expect(client.request).toHaveBeenCalledWith("sessions.create", {
      projectId: "1",
      command: "docker compose -p sanctuary logs -f web",
      kind: "dock",
      name: "docker-logs:sanctuary-web",
      nameLocked: true,
    });
  });

  it("dock start and switch carry --host as hostId (#3425)", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["dock", "start", "web", "--host", "mac"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.start", {
      dockControlId: "web",
      hostId: "mac",
    });
    await runCommand(["dock", "start", "1", "web", "--branch", "feat/x", "--host", "mac"], {
      client,
      io,
    });
    expect(client.request).toHaveBeenCalledWith("docks.start", {
      projectId: "1",
      dockControlId: "web",
      branch: "feat/x",
      hostId: "mac",
    });
    await runCommand(["dock", "switch", "web", "feat/z", "--host", "mac"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.switch", {
      dockControlId: "web",
      branch: "feat/z",
      hostId: "mac",
    });
    await runCommand(["dock", "switch", "web", "--worktree", "../wt", "--host", "mac"], {
      client,
      io,
    });
    expect(client.request).toHaveBeenCalledWith("docks.switch", {
      dockControlId: "web",
      worktreePath: "../wt",
      hostId: "mac",
    });
  });

  it("dock start/switch reject a repeated or dangling --host", async () => {
    const client = fakeClient();
    const io = fakeIo();
    expect(
      await runCommand(["dock", "start", "web", "--host", "a", "--host", "b"], { client, io }),
    ).toBe(2);
    expect(await runCommand(["dock", "start", "web", "--host"], { client, io })).toBe(2);
    expect(
      await runCommand(["dock", "start", "web", "--host", "--branch", "x"], { client, io }),
    ).toBe(2);
    expect(await runCommand(["dock", "switch", "web", "b", "--host"], { client, io })).toBe(2);
    expect(
      await runCommand(["dock", "switch", "web", "1", "--host", "a", "--host", "b"], {
        client,
        io,
      }),
    ).toBe(2);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("dock start --host does not fall back to the legacy create path on a 404", async () => {
    const client = fakeClient({
      request: vi.fn(async () => {
        throw Object.assign(new Error("not found"), { status: 404 });
      }),
    });
    await runCommand(["dock", "start", "1", "web", "--host", "mac"], { client, io: fakeIo() });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("docks.start", {
      projectId: "1",
      dockControlId: "web",
      hostId: "mac",
    });
  });

  it("dock start rejects a repeated or dangling --branch", async () => {
    const client = fakeClient();
    const io = fakeIo();
    expect(
      await runCommand(["dock", "start", "web", "--branch", "a", "--branch", "b"], { client, io }),
    ).toBe(2);
    expect(await runCommand(["dock", "start", "web", "--branch"], { client, io })).toBe(2);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("dock start errors clearly when the control id doesn't exist", async () => {
    const client = fakeClient({
      request: vi.fn(async (op: string) => {
        if (op === "docks.start") throw Object.assign(new Error("not found"), { status: 404 });
        return [];
      }),
    });
    const io = fakeIo();
    const code = await runCommand(["dock", "start", "1", "bogus"], { client, io });
    expect(code).toBe(2);
  });

  it("dock stop <project> <control> and --control use docks.stop", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["dock", "stop", "1", "web"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.stop", {
      projectId: "1",
      dockControlId: "web",
    });
    await runCommand(["dock", "stop", "web", "--control"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.stop", { dockControlId: "web" });
  });

  it("dock stop kills the given session", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["dock", "stop", "5"], { client, io });
    expect(client.request).toHaveBeenCalledWith("sessions.kill", { sessionId: "5" });
  });

  it("dock logs and dock switch use docks.logs / docks.switch", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["dock", "logs", "web"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.logs", { dockControlId: "web" });
    await runCommand(["dock", "logs", "2", "web"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.logs", {
      projectId: "2",
      dockControlId: "web",
    });
    await runCommand(["dock", "switch", "web", "feat/x"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.switch", {
      dockControlId: "web",
      branch: "feat/x",
    });
    await runCommand(["dock", "switch", "2", "web", "--worktree", "/p/wt"], { client, io });
    expect(client.request).toHaveBeenCalledWith("docks.switch", {
      projectId: "2",
      dockControlId: "web",
      worktreePath: "/p/wt",
    });
    expect(await runCommand(["dock", "switch", "web"], { client, io })).toBe(2);
  });

  it("dock config get/set use projects.get_dock_config / set_dock_config", async () => {
    const client = fakeClient();
    const io = fakeIo();
    await runCommand(["dock", "config", "get"], { client, io });
    expect(client.request).toHaveBeenCalledWith("projects.get_dock_config", {});
    await runCommand(["dock", "config", "set", "2", "--remove", "dev"], { client, io });
    expect(client.request).toHaveBeenCalledWith("projects.set_dock_config", {
      projectId: "2",
      remove: "dev",
    });
    await runCommand(["dock", "config", "set", "--upsert", '{"id":"a","command":"a"}'], {
      client,
      io,
    });
    expect(client.request).toHaveBeenCalledWith("projects.set_dock_config", {
      upsert: { id: "a", command: "a" },
    });
    expect(await runCommand(["dock", "config", "set", "--upsert", "{nope"], { client, io })).toBe(
      2,
    );
    expect(await runCommand(["dock", "config", "set"], { client, io })).toBe(2);
    // Anything beyond one projectId and one flag is refused, never silently dropped.
    for (const bad of [
      ["config", "set", "2", "--remove", "dev", "--upsert", "{}"],
      ["config", "set", "--remove", "a", "--remove", "b"],
      ["config", "get", "2", "junk"],
      ["config", "get", "--remove", "dev"],
      ["config", "set", "--remove"],
      ["config", "set", "--remove", "--upsert", "{}"],
    ]) {
      expect(await runCommand(["dock", ...bad], { client, io })).toBe(2);
    }
  });
});
