import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { buildTestApp } from "../helpers/app.js";
import { projects } from "../../src/db/schema.js";
import { createHost } from "../../src/services/host-registry.js";
import { mergeProjects } from "../../src/services/project-merge.js";
import { localProject, mergeDiscovery, remoteProject } from "../helpers/merge-fixtures.js";

// A remote host's discovery is the only thing faked (as in project-merge.test.ts).
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => ({
      discover: async () => mergeDiscovery.get(hostId) ?? [],
    }),
  };
});

const OLD = new Date("2024-01-01T00:00:00Z");
const NEW = new Date("2025-01-01T00:00:00Z");

// A merged-away project's Chromium used to be closed but everything it left on
// disk stayed for good: its cookie jar, per-target files and downloads. Merge
// now forgets the project the way deleting it does (#2725).
describe("project merge forgets the duplicate's browser files", () => {
  let app: FastifyInstance;
  let tmp: string;

  beforeEach(async () => {
    mergeDiscovery.clear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "project-merge-browser-"));
    app = await buildTestApp();
    await app.ready();
    app.db.delete(projects).run();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("deletes the duplicate's jar, claim, per-target files and downloads, and leaves the survivor's", async () => {
    const survivorId = localProject(app, tmp, "app", OLD).id;
    const macId = createHost(app, { name: "mac", baseUrl: "http://mac.test", token: "t" }).id;
    const duplicateId = remoteProject(app, macId, "app-mac", "/Users/me/app", NEW).id;
    const dataDir = (app.browser as unknown as { dataDir: string }).dataDir;
    fs.mkdirSync(path.join(dataDir, "downloads"), { recursive: true });
    const digest = "0123456789abcdef";
    const dupFiles = [
      `project-${duplicateId}.json`,
      `project-${duplicateId}.owner`,
      `project-${duplicateId}-${digest}.json`,
      `project-${duplicateId}-${digest}.endpoints`,
    ].map((n) => path.join(dataDir, n));
    const dupDownloads = path.join(dataDir, "downloads", `project-${duplicateId}-${digest}`);
    const survivorFile = path.join(dataDir, `project-${survivorId}.json`);
    for (const f of [...dupFiles, survivorFile]) fs.writeFileSync(f, "{}");
    fs.mkdirSync(dupDownloads, { recursive: true });
    fs.writeFileSync(path.join(dupDownloads, "report.pdf"), "x");

    expect(mergeProjects(app, { survivorId, duplicateId }).ok).toBe(true);

    // Fire-and-forget after the transaction: wait for the files to go.
    await vi.waitFor(() => {
      for (const f of dupFiles) expect(fs.existsSync(f)).toBe(false);
      expect(fs.existsSync(dupDownloads)).toBe(false);
    });
    expect(fs.existsSync(survivorFile)).toBe(true);
  });
});
