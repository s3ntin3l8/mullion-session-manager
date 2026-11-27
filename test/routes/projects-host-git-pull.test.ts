import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects } from "../../src/db/schema.js";
import { HostRequestError, RemoteHostClient } from "../../src/services/remote-host-client.js";
import { isCloneBusy, markCloneBusy, releaseClone } from "../../src/services/git-clone-busy.js";
import { seedHostResponse } from "../helpers/hosts.js";

const tmpDb = path.join(os.tmpdir(), `projects-host-git-pull-${process.pid}.db`);

describe("host-targeted project git pull", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let primary: string;
  let extra: string;
  let projectId: number;
  const primaryPath = "/srv/primary";
  const extraPath = "/work/extra";

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
    const addHost = async (name: string) => {
      const res = await seedHostResponse(app, {
        name,
        baseUrl: "http://127.0.0.1:1",
        token: "t".repeat(24),
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };
    primary = await addHost("pull-primary");
    extra = await addHost("pull-extra");
    projectId = app.db
      .insert(projects)
      .values({
        name: "multi-host-pull",
        hostId: primary,
        cwd: primaryPath,
        // A stale map entry for the primary must never override projects.cwd.
        hostCwds: JSON.stringify({ [extra]: extraPath, [primary]: "/stale" }),
      })
      .returning({ id: projects.id })
      .get().id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    releaseClone(primary, primaryPath);
    releaseClone(extra, extraPath);
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  let requestCount = 0;
  const pull = (query = "") =>
    app.inject({
      method: "POST",
      remoteAddress: `127.0.0.${++requestCount}`,
      url: `/api/projects/${projectId}/git-pull${query}`,
    });

  it("pulls the extra host's own checkout, claiming only that clone until completion", async () => {
    markCloneBusy(primary, primaryPath);
    const remote = vi
      .spyOn(RemoteHostClient.prototype, "resolveGitPull")
      .mockImplementation(function (this: unknown, cwd: string) {
        expect((this as { hostId: string }).hostId).toBe(extra);
        expect(cwd).toBe(extraPath);
        expect(isCloneBusy(extra, extraPath)).toBe(true);
        return Promise.resolve({ pulled: true });
      });
    const res = await pull(`?hostId=${extra}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pulled: true });
    expect(remote).toHaveBeenCalledOnce();
    expect(isCloneBusy(extra, extraPath)).toBe(false);
    expect(isCloneBusy(primary, primaryPath)).toBe(true);
  });

  it("keeps the primary checkout as the default and when explicitly selected", async () => {
    const remote = vi
      .spyOn(RemoteHostClient.prototype, "resolveGitPull")
      .mockImplementation(function (this: unknown) {
        expect((this as { hostId: string }).hostId).toBe(primary);
        return Promise.resolve({ pulled: false, reason: "already-up-to-date" });
      });
    for (const query of ["", `?hostId=${primary}`]) {
      expect((await pull(query)).statusCode).toBe(200);
    }
    expect(remote.mock.calls).toEqual([[primaryPath], [primaryPath]]);
  });

  it.each(["unknown-host", "toString", "__proto__", ""])(
    "rejects an unlisted host %s",
    async (hostId) => {
      const remote = vi.spyOn(RemoteHostClient.prototype, "resolveGitPull");
      const res = await pull(`?hostId=${hostId}`);
      expect(res.statusCode).toBe(400);
      expect(remote).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous session and host targeting", async () => {
    const remote = vi.spyOn(RemoteHostClient.prototype, "resolveGitPull");
    expect((await pull(`?hostId=${extra}&sessionId=1`)).statusCode).toBe(400);
    expect(remote).not.toHaveBeenCalled();
  });

  it("refuses a busy target clone even when the primary clone is free", async () => {
    markCloneBusy(extra, extraPath);
    const remote = vi.spyOn(RemoteHostClient.prototype, "resolveGitPull");
    expect((await pull(`?hostId=${extra}`)).statusCode).toBe(409);
    expect(remote).not.toHaveBeenCalled();
    expect(isCloneBusy(extra, extraPath)).toBe(true);
    expect(isCloneBusy(primary, primaryPath)).toBe(false);
  });

  it("reports the unreachable target host and releases its clone", async () => {
    const res = await pull(`?hostId=${extra}`);
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toBe(`Host ${extra} is unreachable`);
    expect(isCloneBusy(extra, extraPath)).toBe(false);
  });

  it("reports an old target agent as unsupported and releases its clone", async () => {
    vi.spyOn(RemoteHostClient.prototype, "resolveGitPull").mockRejectedValue(
      new HostRequestError(extra, 404, ""),
    );
    const res = await pull(`?hostId=${extra}`);
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({
      error: "unsupported",
      message: `Host ${extra}'s Mullion is too old for this git operation`,
    });
    expect(isCloneBusy(extra, extraPath)).toBe(false);
  });
});
