import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import type * as FsModule from "node:fs";
import { eq } from "drizzle-orm";
import { sessions } from "../../src/db/schema.js";

// Issue #1525/#1521 — killSession's status guard + concurrent cascade, and
// createSessionRecord skipping the scaffold scan when nothing is configured.
// Never lets a real systemd-run fire (#1137): node-pty and node:child_process
// are faked and resolveBackend() is replaced with a fake backend.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

// The local scaffold scan (discoverCommittedScaffold) lists <cwd>/.claude/skills
// — wrapped so a test can observe whether a create ran the scan at all.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

const fsMock = await import("node:fs");
const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { createSessionRecord, killSession } =
  await import("../../src/services/session-lifecycle.js");
const { writeProjectSkill } = await import("../../src/services/project-tooling.js");

const tmpDb = path.join(os.tmpdir(), `session-lifecycle-kill-${process.pid}.db`);

describe("session-lifecycle (kill + create)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup() {
    const app = await buildApp();
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: `p-${Math.random()}`, cwd: "/tmp" },
    });
    const projectId = project.json().id as number;
    const backend = {
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn(async () => ({})),
    };
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(
      backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>,
    );
    return { app, projectId, backend };
  }

  const statusOf = (app: Awaited<ReturnType<typeof setup>>["app"], id: number) =>
    app.db.select().from(sessions).where(eq(sessions.id, id)).get()?.status;

  it("does not overwrite an already-exited session with killed", async () => {
    const { app, projectId, backend } = await setup();
    const row = app.db
      .insert(sessions)
      .values({ projectId, command: "bash", status: "exited" })
      .returning()
      .get();
    const res = await killSession(app, row.id);
    expect(res).toMatchObject({ id: row.id, status: "exited" });
    expect(statusOf(app, row.id)).toBe("exited");
    expect(backend.terminate).not.toHaveBeenCalled();
    await app.close();
  });

  it("flips an active session to killed and terminates it", async () => {
    const { app, projectId, backend } = await setup();
    const row = app.db.insert(sessions).values({ projectId, command: "bash" }).returning().get();
    const res = await killSession(app, row.id);
    expect(res).toMatchObject({ status: "killed" });
    expect(backend.terminate).toHaveBeenCalledWith(String(row.id));
    await app.close();
  });

  it("cascade kill terminates every live child concurrently", async () => {
    const { app, projectId, backend } = await setup();
    const parent = app.db.insert(sessions).values({ projectId, command: "bash" }).returning().get();
    const kids = [1, 2, 3].map(() =>
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", parentSessionId: parent.id })
        .returning()
        .get(),
    );
    let inFlight = 0;
    let peak = 0;
    backend.terminate.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    await killSession(app, parent.id, "kill");
    for (const k of kids) expect(statusOf(app, k.id)).toBe("killed");
    expect(statusOf(app, parent.id)).toBe("killed");
    // Parent's terminate runs after the children's; the three children overlap.
    expect(peak).toBe(3);
    await app.close();
  });

  const scannedSkillsDir = () =>
    vi
      .mocked(fsMock.readdirSync)
      .mock.calls.some((c) => String(c[0]).endsWith(path.join(".claude", "skills")));

  it("skips the scaffold scan when neither a skill nor a reviewer agent is configured", async () => {
    const { app, projectId } = await setup();
    vi.mocked(fsMock.readdirSync).mockClear();
    const res = await createSessionRecord(app, { projectId, command: "bash", cwd: "/tmp" });
    expect(res.ok).toBe(true);
    expect(scannedSkillsDir()).toBe(false);
    await app.close();
  });

  it("scans for a committed scaffold when a project skill is configured", async () => {
    const { app, projectId } = await setup();
    writeProjectSkill(app.db, projectId, "# skill");
    vi.mocked(fsMock.readdirSync).mockClear();
    const res = await createSessionRecord(app, { projectId, command: "bash", cwd: "/tmp" });
    expect(res.ok).toBe(true);
    expect(scannedSkillsDir()).toBe(true);
    await app.close();
  });
});
