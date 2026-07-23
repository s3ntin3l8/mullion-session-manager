import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Regression test for the race Hermes's review of #258 found: 'error' and
// 'close' fire on separate ticks for a real socket, and a mappable event
// arriving between them would already have replaced the dead connection
// with a fresh one — an unconditional `conn = null` in the later 'close'
// handler would then wipe out that newer, healthy connection instead of
// the dead one it was actually meant for. A real net.Server can't force
// that exact tick ordering deterministically (that's what made the bug
// possible in the first place), so this mocks node:net to control 'error'
// and 'close' timing directly instead — see opencode-plugin.js's `forget()`
// for the identity-check fix this proves.

class FakeSocket extends EventEmitter {
  writable = true;
  destroy = vi.fn();
  write = vi.fn();
}

const createdSockets: FakeSocket[] = [];

vi.mock("node:net", () => ({
  default: {
    createConnection: vi.fn(() => {
      const socket = new FakeSocket();
      createdSockets.push(socket);
      return socket;
    }),
  },
}));

const { MullionHookEmitter } = await import("../../src/hooks/opencode-plugin.js");
const net = await import("node:net");

describe("opencode-plugin.js reconnect race (Hermes review, PR #258)", () => {
  beforeEach(() => {
    createdSockets.length = 0;
    vi.mocked(net.default.createConnection).mockClear();
    process.env.MULLION_HOOK_SOCKET = "/fake/hooks.sock";
    process.env.MULLION_HOOK_TOKEN = "tok";
  });

  it("a stale socket's delayed 'close' does not clobber a newer, already-connected replacement", async () => {
    const hooks = await MullionHookEmitter();

    // First event opens connection A.
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "1" } } });
    expect(createdSockets).toHaveLength(1);
    const socketA = createdSockets[0];

    // A errors (its handler nulls `conn` and calls destroy() — but does
    // NOT yet fire 'close', mirroring the real, separate-tick behavior).
    socketA.emit("error", new Error("ECONNRESET"));
    expect(socketA.destroy).toHaveBeenCalledOnce();

    // A second event arrives before A's 'close' fires — this must open a
    // fresh connection B, since `conn` was nulled by A's error.
    await hooks.event?.({ event: { type: "file.edited", properties: { file: "/x.ts" } } });
    expect(createdSockets).toHaveLength(2);
    const socketB = createdSockets[1];
    socketB.emit("connect");
    socketB.write.mockClear();

    // NOW A's delayed 'close' finally fires. Before the fix, this would
    // null out `conn` (still pointing at B), silently breaking B for
    // every future send.
    socketA.emit("close");

    // A third event must reuse B (no third connection created) and must
    // actually reach the wire.
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "1" } } });
    expect(createdSockets).toHaveLength(2);
    expect(socketB.write).toHaveBeenCalledWith(
      `${JSON.stringify({ kind: "progress", phase: "done" })}\n`,
    );
  });
});
