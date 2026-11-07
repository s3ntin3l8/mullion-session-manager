import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCommand } from "../../src/cli/core.mjs";
import { OPS } from "../../src/plugins/control-socket.js";

// Issue #2687 — `mullion browser unbind` is the CLI way out of a
// `binding_unavailable` browser; it drives the browser.unbind control op.
function fakeIo() {
  const written: Buffer[] = [];
  return {
    stdin: new EventEmitter(),
    stdout: { write: vi.fn((chunk: Buffer | string) => written.push(Buffer.from(chunk))) },
    stderr: { write: vi.fn() },
    written,
    env: {},
  };
}
function fakeClient(result: unknown) {
  return {
    tokenSource: "MULLION_AUTH_TOKEN",
    close: vi.fn(),
    request: vi.fn(async () => result),
    openStream: vi.fn(),
  };
}

describe("mullion browser unbind", () => {
  it("calls browser.unbind for the named session and says what happened", async () => {
    const client = fakeClient({ ok: true, unbound: 1 });
    const io = fakeIo();
    const code = await runCommand(["browser", "unbind", "--session", "9"], {
      client,
      io,
    } as never);
    expect(code).toBe(0);
    expect(client.request).toHaveBeenCalledWith("browser.unbind", { sessionId: "9" });
    expect(io.written.join("")).toMatch(/Browser unbound/);
  });

  it("reports a session that had no binding", async () => {
    const io = fakeIo();
    await runCommand(["browser", "unbind", "--session", "9"], {
      client: fakeClient({ ok: true, unbound: 0 }),
      io,
    } as never);
    expect(io.written.join("")).toMatch(/no browser binding/);
  });

  it("is a session-reachable control op", () => {
    expect(OPS["browser.unbind"].scopes).toEqual(["full", "session"]);
  });
});
