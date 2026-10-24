import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { closeDb } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `agents-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

// Fake at the true I/O boundary (child_process), same convention as
// test/services/agent-detect.test.ts and test/services/pty-manager.test.ts
// — mocking a sibling export within agent-detect.ts itself wouldn't work
// here since getCachedAgents() calls detectAgents() as a same-module local
// binding, which ESM mocking can't intercept.
let probeCount = 0;
// Same reason as test/services/agent-detect.test.ts's mock of this module —
// getCodexHookTrust() reads the real ~/.codex otherwise, which would make
// this route's response depend on whatever machine runs the suite.
vi.mock("../../src/services/hook-adapters/codex-trust.js", () => ({
  getCodexHookTrust: () => "pending" as const,
}));

// resolveUserShellEnv() would spawn one extra (interactive) shell through the
// faked child_process and skew probeCount — it has its own test file.
vi.mock("../../src/services/user-shell-env.js", () => ({
  resolveUserShellEnv: () => Promise.resolve(),
  invalidateUserShellEnv: () => {},
  getUserShellPath: () => null,
  mergePaths: (base: string | undefined) => base ?? "",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      probeCount++;
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EventEmitter();
      // probe() resolves off 'close', not 'exit' — see agent-detect.ts.
      setImmediate(() => {
        child.emit("exit", 0);
        child.emit("close", 0);
      });
      return child;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");

const KNOWN_BINARY_COUNT = 11; // 3 shells + 8 agents, see agent-detect.ts

describe("agents route", () => {
  beforeEach(() => {
    probeCount = 0;
    clearAgentsCacheForTests();
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("returns a detection result per known shell/agent binary", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(KNOWN_BINARY_COUNT);
    expect(res.json().every((a: { available: boolean }) => a.available === false)).toBe(true);
    expect(probeCount).toBe(KNOWN_BINARY_COUNT);

    await app.close();
  });

  it("surfaces Codex's hookTrust status on the codex entry only (issue #259)", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/agents" });
    const byId = Object.fromEntries(
      (res.json() as Array<{ id: string; hookTrust?: string }>).map((a) => [a.id, a]),
    );
    expect(byId["agent:codex"].hookTrust).toBe("pending");
    expect(byId["agent:claude"].hookTrust).toBeUndefined();
    expect(byId["shell:bash"].hookTrust).toBeUndefined();

    await app.close();
  });

  it("caches the result across requests within the TTL", async () => {
    const app = await buildApp();

    await app.inject({ method: "GET", url: "/api/agents" });
    await app.inject({ method: "GET", url: "/api/agents" });
    expect(probeCount).toBe(KNOWN_BINARY_COUNT);

    await app.close();
  });

  it("bypasses the cache with ?refresh=1", async () => {
    const app = await buildApp();

    await app.inject({ method: "GET", url: "/api/agents" });
    await app.inject({ method: "GET", url: "/api/agents?refresh=1" });
    expect(probeCount).toBe(KNOWN_BINARY_COUNT * 2);

    await app.close();
  });
});
