import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hosts } from "../../src/db/schema.js";

export interface SeedHostInput {
  name: string;
  baseUrl?: string;
  token?: string;
}

/**
 * Insert a remote host row directly for tests that need a pre-existing host
 * fixture after POST /api/hosts was removed (#3535). Calls `app.ready()` so
 * plugins (hostHeartbeatTracker, hostCapacityTracker, etc.) are initialized,
 * matching `await app.inject(...)`.
 */
export async function seedHost(app: FastifyInstance, input: SeedHostInput) {
  await app.ready();
  const id = crypto.randomUUID();
  const minted = input.token === undefined ? crypto.randomBytes(32).toString("hex") : undefined;
  const token = input.token ?? minted!;
  const [row] = app.db
    .insert(hosts)
    .values({
      id,
      name: input.name,
      baseUrl: input.baseUrl ?? null,
      authTokenEnc: app.encryption.encryptString(token),
      origin: "manual",
      approvedAt: new Date(),
    })
    .returning()
    .all();
  app.reconfigureRemoteEventSubscriptions();
  app.reconfigureSshAgentFanout();
  app.reconfigureControlRelayFanout();
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    origin: row.origin as "manual",
    role: row.role,
    drained: row.drained,
    hasToken: true,
    ...(minted !== undefined ? { token: minted } : {}),
  };
}

/**
 * Drop-in replacement for `await app.inject({ method: "POST", url: "/api/hosts", payload })`
 * in test fixtures after POST /api/hosts was removed (#3535).
 */
export async function seedHostResponse(app: FastifyInstance, input: SeedHostInput) {
  const host = await seedHost(app, input);
  return {
    statusCode: 201,
    json: <T = typeof host>() => host as T,
    body: JSON.stringify(host),
  };
}
