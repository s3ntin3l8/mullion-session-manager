import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { getHostRow, resetHostRegistryNotices } from "../../src/services/host-registry.js";
import { seedHostResponse } from "../helpers/hosts.js";

// Issue #3439 — a per-host token cannot claim a host that already holds a
// live machine identity. The per-host token never expires and is never
// cleared, so before this rule a leaked one handed any peer that reached
// POST /api/internal/register the host's session and a fresh machine
// credential, and displaced the real agent into the 24 h grace slot.
//
// The fleet secret is configured for the whole file: a refused claim falls
// through to that branch and must still answer 401.
const tmpDb = path.join(os.tmpdir(), `enrollment-claim-refusal-test-${process.pid}.db`);

const REFUSAL_MESSAGE =
  "a registration was refused: the host has a live machine identity; re-pair it from Settings → Hosts";

describe("a per-host token cannot claim a host with a live identity (issue #3439)", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  // A fresh app per test: the register route is rate limited to 20/min per
  // client, which a shared app would trip.
  beforeEach(async () => {
    resetHostRegistryNotices();
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  const register = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: { hostname: "box", ...payload },
    });

  // The operator pre-creates a row and the primary mints its per-host token.
  const createHostRow = async (name: string) =>
    (await seedHostResponse(app, { name })).json() as {
      id: string;
      token: string;
    };

  // Two rows can carry the same token (Settings -> Add host -> "Use my own
  // token"), so the custom-token variant of the same call.
  const createHostRowWithToken = async (name: string, token: string) =>
    (await seedHostResponse(app, { name, token })).json() as {
      id: string;
    };

  const hostRowCount = () => app.db.select().from(hosts).all().length;

  it("refuses the token for a row with a live identity and leaves the row byte-for-byte unchanged", async () => {
    const created = await createHostRow("live-identity");
    const claim = await register({
      token: created.token,
      wantsMachineCredential: true,
      hostname: "the-real-agent",
    });
    expect(claim.statusCode).toBe(200);
    const first = claim.json();
    expect(first.host_id).toBe(created.id);
    expect(first.machine_credential).toMatch(/^[0-9a-f]{64}$/);

    const before = getHostRow(app, created.id)!;
    const rowsBefore = hostRowCount();

    // The leaked token, presented by a peer that wants the host.
    const takeover = await register({
      token: created.token,
      wantsMachineCredential: true,
      hostname: "the-thief",
      baseUrl: "http://127.0.0.1:1",
      platform: "win32",
      capabilities: { stolen: true },
    });
    expect(takeover.statusCode).toBe(401);

    // No state moved: not the credential, not its grace copy, not the
    // session, not the address, not the agent self-report.
    const after = getHostRow(app, created.id)!;
    expect(after).toEqual(before);
    expect(after.machineCredentialEnc).toBe(before.machineCredentialEnc);
    expect(after.machineCredentialPrevEnc).toBe(before.machineCredentialPrevEnc);
    expect(after.machineCredentialRotatedAt).toEqual(before.machineCredentialRotatedAt);
    expect(after.machineCredentialExpiresAt).toEqual(before.machineCredentialExpiresAt);
    expect(after.sessionIdEnc).toBe(before.sessionIdEnc);
    expect(after.sessionSecretEnc).toBe(before.sessionSecretEnc);
    expect(after.sessionExpiresAt).toEqual(before.sessionExpiresAt);
    expect(after.baseUrl).toBe(before.baseUrl);
    expect(after.agentMetadata).toBe(before.agentMetadata);
    expect(after.platform).toBe(before.platform);
    // And no new host row appeared (the claim does not fall through to an
    // enrollment either).
    expect(hostRowCount()).toBe(rowsBefore);

    // The legitimate agent still renews on its own identity.
    const renewed = await register({
      hostId: created.id,
      machineCredential: first.machine_credential,
      hostname: "the-real-agent",
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().host_id).toBe(created.id);
    expect(renewed.json().machine_credential).not.toBe(first.machine_credential);
  });

  it("still claims a row with no identity and a row whose identity expired", async () => {
    const fresh = await createHostRow("no-identity");
    const claimed = await register({
      token: fresh.token,
      wantsMachineCredential: true,
      hostname: "fresh-agent",
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().host_id).toBe(fresh.id);

    // An identity that expired (90 days unused) is not a live identity, so
    // its row stays claimable — the one remaining takeover window.
    const expired = await createHostRow("expired-identity");
    const first = await register({
      token: expired.token,
      wantsMachineCredential: true,
      hostname: "expiring-agent",
    });
    expect(first.statusCode).toBe(200);
    app.db
      .update(hosts)
      .set({ machineCredentialExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(hosts.id, expired.id))
      .run();

    const reclaimed = await register({
      token: expired.token,
      wantsMachineCredential: true,
      hostname: "replacement-agent",
    });
    expect(reclaimed.statusCode).toBe(200);
    expect(reclaimed.json().host_id).toBe(expired.id);
    expect(reclaimed.json().machine_credential).not.toBe(first.json().machine_credential);
  });

  it("lets a legacy agent (no wantsMachineCredential) claim its token on every boot", async () => {
    const created = await createHostRow("legacy-agent");
    // A legacy agent advertises its own address and asks for no credential.
    const first = await register({
      token: created.token,
      hostname: "legacy-agent",
      baseUrl: "http://127.0.0.1:1",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().host_id).toBe(created.id);
    expect(first.json().machine_credential).toBeUndefined();
    // No identity was issued, so the row stays claimable.
    expect(getHostRow(app, created.id)!.machineCredentialEnc).toBeNull();

    const second = await register({
      token: created.token,
      hostname: "legacy-agent",
      baseUrl: "http://127.0.0.1:1",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().host_id).toBe(created.id);
  });

  it("logs the refusal once per host and never logs the token", async () => {
    const created = await createHostRow("logged-refusal");
    const claim = await register({
      token: created.token,
      wantsMachineCredential: true,
      hostname: "the-real-agent",
    });
    expect(claim.statusCode).toBe(200);

    const warn = vi.spyOn(app.log, "warn");
    await register({ token: created.token, wantsMachineCredential: true });
    await register({ token: created.token, wantsMachineCredential: true });

    const refusals = warn.mock.calls.filter(([, msg]) =>
      String(msg).includes("live machine identity"),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]![1]).toBe(REFUSAL_MESSAGE);
    expect(refusals[0]![0]).toEqual({ hostId: created.id });
    // The token is never part of the line — only the host id is.
    expect(JSON.stringify(refusals)).not.toContain(created.token);
  });

  it("logs a refusal only when the claim really fails, not when a shared token still matches a pending row", async () => {
    const token = `shared-token-3439-${crypto.randomUUID()}`;
    const live = await createHostRowWithToken("shared-live", token);
    const claim = await register({ token, wantsMachineCredential: true, hostname: "first-agent" });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().host_id).toBe(live.id);

    // A second row with the same token, without an identity yet.
    const pending = await createHostRowWithToken("shared-pending", token);

    const warn = vi.spyOn(app.log, "warn");
    const second = await register({
      token,
      wantsMachineCredential: true,
      hostname: "second-agent",
    });
    // The live row is skipped and the pending one is claimed: that
    // registration was NOT refused, so nothing may be logged as a refusal.
    expect(second.statusCode).toBe(200);
    expect(second.json().host_id).toBe(pending.id);
    const refusals = warn.mock.calls.filter(([, msg]) =>
      String(msg).includes("live machine identity"),
    );
    expect(refusals).toHaveLength(0);

    // Now both rows hold a live identity, so the claim really is refused —
    // and that is what the notice reports.
    const refused = await register({
      token,
      wantsMachineCredential: true,
      hostname: "third-agent",
    });
    expect(refused.statusCode).toBe(401);
    const after = warn.mock.calls.filter(([, msg]) =>
      String(msg).includes("live machine identity"),
    );
    expect(after.map(([, msg]) => msg)).toEqual([REFUSAL_MESSAGE, REFUSAL_MESSAGE]);
  });

  it("answers a refused claim exactly like an unknown token", async () => {
    const created = await createHostRow("indistinguishable");
    await register({
      token: created.token,
      wantsMachineCredential: true,
      hostname: "the-real-agent",
    });

    const refused = await register({
      token: created.token,
      wantsMachineCredential: true,
      hostname: "the-thief",
    });
    const unknown = await register({
      token: "no-such-token-3439",
      wantsMachineCredential: true,
      hostname: "the-thief",
    });

    expect(refused.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(refused.statusCode).toBe(unknown.statusCode);
    expect(refused.body).toBe(unknown.body);
    expect(refused.headers["content-type"]).toBe(unknown.headers["content-type"]);
  });
});
