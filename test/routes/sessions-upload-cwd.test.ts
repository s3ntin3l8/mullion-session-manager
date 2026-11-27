// A session placed on another host has no `sessions.cwd`, and its project's own
// path does not exist there: the upload must target the project's checkout on
// the SESSION's host (projects.hostCwds), not `projects.cwd`.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq, ne } from "drizzle-orm";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { seedHostResponse } from "../helpers/hosts.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
const { sessionCwdOnHost } = await import("../../src/services/session-host.js");

const tmpDb = path.join(os.tmpdir(), `sessions-upload-cwd-${process.pid}.db`);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PRIMARY_CWD = "/home/me/projects/app";
const REMOTE_CWD = "/Users/me/Projects/app";

describe("upload cwd on the session's own host", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).where(ne(hosts.id, LOCAL_HOST_ID)).run();
  });

  // A local project whose session runs on a remote host, with no session cwd.
  async function setup(mapped: boolean) {
    const hostRes = await seedHostResponse(app, {
      name: "mac-agent",
      baseUrl: "http://127.0.0.1:1",
      token: "t",
    });
    const hostId = hostRes.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    const backend = {
      spawn: vi.fn().mockResolvedValue({}),
      liveStatus: vi.fn().mockResolvedValue({}),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      uploadImage: vi.fn().mockResolvedValue({ path: `${REMOTE_CWD}/.mullion-uploads/x.png` }),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(
      (() => backend) as unknown as typeof sessionBackendModule.resolveBackend,
    );
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "cross-host", cwd: PRIMARY_CWD, hostId },
    });
    const projectId = projectRes.json().id as number;
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId, command: "opencode" },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as number;
    app.db
      .update(projects)
      .set({
        hostId: LOCAL_HOST_ID,
        cwd: PRIMARY_CWD,
        hostCwds: mapped ? JSON.stringify({ [hostId]: REMOTE_CWD }) : null,
      })
      .where(eq(projects.id, projectId))
      .run();
    app.db.update(sessions).set({ hostId, cwd: null }).where(eq(sessions.id, sessionId)).run();
    return { backend, sessionId, hostId, projectId };
  }

  const upload = (sessionId: number) =>
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      headers: { "content-type": "image/png" },
      payload: PNG,
    });

  it("uploads under the project's mapped path on the session's host", async () => {
    const { backend, sessionId } = await setup(true);
    const res = await upload(sessionId);
    expect(res.statusCode).toBe(200);
    expect(backend.uploadImage).toHaveBeenCalledWith(REMOTE_CWD, expect.any(Buffer), "image/png");
  });

  it("answers 409, without uploading, when the project has no path on that host", async () => {
    const { backend, sessionId } = await setup(false);
    const res = await upload(sessionId);
    expect(res.statusCode).toBe(409);
    expect(backend.uploadImage).not.toHaveBeenCalled();
  });

  it("sessionCwdOnHost: own cwd, project host, mapped host, unmapped host", () => {
    const project = {
      hostId: LOCAL_HOST_ID,
      cwd: PRIMARY_CWD,
      hostCwds: JSON.stringify({ remote: REMOTE_CWD }),
    };
    const row = { projectId: 1, hostId: null as string | null, cwd: null as string | null };
    expect(sessionCwdOnHost(app, { ...row, cwd: "/own" }, project)).toBe("/own");
    expect(sessionCwdOnHost(app, { ...row, hostId: LOCAL_HOST_ID }, project)).toBe(PRIMARY_CWD);
    expect(sessionCwdOnHost(app, { ...row, hostId: "remote" }, project)).toBe(REMOTE_CWD);
    expect(sessionCwdOnHost(app, { ...row, hostId: "other" }, project)).toBeNull();
  });
});
