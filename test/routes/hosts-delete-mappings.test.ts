import { afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../../src/app.js";
import { closeDb, getSqlite } from "../../src/db/client.js";

const tmpDb = path.join(os.tmpdir(), `hosts-delete-mappings-${process.pid}.db`);
const projectDirs: string[] = [];

fs.rmSync(tmpDb, { force: true });
process.env.DATABASE_URL = `file:${tmpDb}`;

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDb, { force: true });
  delete process.env.DATABASE_URL;
  for (const dir of projectDirs) fs.rmSync(dir, { recursive: true, force: true });
});

it("clears deleted host references and leaves projects without references byte-for-byte untouched (#3170)", async () => {
  const app = await buildApp();
  try {
    const createHost = async (name: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/hosts",
        payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    const hostId = await createHost("mapped-host");
    const otherHostId = await createHost("other-mapped-host");
    const unmappedHostId = await createHost("unmapped-host");

    const createProject = async (name: string) => {
      const cwd = path.join(os.tmpdir(), `hosts-delete-${process.pid}-${name}`);
      projectDirs.push(cwd);
      const response = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name, cwd },
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as number;
    };
    const mappedProjectId = await createProject("delete-host-mapped");
    const onlyMapProjectId = await createProject("delete-host-only-map");
    const metadataOnlyProjectId = await createProject("delete-host-metadata-only");
    const untouchedProjectId = await createProject("delete-host-untouched");

    const sqlite = getSqlite();
    if (!sqlite) throw new Error("expected the test database to be open");
    const rawProject = (id: number) =>
      sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown>;

    // Seed persisted combinations that the public API does not expose together.
    sqlite.prepare("UPDATE projects SET host_cwds = ?, host_cwds_meta = ? WHERE id = ?").run(
      JSON.stringify({ [hostId]: "/deleted/path", [otherHostId]: "/kept/path" }),
      JSON.stringify({
        auto: [hostId, otherHostId],
        declined: [hostId, otherHostId],
        managed: [hostId, otherHostId],
      }),
      mappedProjectId,
    );
    sqlite
      .prepare("UPDATE projects SET host_cwds = ? WHERE id = ?")
      .run(JSON.stringify({ [hostId]: "/only/path" }), onlyMapProjectId);
    sqlite
      .prepare("UPDATE projects SET host_cwds_meta = ? WHERE id = ?")
      .run(
        JSON.stringify({ auto: [hostId], declined: [hostId], managed: [hostId] }),
        metadataOnlyProjectId,
      );
    // Exact whitespace is intentional: a project with no reference must not
    // have either raw JSON blob parsed and rewritten as a side effect.
    const untouchedHostCwds = ` { "${otherHostId}" : "/kept/path" } `;
    const untouchedMeta = ` { "auto" : ["${otherHostId}"], "declined" : [], "managed" : [] } `;
    sqlite
      .prepare("UPDATE projects SET host_cwds = ?, host_cwds_meta = ? WHERE id = ?")
      .run(untouchedHostCwds, untouchedMeta, untouchedProjectId);
    const untouchedBefore = rawProject(untouchedProjectId);

    const deleted = await app.inject({ method: "DELETE", url: `/api/hosts/${hostId}` });
    expect(deleted.statusCode).toBe(204);

    const mapped = await app.inject({ method: "GET", url: `/api/projects/${mappedProjectId}` });
    expect(mapped.statusCode).toBe(200);
    expect(mapped.json().hostCwds).toEqual({ [otherHostId]: "/kept/path" });
    expect(mapped.json().hostCwdsMeta).toEqual({
      auto: [otherHostId],
      declined: [otherHostId],
      managed: [otherHostId],
    });

    for (const projectId of [onlyMapProjectId, metadataOnlyProjectId]) {
      const project = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
      expect(project.statusCode).toBe(200);
      expect(project.json().hostCwds).toEqual({});
      expect(project.json().hostCwdsMeta).toEqual({ auto: [], declined: [], managed: [] });
      expect(rawProject(projectId)).toMatchObject({ host_cwds: null, host_cwds_meta: null });
    }
    expect(rawProject(untouchedProjectId)).toEqual(untouchedBefore);

    const beforeUnmappedDelete = sqlite
      .prepare("SELECT * FROM projects ORDER BY id")
      .all() as Record<string, unknown>[];
    const unmappedDelete = await app.inject({
      method: "DELETE",
      url: `/api/hosts/${unmappedHostId}`,
    });
    expect(unmappedDelete.statusCode).toBe(204);
    const afterUnmappedDelete = sqlite
      .prepare("SELECT * FROM projects ORDER BY id")
      .all() as Record<string, unknown>[];
    expect(afterUnmappedDelete).toEqual(beforeUnmappedDelete);
  } finally {
    await app.close();
  }
});
