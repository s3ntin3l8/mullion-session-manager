import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { sessions, workspacePendingOpens, workspaces } from "../../src/db/schema.js";
import type * as SessionBackendModule from "../../src/services/session-backend.js";
import { dropPendingOpensForSession } from "../../src/services/workspace-pending-opens.js";

// #3033 — sessions opened on the fold or the phone, waiting for a desktop
// client to add their panes. Session rows are inserted directly: nothing here
// spawns a process.
// The kill route terminates the session's scope on its host: stand that call
// in, so no real process or scope is touched (AGENTS.md).
const terminate = vi.fn(async () => {});
vi.mock("../../src/services/session-backend.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionBackendModule>();
  return { ...actual, resolveBackend: () => ({ terminate }) };
});

const tmpDb = path.join(os.tmpdir(), `workspace-pending-opens-test-${process.pid}.db`);

type App = Awaited<ReturnType<typeof buildApp>>;

async function setup(app: App) {
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, createDir: true, name: "p", cwd: "/tmp" },
  });
  const projectId = project.json().id as number;
  const [a, b] = app.db
    .insert(sessions)
    .values([
      { projectId, command: "bash" },
      { projectId, command: "bash" },
    ])
    .returning()
    .all();
  const ws = await app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "W" } });
  return { workspaceId: ws.json().id as number, a: a!.id, b: b!.id };
}

describe("workspace pending opens", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("records, lists, acknowledges once, and never touches the layout", async () => {
    const app = await buildApp();
    const { workspaceId, a, b } = await setup(app);
    const url = `/api/workspaces/${workspaceId}/pending-opens`;

    const recorded = await app.inject({
      method: "POST",
      url,
      payload: { sessionId: b, referenceSessionId: a },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json()).toMatchObject({ sessionId: b, referenceSessionId: a });

    // Recording the same session again keeps one row with the newer reference.
    const again = await app.inject({
      method: "POST",
      url,
      payload: { sessionId: b, referenceSessionId: null },
    });
    expect(again.statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      { sessionId: b, referenceSessionId: null, createdAt: expect.any(String) },
    ]);

    const ack = await app.inject({ method: "POST", url: `${url}/${b}/ack` });
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toEqual({ acknowledged: true });
    // A second acknowledge (another desktop tab) is a no-op.
    const ack2 = await app.inject({ method: "POST", url: `${url}/${b}/ack` });
    expect(ack2.json()).toEqual({ acknowledged: false });
    expect((await app.inject({ method: "GET", url })).json()).toEqual([]);

    const row = app.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    expect(row?.layout).toBeNull();
    await app.close();
  });

  it("withdraws an open idempotently", async () => {
    const app = await buildApp();
    const { workspaceId, a } = await setup(app);
    const url = `/api/workspaces/${workspaceId}/pending-opens`;
    await app.inject({ method: "POST", url, payload: { sessionId: a } });

    const withdrawn = await app.inject({ method: "DELETE", url: `${url}/${a}` });
    expect(withdrawn.statusCode).toBe(204);
    const again = await app.inject({ method: "DELETE", url: `${url}/${a}` });
    expect(again.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url })).json()).toEqual([]);
    await app.close();
  });

  it("drops an unknown reference instead of refusing the open", async () => {
    const app = await buildApp();
    const { workspaceId, a } = await setup(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspaceId}/pending-opens`,
      payload: { sessionId: a, referenceSessionId: 999_999 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: a, referenceSessionId: null });
    await app.close();
  });

  it("refuses an unknown workspace or session, and a killed session", async () => {
    const app = await buildApp();
    const { workspaceId, a, b } = await setup(app);
    const url = `/api/workspaces/${workspaceId}/pending-opens`;

    const noWorkspace = await app.inject({
      method: "POST",
      url: "/api/workspaces/999999/pending-opens",
      payload: { sessionId: a },
    });
    expect(noWorkspace.statusCode).toBe(404);
    const noSession = await app.inject({ method: "POST", url, payload: { sessionId: 999_999 } });
    expect(noSession.statusCode).toBe(404);
    for (const [method, path] of [
      ["GET", "/api/workspaces/999999/pending-opens"],
      ["POST", `/api/workspaces/999999/pending-opens/${a}/ack`],
      ["DELETE", `/api/workspaces/999999/pending-opens/${a}`],
    ] as const) {
      expect((await app.inject({ method, url: path })).statusCode).toBe(404);
    }
    for (const [method, path] of [
      ["GET", "/api/workspaces/x/pending-opens"],
      ["POST", `${url}/x/ack`],
      ["DELETE", `${url}/x`],
    ] as const) {
      expect((await app.inject({ method, url: path })).statusCode).toBe(400);
    }
    const badBody = await app.inject({ method: "POST", url, payload: {} });
    expect(badBody.statusCode).toBe(400);

    app.db.update(sessions).set({ status: "killed" }).where(eq(sessions.id, b)).run();
    const killed = await app.inject({ method: "POST", url, payload: { sessionId: b } });
    expect(killed.statusCode).toBe(409);
    await app.close();
  });

  it("drops a killed session's pending opens, and cascades with the workspace", async () => {
    const app = await buildApp();
    const { workspaceId, a, b } = await setup(app);
    const url = `/api/workspaces/${workspaceId}/pending-opens`;
    await app.inject({ method: "POST", url, payload: { sessionId: a } });
    await app.inject({ method: "POST", url, payload: { sessionId: b } });

    dropPendingOpensForSession(app.db, a);
    expect((await app.inject({ method: "GET", url })).json()).toEqual([
      expect.objectContaining({ sessionId: b }),
    ]);

    await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceId}` });
    const left = app.db
      .select()
      .from(workspacePendingOpens)
      .where(eq(workspacePendingOpens.workspaceId, workspaceId))
      .all();
    expect(left).toEqual([]);
    await app.close();
  });

  // A session killed on the fold or the phone before a desktop applied its
  // open must not be added at the desk afterwards.
  it("drops a session's pending opens when it is killed", async () => {
    const app = await buildApp();
    const { workspaceId, a, b } = await setup(app);
    const url = `/api/workspaces/${workspaceId}/pending-opens`;
    await app.inject({ method: "POST", url, payload: { sessionId: a } });
    await app.inject({ method: "POST", url, payload: { sessionId: b } });

    const killed = await app.inject({ method: "DELETE", url: `/api/sessions/${a}` });
    expect(killed.statusCode).toBe(204);
    expect(terminate).toHaveBeenCalledWith(String(a));
    expect((await app.inject({ method: "GET", url })).json()).toEqual([
      expect.objectContaining({ sessionId: b }),
    ]);
    await app.close();
  });
});
