// The dev backend must not inherit the variables a hosting Mullion session
// injects into its children: MULLION_SOCKET_PATH is also the backend's own
// control-socket setting, so a nested `npm run dev` (the dock's "Dev server")
// otherwise tries to bind the hosting Mullion's live socket.
import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { SERVER_ENV_KEYS } from "../../src/services/session-env.js";
import { SESSION_RUNTIME_ENV_KEYS } from "../helpers/session-runtime-env.js";
import {
  SESSION_INJECTED_ENV_KEYS,
  devBackendEnv,
  startDevBackend,
} from "../../scripts/dev-backend.mjs";

describe("dev-backend.mjs", () => {
  it("removes the variables a hosting session injects", () => {
    const base: Record<string, string> = {
      PATH: "/usr/bin",
      PORT: "3450",
      MULLION_SOCKET_PATH: "/live/mullion.sock",
      MULLION_HOOK_SOCKET: "/live/hooks.sock",
      MULLION_HOOK_TOKEN: "secret",
      MULLION_SESSION_ID: "2301",
      MULLION_FORWARDER_PATH: "/live/forwarder.mjs",
    };
    const env = devBackendEnv(base);
    for (const key of SESSION_INJECTED_ENV_KEYS) expect(env).not.toHaveProperty(key);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PORT).toBe("3450");
  });

  it("does not modify the environment it was given", () => {
    const base = { MULLION_SOCKET_PATH: "/live/mullion.sock" };
    devBackendEnv(base);
    expect(base.MULLION_SOCKET_PATH).toBe("/live/mullion.sock");
  });

  it("lists every injected key and no others, so the two lists cannot drift either way", () => {
    // test/helpers/session-runtime-env.ts is the per-session set that is not an
    // env-schema key; MULLION_SOCKET_PATH is the one schema key a session re-injects.
    expect([...SESSION_INJECTED_ENV_KEYS].sort()).toEqual(
      [...SESSION_RUNTIME_ENV_KEYS, "MULLION_SOCKET_PATH"].sort(),
    );
    for (const key of SESSION_INJECTED_ENV_KEYS) expect(SERVER_ENV_KEYS).toContain(key);
  });
});

describe("startDevBackend", () => {
  const setup = (
    env: Record<string, string> = { PORT: "3450", MULLION_SOCKET_PATH: "/live.sock" },
  ) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawnFn = vi.fn(() => child);
    const proc = Object.assign(new EventEmitter(), { execPath: "/node", exit: vi.fn() });
    startDevBackend({ spawnFn: spawnFn as never, proc: proc as never, env, root: "/repo" });
    return { child, spawnFn, proc };
  };

  it("runs tsx watch on the server from the repo root with the injected variables removed", () => {
    const { spawnFn } = setup();
    const [cmd, args, opts] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string>; stdio: string },
    ];
    expect(cmd).toBe("/node");
    expect(args.slice(1)).toEqual(["watch", "src/server.ts"]);
    expect(args[0]).toMatch(/tsx[\\/]dist[\\/]cli\.mjs$/);
    expect(opts.cwd).toBe("/repo");
    expect(opts.stdio).toBe("inherit");
    expect(opts.env).not.toHaveProperty("MULLION_SOCKET_PATH");
    expect(opts.env.PORT).toBe("3450");
  });

  it("passes the child's exit code through", () => {
    const { child, proc } = setup();
    child.emit("exit", 7, null);
    expect(proc.exit).toHaveBeenCalledWith(7);
  });

  it("exits with the shell's code when the child dies on a signal (130 for SIGINT)", () => {
    const { child, proc } = setup();
    child.emit("exit", null, "SIGINT");
    expect(proc.exit).toHaveBeenCalledWith(130);
  });

  it("forwards a signal to the child, and force-kills it on the second one", () => {
    const { child, proc } = setup();
    proc.emit("SIGINT");
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    expect(proc.exit).not.toHaveBeenCalled();
    proc.emit("SIGINT");
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(proc.exit).toHaveBeenCalledWith(130);
  });
});
