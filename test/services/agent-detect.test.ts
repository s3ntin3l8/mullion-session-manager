import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// detectAgents() shells out to `command -v <bin>` once per known binary —
// fake child_process the same way test/services/pty-manager.test.ts fakes
// the systemd-run/dtach bootstrap, so this doesn't depend on which shells/
// agent CLIs happen to be installed on whatever machine runs the suite.

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  exitCode: number | null;
  signalCode: string | null;
  killSpy: ReturnType<typeof vi.fn>;
  kill: (signal?: string) => void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killSpy = vi.fn();
  child.kill = (signal?: string) => {
    child.killSpy(signal);
  };
  return child;
}

// Maps binary name -> resolved path (or undefined = "not found"); the mock
// inspects the invoked `command -v <bin>` string to decide which to reply.
let available: Record<string, string>;

// B7 — bins in this set never emit exit/data/close at all, modeling a login
// shell blocked forever on an unread stderr write; `hungChildren` captures
// the fake child spawned for each so the timeout test below can assert on
// it directly (kill escalation, listener detachment).
let hangBins: Set<string> = new Set();
const hungChildren = new Map<string, FakeChild>();
let lastSpawnOpts: { stdio?: unknown } | undefined;

// getCodexHookTrust() reads the REAL ~/.codex (unless CODEX_HOME is set) —
// mocked here for the same reason child_process is faked above: detectAgents
// must not depend on whatever Codex hook-trust state happens to exist on the
// machine running the suite. See test/services/hook-adapters/codex-trust.test.ts
// for that function's own dedicated, filesystem-driven tests.
let codexHookTrust: "trusted" | "pending" | "not-installed" = "not-installed";
vi.mock("../../src/services/hook-adapters/codex-trust.js", () => ({
  getCodexHookTrust: () => codexHookTrust,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((_shell: string, args: string[], opts?: { stdio?: unknown }) => {
      const child = makeFakeChild();
      lastSpawnOpts = opts;
      const script = args[args.length - 1] ?? "";
      const match = /command -v (\S+)/.exec(script);
      const bin = match?.[1];

      if (bin && hangBins.has(bin)) {
        // B7 — deliberately never emits exit/data/close, modeling a login
        // shell blocked on a write() syscall to an unread stderr pipe.
        hungChildren.set(bin, child);
        return child;
      }

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

const { detectAgents, getCachedAgents, clearAgentsCacheForTests } =
  await import("../../src/services/agent-detect.js");

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
      // Rich statuses (issue: extend surfaced session statuses) — a shell
      // has no hook adapter at all.
      emits: [],
    });
    expect(byId["agent:claude"].available).toBe(true);
    expect(byId["agent:claude"].path).toBe("/usr/local/bin/claude");

    expect(byId["shell:zsh"].available).toBe(false);
    expect(byId["shell:zsh"].path).toBeNull();
    expect(byId["agent:codex"].available).toBe(false);
  });

  it("reports each agent's hook capability list, empty for binaries with no adapter", async () => {
    const results = await detectAgents();
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));

    expect(byId["agent:claude"].emits).toContain("permission_request");
    expect(byId["agent:claude"].emits).toContain("turn_start");
    expect(byId["agent:codex"].emits).toContain("turn_start");
    expect(byId["agent:opencode"].emits).toContain("permission_request");
    expect(byId["agent:agy"].emits).toContain("file_change");
    // No hook adapter at all for these three — always an empty capability
    // list, regardless of whether the binary is actually installed.
    expect(byId["agent:aider"].emits).toEqual([]);
    expect(byId["agent:gemini"].emits).toEqual([]);
    expect(byId["agent:pi"].emits).toEqual([]);
  });

  it("includes both shell and agent kinds across the full known set", async () => {
    available = {};
    const results = await detectAgents();
    const kinds = new Set(results.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["shell", "agent"]));
    expect(results.every((r) => r.available === false)).toBe(true);
  });

  it("attaches Codex's hookTrust status only to the codex agent (issue #259)", async () => {
    available = {};
    codexHookTrust = "pending";
    const results = await detectAgents();
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));

    expect(byId["agent:codex"].hookTrust).toBe("pending");
    expect(byId["agent:claude"].hookTrust).toBeUndefined();
    expect(byId["shell:bash"].hookTrust).toBeUndefined();

    codexHookTrust = "not-installed"; // reset for tests below
  });
});

describe("probe() timeout (B7)", () => {
  it("spawns with stdio: ['ignore','pipe','ignore'] so stderr is never left as an unread pipe", async () => {
    available = { bash: "/bin/bash" };
    hangBins = new Set();
    await detectAgents();
    expect(lastSpawnOpts?.stdio).toEqual(["ignore", "pipe", "ignore"]);
  });

  it("settles within the timeout instead of hanging forever when a shell blocks on an unread stderr write", async () => {
    available = {};
    hangBins = new Set(["bash"]);
    hungChildren.clear();
    vi.useFakeTimers();
    try {
      const resultPromise = detectAgents();

      // The hung child never emits 'close' on its own — only advancing past
      // PROBE_TIMEOUT_MS should let this resolve at all.
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await resultPromise;

      const bash = results.find((r) => r.id === "shell:bash");
      expect(bash?.available).toBe(false);
      expect(bash?.path).toBeNull();

      const hungChild = hungChildren.get("bash");
      expect(hungChild).toBeDefined();
      expect(hungChild!.killSpy).toHaveBeenCalledTimes(1);
      expect(hungChild!.killSpy).not.toHaveBeenCalledWith("SIGKILL");
      expect(hungChild!.stdout.listenerCount("data")).toBe(0);

      // Escalates to SIGKILL if still "alive" (exitCode/signalCode both
      // null, same as a real process that ignored SIGTERM) after the grace
      // period.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(hungChild!.killSpy).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
      hangBins = new Set();
      hungChildren.clear();
    }
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
