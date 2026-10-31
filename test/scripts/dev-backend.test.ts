// The dev backend must not inherit the variables a hosting Mullion session
// injects into its children: MULLION_SOCKET_PATH is also the backend's own
// control-socket setting, so a nested `npm run dev` (the dock's "Dev server")
// otherwise tries to bind the hosting Mullion's live socket.
import { describe, it, expect } from "vitest";
import { SERVER_ENV_KEYS } from "../../src/services/session-env.js";
import { SESSION_INJECTED_ENV_KEYS, devBackendEnv } from "../../scripts/dev-backend.mjs";

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

  it("only lists keys the session env scrub knows about, so the two lists cannot drift", () => {
    for (const key of SESSION_INJECTED_ENV_KEYS) expect(SERVER_ENV_KEYS).toContain(key);
  });
});
