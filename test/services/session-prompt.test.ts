import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { deliverPrompt } from "../../src/services/session-prompt.js";

/** A PTY stand-in whose output offset advances as input is written, like a TUI
 * that echoes what it is given. */
function fakeSession() {
  let offset = 100;
  const writes: string[] = [];
  const session = {
    command: "claude",
    isAlive: true,
    bracketedPaste: false,
    get outputOffset() {
      return offset;
    },
    eventSeqHead: 7,
    writeAgentInput: vi.fn((data: string) => {
      writes.push(data);
      offset += data.length + 50; // the echo
      return true;
    }),
    beginAgentTurn: vi.fn(),
  };
  const app = { pty: { get: () => session } } as unknown as FastifyInstance;
  return { app, session, writes, offsetNow: () => offset };
}

describe("deliverPrompt outputOffset (issue #2112)", () => {
  it("is taken after the submit write, so the typed echo is outside the wait window", async () => {
    const { app, session, writes, offsetNow } = fakeSession();
    const res = await deliverPrompt(app, "1", {
      text: "hello MARKER",
      submit: true,
      notRunning: "no",
    });
    expect(res).toMatchObject({ ok: true });
    expect(writes.length).toBe(2); // body, then Enter
    if (res.ok) expect(res.outputOffset).toBe(offsetNow());
    expect(session.beginAgentTurn).toHaveBeenCalled();
  });

  it("stays at the pre-write offset when the prompt is only typed, not submitted", async () => {
    const { app } = fakeSession();
    const res = await deliverPrompt(app, "1", { text: "draft", submit: false, notRunning: "no" });
    expect(res).toMatchObject({ ok: true, outputOffset: 100 });
  });
});
