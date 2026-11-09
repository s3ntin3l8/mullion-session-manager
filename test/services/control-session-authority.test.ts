import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.js";
import { projects, sessions } from "../../src/db/schema.js";
import {
  extractIdField,
  ownAndChildSessionFilter,
  resolveEventsSessionFilter,
  resolveOwnedSessionId,
  resolveParentSessionId,
  resolveTargetProjectId,
  resolveTargetSessionId,
} from "../../src/services/control-session-authority.js";

const full = { scope: "full", sessionId: null } as const;
const session = (id: string) => ({ scope: "session", sessionId: id }) as const;

async function seed() {
  const app = await buildTestApp();
  await app.ready();
  const projectId = Number(
    app.db.insert(projects).values({ name: "auth", cwd: "/tmp/auth" }).run().lastInsertRowid,
  );
  const mk = (extra: Record<string, unknown> = {}) =>
    Number(
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", cwd: "/tmp/auth", ...extra })
        .run().lastInsertRowid,
    );
  return { app, projectId, mk };
}

describe("extractIdField", () => {
  it("accepts non-empty strings and numbers only", () => {
    expect(extractIdField({ a: "5" }, "a")).toBe("5");
    expect(extractIdField({ a: 5 }, "a")).toBe("5");
    expect(extractIdField({ a: "" }, "a")).toBeNull();
    expect(extractIdField({ a: {} }, "a")).toBeNull();
    expect(extractIdField(undefined, "a")).toBeNull();
  });
});

describe("resolveTargetSessionId / resolveParentSessionId (pin only)", () => {
  it("full scope requires the field", () => {
    expect(resolveTargetSessionId(full, {})).toMatchObject({
      ok: false,
      reply: { status: 400, error: "'sessionId' is required" },
    });
    expect(resolveParentSessionId(full, {})).toMatchObject({
      ok: false,
      reply: { status: 400, error: "'parentSessionId' is required" },
    });
    expect(resolveTargetSessionId(full, { sessionId: 7 })).toEqual({ ok: true, id: "7" });
  });

  it("session scope defaults to the pin and refuses any other id", () => {
    expect(resolveTargetSessionId(session("3"), {})).toEqual({ ok: true, id: "3" });
    expect(resolveTargetSessionId(session("3"), { sessionId: "3" })).toEqual({ ok: true, id: "3" });
    expect(resolveTargetSessionId(session("3"), { sessionId: "4" })).toMatchObject({
      ok: false,
      reply: { status: 403 },
    });
    expect(resolveParentSessionId(session("3"), { parentSessionId: "4" })).toMatchObject({
      ok: false,
      reply: { status: 403, error: expect.stringContaining("spawn children") },
    });
  });
});

describe("resolveOwnedSessionId / resolveEventsSessionFilter (children)", () => {
  it("lets a session name its active child and canonicalises the id", async () => {
    const { app, mk } = await seed();
    const parent = mk();
    const child = mk({ parentSessionId: parent });
    expect(resolveOwnedSessionId(app, session(String(parent)), { sessionId: child })).toEqual({
      ok: true,
      id: String(child),
    });
    expect(resolveOwnedSessionId(app, session(String(parent)), {})).toEqual({
      ok: true,
      id: String(parent),
    });
  });

  it("refuses siblings, unknown and non-numeric ids with the same 403", async () => {
    const { app, mk } = await seed();
    const parent = mk();
    const stranger = mk();
    for (const sessionId of [stranger, 999999, "abc"]) {
      expect(resolveOwnedSessionId(app, session(String(parent)), { sessionId })).toMatchObject({
        ok: false,
        reply: { status: 403, error: expect.stringContaining("or its children") },
      });
    }
  });

  it("re-checks the caller's own row is still active before reaching a child", async () => {
    const { app, mk } = await seed();
    const parent = mk({ status: "exited" });
    const child = mk({ parentSessionId: parent });
    expect(resolveOwnedSessionId(app, session(String(parent)), { sessionId: child })).toMatchObject(
      {
        ok: false,
        reply: { status: 403, error: "this session is no longer active" },
      },
    );
  });

  it("childOnly rejects the session's own id; full scope still needs a target", async () => {
    const { app, mk } = await seed();
    const parent = mk();
    const opts = { childOnly: true };
    expect(resolveOwnedSessionId(app, session(String(parent)), {}, opts)).toMatchObject({
      ok: false,
      reply: { status: 403 },
    });
    expect(
      resolveOwnedSessionId(app, session(String(parent)), { sessionId: parent }, opts),
    ).toMatchObject({ ok: false, reply: { status: 403 } });
    expect(resolveOwnedSessionId(app, full, {})).toMatchObject({
      ok: false,
      reply: { status: 400 },
    });
  });

  it("events filter: full scope may omit the target, session scope never broadens", async () => {
    const { app, mk } = await seed();
    const parent = mk();
    expect(resolveEventsSessionFilter(app, full, {})).toEqual({ ok: true, sessionId: undefined });
    expect(resolveEventsSessionFilter(app, full, { sessionId: 9 })).toEqual({
      ok: true,
      sessionId: "9",
    });
    expect(resolveEventsSessionFilter(app, session(String(parent)), {})).toEqual({
      ok: true,
      sessionId: String(parent),
    });
    expect(
      resolveEventsSessionFilter(app, session(String(parent)), { sessionId: 999999 }),
    ).toMatchObject({ ok: false, reply: { status: 403 } });
  });
});

describe("resolveTargetProjectId", () => {
  it("pins to the session's own active project", async () => {
    const { app, projectId, mk } = await seed();
    const id = mk();
    expect(resolveTargetProjectId(app, session(String(id)), {})).toEqual({
      ok: true,
      id: String(projectId),
    });
    expect(resolveTargetProjectId(app, session(String(id)), { projectId: 99999 })).toMatchObject({
      ok: false,
      reply: { status: 403 },
    });
    const gone = mk({ status: "exited" });
    expect(resolveTargetProjectId(app, session(String(gone)), {})).toMatchObject({
      ok: false,
      reply: { status: 400 },
    });
    expect(resolveTargetProjectId(app, full, {})).toMatchObject({
      ok: false,
      reply: { status: 400 },
    });
    expect(resolveTargetProjectId(app, full, { projectId: 4 })).toEqual({ ok: true, id: "4" });
  });
});

describe("ownAndChildSessionFilter", () => {
  it("accepts the pin and its children only", async () => {
    const { app, mk } = await seed();
    const parent = mk();
    const child = mk({ parentSessionId: parent });
    const other = mk();
    const keep = ownAndChildSessionFilter(app, parent);
    expect(keep(parent)).toBe(true);
    expect(keep(child)).toBe(true);
    expect(keep(other)).toBe(false);
    expect(keep(123456)).toBe(false);
  });
});
