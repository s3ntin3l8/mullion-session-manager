// #3159 — wait_for_output's `afterSeq`: the match window starts where the
// child began answering, so the prompt's redrawn echo cannot satisfy a marker
// the prompt itself contains. Exercised through the local backend (the
// control-socket op's code path) and the agent's wait-output route.
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  answerStartOffsetAfter,
  noteHookForAnswerStart,
} from "../../src/services/answer-start-offsets.js";
import { resolveWaitStartOffset } from "../../src/services/session-prompt.js";
import { resolveBackend } from "../../src/services/session-backend.js";
import { registerSessionRoutes } from "../../src/routes/internal-sessions.js";

/** A PTY stand-in with a real byte counter and an event head, like Session. */
class FakeSession {
  isAlive = true;
  private bytes = Buffer.alloc(0);
  private listeners = new Set<(c: Buffer) => void>();
  eventSeqHead = 5;
  size = { cols: 80, rows: 24 };
  get outputOffset() {
    return this.bytes.length;
  }
  print(text: string) {
    const chunk = Buffer.from(text);
    this.bytes = Buffer.concat([this.bytes, chunk]);
    for (const l of this.listeners) l(chunk);
  }
  onData(l: (c: Buffer) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  getOutputSince(offset: number) {
    return this.bytes.subarray(Math.min(offset, this.bytes.length));
  }
  /** What Session.emitHookEvent does before dispatching a hook. */
  hook(kind: string) {
    noteHookForAnswerStart(this, kind);
    this.eventSeqHead += 1;
  }
}

function appWith(session: FakeSession): FastifyInstance {
  return { pty: { get: () => session } } as unknown as FastifyInstance;
}

describe("answer-start offsets", () => {
  it("records turn_start/progress only, and finds the first one after a seq", () => {
    const s = new FakeSession();
    s.print("echo");
    s.hook("agent_prompt"); // not an answer-start hook
    expect(answerStartOffsetAfter(s, 5)).toBeUndefined();
    s.hook("turn_start");
    s.print("answer");
    s.hook("progress");
    expect(answerStartOffsetAfter(s, 5)).toBe(4);
    expect(answerStartOffsetAfter(s, 7)).toBe(10);
    expect(answerStartOffsetAfter(s, 8)).toBeUndefined();
  });

  it("bounds what it keeps", () => {
    const s = new FakeSession();
    for (let i = 0; i < 100; i++) s.hook("progress");
    expect(answerStartOffsetAfter(s, 5)).toBeDefined();
    expect(answerStartOffsetAfter(s, 5 + 100 - 1)).toBeDefined();
  });

  it("resolveWaitStartOffset never goes earlier than the caller's offset", () => {
    const s = new FakeSession();
    s.print("0123456789");
    s.hook("turn_start");
    expect(resolveWaitStartOffset(s, 3, 5)).toBe(10);
    expect(resolveWaitStartOffset(s, 20, 5)).toBe(20);
    expect(resolveWaitStartOffset(s, undefined, 5)).toBe(10);
    expect(resolveWaitStartOffset(s, 3, undefined)).toBe(3);
    expect(resolveWaitStartOffset(s, 3, 99)).toBe(3);
  });
});

describe("local backend waitOutput with afterSeq", () => {
  async function wait(s: FakeSession, extra: { afterOffset?: number; afterSeq?: number }) {
    return resolveBackend(appWith(s), "").waitOutput("1", {
      match: "ZEBRA-42",
      regex: false,
      timeoutMs: 150,
      signal: new AbortController().signal,
      alive: () => true,
      ...extra,
    });
  }

  it("times out on a marker only the prompt contains, until the child prints it", async () => {
    const s = new FakeSession();
    const afterOffset = s.outputOffset;
    const afterSeq = s.eventSeqHead;
    s.print("> print ZEBRA-42\r\n"); // the TUI redraws the submitted prompt
    s.hook("turn_start");
    // No afterSeq: today's behaviour, the echo matches.
    expect(await wait(s, { afterOffset })).toMatchObject({ matched: true });
    expect(await wait(s, { afterOffset, afterSeq })).toMatchObject({
      matched: false,
      timedOut: true,
    });
    s.print("ZEBRA-42\r\n");
    expect(await wait(s, { afterOffset, afterSeq })).toMatchObject({ matched: true });
  });

  it("falls back to the post-submit offset when no hook arrived after the seq", async () => {
    const s = new FakeSession();
    const afterOffset = s.outputOffset;
    s.print("> print ZEBRA-42\r\n");
    expect(await wait(s, { afterOffset, afterSeq: s.eventSeqHead })).toMatchObject({
      matched: true,
    });
  });
});

describe("POST /internal/sessions/:id/wait-output with afterSeq", () => {
  async function agent(s: FakeSession) {
    const app = Fastify();
    app.decorate("pty", { get: () => s } as never);
    registerSessionRoutes(app);
    await app.ready();
    return app;
  }
  const post = (app: FastifyInstance, payload: object) =>
    app.inject({ method: "POST", url: "/internal/sessions/1/wait-output", payload });

  it("skips the redrawn prompt echo; an old primary (no afterSeq) is unchanged", async () => {
    const s = new FakeSession();
    const afterOffset = s.outputOffset;
    const afterSeq = s.eventSeqHead;
    s.print("> print ZEBRA-42\r\n");
    s.hook("turn_start");
    const app = await agent(s);
    const body = { match: "ZEBRA-42", regex: false, timeoutMs: 150, afterOffset };
    expect((await post(app, { ...body, afterSeq })).json()).toMatchObject({ timedOut: true });
    s.print("ZEBRA-42\r\n");
    expect((await post(app, { ...body, afterSeq })).json()).toMatchObject({ matched: true });
    expect((await post(app, body)).json()).toMatchObject({ matched: true });
    await app.close();
  });
});
