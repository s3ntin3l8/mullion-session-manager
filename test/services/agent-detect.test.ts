import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// detectAgents() shells out to `command -v <bin>` once per known binary —
// fake child_process the same way test/services/pty-manager.test.ts fakes
// the systemd-run/dtach bootstrap, so this doesn't depend on which shells/
// agent CLIs happen to be installed on whatever machine runs the suite.

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  return child;
}

// Maps binary name -> resolved path (or undefined = "not found"); the mock
// inspects the invoked `command -v <bin>` string to decide which to reply.
let available: Record<string, string>;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((_shell: string, args: string[]) => {
      const child = makeFakeChild();
      const script = args[args.length - 1] ?? "";
      const match = /command -v (\S+)/.exec(script);
      const bin = match?.[1];
      const resolvedPath = bin ? available[bin] : undefined;

      // Deliberately fires 'exit' BEFORE the stdout 'data' chunk and the
      // later 'close' — the exact real-world race a live E2E run against
      // this repo's actual host caught: probe() must resolve off 'close'
      // (guaranteed to fire only once stdio streams are fully drained),
      // not 'exit' (which only guarantees the process itself has ended).
      // Getting this wrong intermittently reported a genuinely-installed
      // CLI as unavailable under concurrent probing load.
      setImmediate(() => {
        child.emit("exit", 0);
        setImmediate(() => {
          if (resolvedPath) child.stdout.emit("data", Buffer.from(`${resolvedPath}\n`));
          child.emit("close", 0);
        });
      });
      return child;
    }),
  };
});

const { detectAgents, getCachedAgents, clearAgentsCacheForTests } = await import(
  "../../src/services/agent-detect.js"
);

describe("detectAgents", () => {
  it("marks probed binaries available/unavailable based on command -v output", async () => {
    available = { bash: "/bin/bash", claude: "/usr/local/bin/claude" };

    const results = await detectAgents();
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));

    expect(byId["shell:bash"]).toEqual({
      id: "shell:bash",
      title: "bash",
      command: "bash",
      kind: "shell",
      available: true,
      path: "/bin/bash",
    });
    expect(byId["agent:claude"].available).toBe(true);
    expect(byId["agent:claude"].path).toBe("/usr/local/bin/claude");

    expect(byId["shell:zsh"].available).toBe(false);
    expect(byId["shell:zsh"].path).toBeNull();
    expect(byId["agent:codex"].available).toBe(false);
  });

  it("includes both shell and agent kinds across the full known set", async () => {
    available = {};
    const results = await detectAgents();
    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["shell", "agent"]));
    expect(results.every((r) => r.available === false)).toBe(true);
  });
});

describe("getCachedAgents", () => {
  it("only re-probes once the TTL is bypassed via forceRefresh, otherwise reuses the cache", async () => {
    available = {};
    clearAgentsCacheForTests();
    const spawnMock = vi.mocked((await import("node:child_process")).spawn);
    spawnMock.mockClear();

    await getCachedAgents();
    const firstCallCount = spawnMock.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    await getCachedAgents();
    expect(spawnMock.mock.calls.length).toBe(firstCallCount);

    await getCachedAgents(true);
    expect(spawnMock.mock.calls.length).toBe(firstCallCount * 2);
  });
});
