import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// The positive path for GET /api/projects' detectedDevServerPort field
// (issue #28 phase 7) — test/routes/projects.test.ts's own
// "detectedDevServerPort" describe block only covers the null outcomes
// (untracked, remote-hosted, wrong kind/status), since those don't need a
// real PtyManager session at all. Proving the non-null case needs an
// actual dock session with buffered PTY output, which needs the same
// node-pty/child_process mocking test/routes/internal.test.ts uses — kept
// in its own file (Hermes review, PR #49) rather than pulling that heavier
// mock setup into every other, unrelated test in projects.test.ts.
const fakePtyChildren: FakePty[] = [];

class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }
  onExit() {
    return { dispose: () => {} };
  }
  write() {}
  resize() {}
  kill() {}
  emitData(chunk: string) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const child = new FakePty();
    fakePtyChildren.push(child);
    return child;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    // bootstrapMaster's systemd-run and the reconciler's systemctl probes
    // both only need to resolve — this suite never asserts on liveness.
    spawn: vi.fn((file: string) => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      if (file === "systemctl") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => ee.stdout?.emit("data", Buffer.from("active\n")));
        });
        return ee;
      }
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");

const tmpDb = path.join(os.tmpdir(), `projects-dev-server-detect-test-${process.pid}.db`);

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("GET /api/projects — detectedDevServerPort, positive path (issue #28 phase 7)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(async () => {
    const { closeDb } = await import("../../src/db/client.js");
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("returns the port parsed from a real, tracked dock session's own scrollback", async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "with-dock", cwd: "/tmp/with-dock" },
    });
    const projectId = created.json().id as number;

    const before = fakePtyChildren.length;
    const spawned = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "npm run dev", kind: "dock" },
    });
    expect(spawned.statusCode).toBe(201);
    await waitUntil(() => fakePtyChildren.length > before);

    const pty = fakePtyChildren[fakePtyChildren.length - 1];
    pty.emitData("  VITE v5.2.0  ready in 320 ms\n\n  ➜  Local:   http://localhost:5173/\n");

    const listed = await app.inject({ method: "GET", url: "/api/projects" });
    const project = listed.json().find((p: { id: number }) => p.id === projectId);
    expect(project.detectedDevServerPort).toBe("5173");

    await app.close();
  });
});
