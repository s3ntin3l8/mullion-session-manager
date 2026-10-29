import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { projects } from "../../src/db/schema.js";
import type { DiscoveredCandidate } from "../../src/services/project-config.js";

// Shared by the project-merge service and route tests: two checkouts of one
// repo, the survivor local and the duplicate on a (fake) remote host.

export const MERGE_ORIGIN = "git@github.com:acme/app.git";

/** hostId -> that host's discovery answer; the tests' vi.mock reads it. */
export const mergeDiscovery = new Map<string, DiscoveredCandidate[]>();

export function localProject(
  app: FastifyInstance,
  tmp: string,
  name: string,
  createdAt: Date,
  origin: string | null = MERGE_ORIGIN,
) {
  const cwd = path.join(tmp, name);
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  if (origin) {
    fs.writeFileSync(path.join(cwd, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
  }
  return app.db
    .insert(projects)
    .values({ name, cwd, hostId: "local", createdAt })
    .returning()
    .get();
}

export function remoteProject(
  app: FastifyInstance,
  hostId: string,
  name: string,
  cwd: string,
  createdAt: Date,
  origin: string | null = MERGE_ORIGIN,
) {
  mergeDiscovery.set(hostId, [{ name, cwd, isGitRepo: true, origin }]);
  return app.db.insert(projects).values({ name, cwd, hostId, createdAt }).returning().get();
}
