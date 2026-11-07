// #2637 follow-up — a review-gate decision or an attention ack whose connection
// to the session's host was lost after the request was sent has an UNKNOWN
// outcome: the route says so (502) instead of "failed to reach host", which
// invites a blind retry. Its own file: sessions.test.ts is at its size ceiling.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    resolveReviewGate: vi.fn(),
    acknowledgeAttention: vi.fn(),
  },
}));
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRemoteHostClient: () => mockClient,
}));

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { HostOutcomeUnknownError, HostUnreachableError } =
  await import("../../src/services/remote-host-errors.js");
const { sessions } = await import("../../src/db/schema.js");

const tmpDb = path.join(os.tmpdir(), `sessions-unknown-outcome-${process.pid}.db`);

describe("remote session control calls with an unknown outcome", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function setup() {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, createDir: true, name: "p-unknown", cwd: "/tmp" },
    });
    const projectId = created.json().id as number;
    const [row] = app.db
      .insert(sessions)
      .values({ projectId, command: "claude", cwd: "/tmp", status: "active", hostId: "h1" })
      .returning()
      .all();
    return { app, sessionId: row.id };
  }

  it.each(["review-gate", "attention/ack"])(
    "%s: an unknown outcome is a 502 that says it may have been delivered",
    async (suffix) => {
      const { app, sessionId } = await setup();
      mockClient.resolveReviewGate.mockRejectedValue(
        new HostOutcomeUnknownError("h1", new Error("closed")),
      );
      mockClient.acknowledgeAttention.mockRejectedValue(
        new HostOutcomeUnknownError("h1", new Error("closed")),
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/${suffix}`,
        payload: suffix === "review-gate" ? { decision: "approved" } : undefined,
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain("MAY HAVE BEEN DELIVERED");
      await app.close();
    },
  );

  it("a plain unreachable error keeps the generic bad-gateway answer", async () => {
    const { app, sessionId } = await setup();
    mockClient.acknowledgeAttention.mockRejectedValue(
      new HostUnreachableError("h1", new Error("down")),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/attention/ack`,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe("Failed to deliver acknowledgement to host");
    await app.close();
  });
});
