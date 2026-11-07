// #2703 — upload, decline-promote and accept-promote answer an UNKNOWN
// outcome (the connection to the session's host was lost after the request
// was sent) with the one shared "may have been delivered" wording, never a
// plain failure. Its own file: sessions-unknown-outcome.test.ts covers the
// review-gate and ack routes.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { ne } from "drizzle-orm";
import { hosts, projects, sessions } from "../../src/db/schema.js";

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
const { MutationOutcomeUnknownError } = sessionBackendModule;
const { HostOutcomeUnknownError } = await import("../../src/services/remote-host-errors.js");

const tmpDb = path.join(os.tmpdir(), `sessions-unknown-outcome-writes-${process.pid}.db`);
const REMOTE_CWD = "/srv/unknown-outcome";
const WORKTREE = `${REMOTE_CWD}/.mullion-worktrees/mullion-session-x`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("upload and promote routes with an unknown outcome (#2703)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const unknown = () =>
    new MutationOutcomeUnknownError("h", "op", new HostOutcomeUnknownError("h", new Error("x")));

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

  async function setup(overrides: Record<string, unknown>) {
    const hostRes = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "unknown-agent", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = hostRes.json().id as string;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    const backend = {
      createWorktree: vi
        .fn()
        .mockResolvedValue({ created: true, path: WORKTREE, branch: "mullion/session-x" }),
      removeWorktree: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue({}),
      liveStatus: vi.fn().mockResolvedValue({}),
      resolvePendingPromote: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockImplementation(
      (() => backend) as unknown as typeof sessionBackendModule.resolveBackend,
    );
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "unknown-writes", cwd: REMOTE_CWD, hostId },
    });
    const source = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { projectId: projectRes.json().id, command: "opencode" },
    });
    expect(source.statusCode).toBe(201);
    return { backend, sessionId: source.json().id as number };
  }

  it("upload: an unknown outcome is a 502 that says it may have been delivered", async () => {
    const { sessionId } = await setup({ uploadImage: vi.fn().mockRejectedValue(unknown()) });
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/uploads`,
      headers: { "content-type": "image/png" },
      payload: PNG,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("MAY HAVE BEEN DELIVERED");
    expect(res.json().message).toContain("check the state on the host before retrying");
  });

  it("decline-promote: an unknown outcome is a 502 that says it may have been delivered", async () => {
    const { sessionId } = await setup({
      resolvePendingPromote: vi.fn().mockRejectedValue(unknown()),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/promote/decline`,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain("MAY HAVE BEEN DELIVERED");
  });

  it("accept-promote: the session still promotes, with a warning that the decision may have been delivered", async () => {
    const { sessionId, backend } = await setup({
      resolvePendingPromote: vi.fn().mockRejectedValue(unknown()),
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/promote`,
      payload: { baseRef: "main" },
    });
    expect(res.statusCode).toBe(201);
    expect(backend.resolvePendingPromote).toHaveBeenCalled();
    const warnings = res.json().warnings as string[];
    expect(warnings.join(" ")).toContain("MAY HAVE BEEN DELIVERED");
  });
});
