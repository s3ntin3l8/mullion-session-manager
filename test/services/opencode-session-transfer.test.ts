import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Issue #271 follow-up. `opencode` is NOT installed in CI (unlike `git`,
// which every other subprocess-wrapping *.test.ts in this sibling group
// spawns for real) — every test here runs against a fully controlled fake
// child_process, same approach as test/services/git-kill-escalation.test.ts,
// rather than the real binary. The id-rewrite logic (rewriteSessionIds) is
// exported and unit-tested directly against a fixture shaped like opencode
// v2's `opencode session export` payload (`{ info, messages }` with FLAT
// messages — assistant content lives inline, there are no per-message
// `parts` arrays as in 1.x; see opencode-session-transfer.ts's header).

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killSpy = vi.fn();

  kill(signal?: string) {
    this.killSpy(signal);
  }
}

let spawnQueue: FakeChild[];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => spawnQueue.shift() ?? new FakeChild()),
  };
});

const { transferOpencodeSession, rewriteSessionIds } =
  await import("../../src/services/opencode-session-transfer.js");

beforeEach(() => {
  spawnQueue = [];
});

// A minimal fixture shaped like v2's `SessionTransfer.Data` — one session,
// two flat messages carrying their own id (+ a sessionID cross-reference).
const EXPORT_FIXTURE = {
  info: {
    id: "ses_ff7c7aa42ffeR8htL6o3tdEqhl",
    slug: "gentle-planet",
    directory: "/scratch/source-repo",
    title: "New session",
  },
  messages: [
    {
      id: "msg_0083857590015ySjnn7VuIJAM6",
      sessionID: "ses_ff7c7aa42ffeR8htL6o3tdEqhl",
      type: "user",
    },
    {
      id: "msg_00838576f001FYZbKwMmPQPHHS",
      sessionID: "ses_ff7c7aa42ffeR8htL6o3tdEqhl",
      type: "assistant",
    },
  ],
};

describe("rewriteSessionIds (issue #271 follow-up)", () => {
  it("rewrites the session id, keeping the 12-char prefix and changing the rest", () => {
    const result = rewriteSessionIds(EXPORT_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.newSessionId).not.toBe(EXPORT_FIXTURE.info.id);
    expect(result!.newSessionId.startsWith("ses_ff7c7aa42ffe")).toBe(true);
    expect(result!.newSessionId.length).toBe(EXPORT_FIXTURE.info.id.length);
  });

  it("remaps every message id and its sessionID reference to the new session id", () => {
    const result = rewriteSessionIds(EXPORT_FIXTURE) as {
      payload: { messages: Array<{ id: string; sessionID: string }> };
      newSessionId: string;
    };
    const [first, second] = result.payload.messages;
    expect(first!.id).not.toBe(EXPORT_FIXTURE.messages[0]!.id);
    expect(second!.id).not.toBe(EXPORT_FIXTURE.messages[1]!.id);
    expect(first!.id).not.toBe(second!.id);
    // v2's importer returns 409 on an existing id rather than upserting, so a
    // message must never keep its source id.
    expect(first!.id.startsWith("msg_")).toBe(true);
    expect(first!.sessionID).toBe(result.newSessionId);
    expect(second!.sessionID).toBe(result.newSessionId);
  });

  it("leaves a message without a usable id untouched", () => {
    const result = rewriteSessionIds({
      info: { id: "ses_x_1234567890abcdef" },
      messages: [{ type: "user" }, "junk", { id: "" }],
    }) as { payload: { messages: unknown[] } };
    expect(result.payload.messages).toEqual([{ type: "user" }, "junk", { id: "" }]);
  });

  it("returns null for a payload missing a usable info.id", () => {
    expect(rewriteSessionIds({ info: {}, messages: [] })).toBeNull();
    expect(rewriteSessionIds({ messages: [] })).toBeNull();
    expect(rewriteSessionIds(null)).toBeNull();
    expect(rewriteSessionIds("not an object")).toBeNull();
  });

  it("returns null when messages isn't an array", () => {
    expect(rewriteSessionIds({ info: { id: "ses_x" } })).toBeNull();
  });
});

describe("transferOpencodeSession (issue #271 follow-up)", () => {
  it("rejects a non-absolute sourceCwd/targetCwd without spawning anything", async () => {
    const spawnMock = (await import("node:child_process")).spawn as unknown as ReturnType<
      typeof vi.fn
    >;
    spawnMock.mockClear();
    const result = await transferOpencodeSession({
      sourceCwd: "relative/path",
      agentSessionId: "ses_x",
      targetCwd: "/abs/target",
    });
    expect(result).toEqual({
      transferred: false,
      reason: "sourceCwd/targetCwd must be absolute paths",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects an agentSessionId that could be reinterpreted as a flag", async () => {
    const result = await transferOpencodeSession({
      sourceCwd: "/abs/source",
      agentSessionId: "--force",
      targetCwd: "/abs/target",
    });
    expect(result).toEqual({ transferred: false, reason: "invalid agentSessionId" });
  });

  it("returns transferred:false with a short reason when export exits non-zero", async () => {
    const exportChild = new FakeChild();
    spawnQueue = [exportChild];

    const resultPromise = transferOpencodeSession({
      sourceCwd: "/abs/source",
      agentSessionId: "ses_x",
      targetCwd: "/abs/target",
    });
    exportChild.stderr.emit("data", Buffer.from("session not found: ses_x"));
    exportChild.exitCode = 1;
    exportChild.emit("close", 1);

    const result = await resultPromise;
    expect(result.transferred).toBe(false);
    expect(result.reason).toMatch(/opencode session export failed/);
    expect(result.reason).toMatch(/session not found/);
  });

  it("returns transferred:false when export's stdout isn't valid JSON", async () => {
    const exportChild = new FakeChild();
    spawnQueue = [exportChild];

    const resultPromise = transferOpencodeSession({
      sourceCwd: "/abs/source",
      agentSessionId: "ses_x",
      targetCwd: "/abs/target",
    });
    exportChild.stdout.emit("data", Buffer.from("not json"));
    exportChild.exitCode = 0;
    exportChild.emit("close", 0);

    const result = await resultPromise;
    expect(result).toEqual({
      transferred: false,
      reason: "opencode session export produced unparseable JSON",
    });
  });

  it("returns transferred:false when the export payload has an unrecognized shape", async () => {
    const exportChild = new FakeChild();
    spawnQueue = [exportChild];

    const resultPromise = transferOpencodeSession({
      sourceCwd: "/abs/source",
      agentSessionId: "ses_x",
      targetCwd: "/abs/target",
    });
    exportChild.stdout.emit("data", Buffer.from(JSON.stringify({ nope: true })));
    exportChild.exitCode = 0;
    exportChild.emit("close", 0);

    const result = await resultPromise;
    expect(result).toEqual({
      transferred: false,
      reason: "opencode session export payload had an unrecognized shape",
    });
  });

  it("returns transferred:true with the rewritten session id on a successful export + import round trip", async () => {
    const exportChild = new FakeChild();
    const importChild = new FakeChild();
    spawnQueue = [exportChild, importChild];

    const resultPromise = transferOpencodeSession({
      sourceCwd: "/abs/source",
      agentSessionId: EXPORT_FIXTURE.info.id,
      targetCwd: "/abs/target",
    });

    exportChild.stdout.emit("data", Buffer.from(JSON.stringify(EXPORT_FIXTURE)));
    exportChild.exitCode = 0;
    exportChild.emit("close", 0);

    await vi.waitFor(() => expect(spawnQueue.length).toBe(0));
    importChild.stdout.emit("data", Buffer.from(`Imported session: whatever\n`));
    importChild.exitCode = 0;
    importChild.emit("close", 0);

    const result = await resultPromise;
    expect(result.transferred).toBe(true);
    expect(result.newSessionId).toBeDefined();
    expect(result.newSessionId).not.toBe(EXPORT_FIXTURE.info.id);
  });

  it("returns transferred:false with a short reason when import exits non-zero", async () => {
    const exportChild = new FakeChild();
    const importChild = new FakeChild();
    spawnQueue = [exportChild, importChild];

    const resultPromise = transferOpencodeSession({
      sourceCwd: "/abs/source",
      agentSessionId: EXPORT_FIXTURE.info.id,
      targetCwd: "/abs/target",
    });

    exportChild.stdout.emit("data", Buffer.from(JSON.stringify(EXPORT_FIXTURE)));
    exportChild.exitCode = 0;
    exportChild.emit("close", 0);

    await vi.waitFor(() => expect(spawnQueue.length).toBe(0));
    importChild.stderr.emit("data", Buffer.from("Invalid id format"));
    importChild.exitCode = 1;
    importChild.emit("close", 1);

    const result = await resultPromise;
    expect(result.transferred).toBe(false);
    expect(result.reason).toMatch(/opencode session import failed/);
    expect(result.reason).toMatch(/Invalid id format/);
  });

  // opencode v2: `session export/import` subcommands (1.x's top-level
  // `export`/`import --pure` are gone), `--standalone` on BOTH legs so each
  // runs against a private server — never attaching to (or spawning, with
  // Mullion's own env) the user's shared background service — and
  // `--directory` so the importer re-keys the session to the worktree.
  it("runs `session export <id> --standalone` then `session import <file> --directory <target> --standalone`", async () => {
    const spawnMock = (await import("node:child_process")).spawn as unknown as ReturnType<
      typeof vi.fn
    >;
    spawnMock.mockClear();
    const exportChild = new FakeChild();
    const importChild = new FakeChild();
    spawnQueue = [exportChild, importChild];

    const resultPromise = transferOpencodeSession({
      sourceCwd: "/abs/source",
      agentSessionId: EXPORT_FIXTURE.info.id,
      targetCwd: "/abs/target",
    });
    exportChild.stdout.emit("data", Buffer.from(JSON.stringify(EXPORT_FIXTURE)));
    exportChild.exitCode = 0;
    exportChild.emit("close", 0);
    await vi.waitFor(() => expect(spawnQueue.length).toBe(0));
    importChild.exitCode = 0;
    importChild.emit("close", 0);
    await resultPromise;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [exportCall, importCall] = spawnMock.mock.calls as Array<
      [string, string[], { cwd: string }]
    >;
    expect(exportCall[0]).toBe("opencode");
    expect(exportCall[1]).toEqual(["session", "export", EXPORT_FIXTURE.info.id, "--standalone"]);
    expect(exportCall[2].cwd).toBe("/abs/source");
    expect(importCall[0]).toBe("opencode");
    expect(importCall[1].slice(0, 2)).toEqual(["session", "import"]);
    expect(importCall[1].slice(3)).toEqual(["--directory", "/abs/target", "--standalone"]);
    expect(importCall[1]).not.toContain("--pure");
    expect(importCall[2].cwd).toBe("/abs/target");
  });
});
