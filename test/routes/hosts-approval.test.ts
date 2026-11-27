import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import {
  claimHost,
  getHostRow,
  isHostIdApproved,
  listHosts,
} from "../../src/services/host-registry.js";
import {
  resolveExecutionContext,
  executionContextErrorStatus,
} from "../../src/services/execution-context.js";
import { resolvePlacement, resolveTargetHost } from "../../src/services/placement.js";
import { allowedSpawnTargets } from "../../src/plugins/control-socket-support.js";
import { getRemoteHostClient } from "../../src/services/remote-host-client.js";
import { HostAwaitingApprovalError } from "../../src/services/remote-host-errors.js";
import { openStreamOnTransport } from "../../src/services/agent-channel-streams.js";
import { AGENT_CHANNEL_PATH } from "../../src/shared/agent-channel.js";
import WebSocket from "ws";

const tmpDb = path.join(os.tmpdir(), `hosts-approval-test-${process.pid}.db`);

describe("host approval gate (issue #3441)", () => {
  let app: FastifyInstance;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  beforeEach(async () => {
    app = await buildApp();
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).where(eq(hosts.origin, "enrolled")).run();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("approves claimHost, operator pairing, and non-requireApproval token pairing immediately", async () => {
    const toClaimId = crypto.randomUUID();
    app.db
      .insert(hosts)
      .values({
        id: toClaimId,
        name: "claim-1",
        authTokenEnc: app.encryption.encryptString("tok-claim-1"),
        origin: "manual",
        approvedAt: null,
      })
      .run();
    const claimed = claimHost(app, "tok-claim-1", { hostname: "claimed-box" }, "10.0.0.2");
    expect(claimed).not.toBeNull();
    expect(getHostRow(app, toClaimId)!.approvedAt).not.toBeNull();

    // Operator-minted pairing code
    const opMint = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: { host: "primary.test:4000" },
      payload: { label: "op-paired" },
    });
    expect(opMint.statusCode).toBe(200);
    const opRedeem = await app.inject({
      method: "POST",
      url: "/api/internal/pair",
      payload: {
        code: (opMint.json() as { code: string }).code,
        requestId: "req-op-1",
        hostname: "op-box",
      },
    });
    expect(opRedeem.statusCode).toBe(200);
    const opHostId = (opRedeem.json() as { host_id: string }).host_id;
    expect(listHosts(app).find((h) => h.id === opHostId)!.approvalPending).toBe(false);

    // Automation token WITHOUT requireApproval
    const tokRes = await app.inject({
      method: "POST",
      url: "/api/automation-tokens",
      payload: { label: "ci-no-approval", scopes: ["enroll"], requireApproval: false },
    });
    expect(tokRes.statusCode).toBe(201);
    const token = (tokRes.json() as { token: string }).token;
    const autoMint = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: { authorization: `Bearer ${token}`, host: "primary.test:4000" },
      payload: { label: "auto-approved" },
    });
    expect(autoMint.statusCode).toBe(200);
    const autoRedeem = await app.inject({
      method: "POST",
      url: "/api/internal/pair",
      payload: {
        code: (autoMint.json() as { code: string }).code,
        requestId: "req-auto-1",
        hostname: "auto-box",
      },
    });
    expect(autoRedeem.statusCode).toBe(200);
    const autoHostId = (autoRedeem.json() as { host_id: string }).host_id;
    expect(listHosts(app).find((h) => h.id === autoHostId)!.approvalPending).toBe(false);
  });

  it("holds requireApproval token pairing pending, blocks placement/targets/dispatch with 409, allows renewal, and approves/rejects", async () => {
    const tokRes = await app.inject({
      method: "POST",
      url: "/api/automation-tokens",
      payload: { label: "ci-approval", scopes: ["enroll"], requireApproval: true },
    });
    expect(tokRes.statusCode).toBe(201);
    const token = (tokRes.json() as { token: string }).token;

    const mintRes = await app.inject({
      method: "POST",
      url: "/api/host-pairings",
      headers: { authorization: `Bearer ${token}`, host: "primary.test:4000" },
      payload: { label: "pending-worker" },
    });
    expect(mintRes.statusCode).toBe(200);

    const redeemRes = await app.inject({
      method: "POST",
      url: "/api/internal/pair",
      remoteAddress: "10.0.0.77",
      payload: {
        code: (mintRes.json() as { code: string }).code,
        requestId: "req-pending-1",
        hostname: "pending-box",
      },
    });
    expect(redeemRes.statusCode).toBe(200);
    const { host_id: hostId, machine_credential: machineCredential } = redeemRes.json() as {
      host_id: string;
      machine_credential: string;
    };

    // GET /api/hosts shows approvalPending: true and enrollmentPeer from identity events
    const listRes = await app.inject({ method: "GET", url: "/api/hosts" });
    expect(listRes.statusCode).toBe(200);
    const listItem = (
      listRes.json() as { id: string; approvalPending: boolean; enrollmentPeer: string | null }[]
    ).find((h) => h.id === hostId)!;
    expect(listItem.approvalPending).toBe(true);
    expect(listItem.enrollmentPeer).toBe("10.0.0.77");

    // Excluded from placement (auto and targeted)
    const [targetProject] = app.db
      .insert(projects)
      .values({
        name: "remote-proj",
        cwd: "/srv/remote-proj",
        hostId,
        placement: "auto",
      })
      .returning()
      .all();

    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(
      hostId,
      {
        platform: "linux",
        logicalCores: 4,
        loadAverage1m: 0,
        memory: { totalBytes: 8e9, freeBytes: 4e9 },
        sessions: { tracked: 0, alive: 0 },
      },
      Date.now(),
    );

    const autoDecision = resolvePlacement(app, {
      project: {
        hostId: "local",
        placement: "auto",
        cwd: process.cwd(),
        hostCwds: JSON.stringify({ [hostId]: "/srv/remote-proj" }),
      },
      unattended: false,
    });
    expect(
      autoDecision.excluded.some((e) => e.hostId === hostId && e.reason === "awaiting approval"),
    ).toBe(true);
    expect(autoDecision.hostId).not.toBe(hostId);

    const targetedDecision = resolveTargetHost(app, {
      project: { hostId, placement: "pinned", cwd: "/srv/remote-proj" },
      target: { hostId },
      unattended: false,
    });
    expect(targetedDecision.ok).toBe(false);

    // Excluded from allowedSpawnTargets (behind list_spawn_targets)
    const [coordProject] = app.db
      .insert(projects)
      .values({
        name: "coord-proj",
        cwd: process.cwd(),
        hostId: "local",
        allowCrossProjectSpawn: true,
      })
      .returning()
      .all();
    expect(allowedSpawnTargets(app, coordProject).some((p) => p.id === targetProject.id)).toBe(
      false,
    );

    // Execution-context resolver fails with 409 host_awaiting_approval
    const ctxResult = await resolveExecutionContext(app, {
      projectId: targetProject.id,
      projectDefault: true,
    });
    expect(ctxResult.ok).toBe(false);
    if (!ctxResult.ok) {
      expect(ctxResult.error.code).toBe("host_awaiting_approval");
      expect(executionContextErrorStatus(ctxResult.error.code)).toBe(409);
      expect(ctxResult.error.message).toBe("host is awaiting approval");
    }

    // Direct spawn targeting it fails with 409 "host is awaiting approval"
    const spawnRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        projectId: targetProject.id,
        command: "bash",
        target: { hostId },
      },
    });
    expect(spawnRes.statusCode).toBe(409);
    expect((spawnRes.json() as { message: string }).message).toBe("host is awaiting approval");

    // Direct host config route fails with 409 "host is awaiting approval"
    const cfgRes = await app.inject({ method: "GET", url: `/api/hosts/${hostId}/config` });
    expect(cfgRes.statusCode).toBe(409);
    expect((cfgRes.json() as { message: string }).message).toBe("host is awaiting approval");

    // RemoteHostTransport.request() fails with HostAwaitingApprovalError (409)
    await expect(getRemoteHostClient(app, hostId).resolveConfig()).rejects.toThrow(
      HostAwaitingApprovalError,
    );

    // Agent can still renew its session without approving itself
    const renewRes = await app.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        hostId,
        machineCredential,
        hostname: "pending-box",
      },
    });
    expect(renewRes.statusCode).toBe(200);
    expect(getHostRow(app, hostId)!.approvedAt).toBeNull();

    // Agent can connect its outbound channel without approving itself, and stream open is refused
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}${AGENT_CHANNEL_PATH}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "auth",
            hostId,
            credential:
              (renewRes.json() as { machine_credential?: string }).machine_credential ??
              machineCredential,
            protocol: {
              protocolVersion: 1,
              operations: ["channel-requests", "channel-streams"],
              launchOptions: [],
            },
          }),
        );
      });
      ws.once("message", (data) => {
        const frame = JSON.parse(data.toString()) as { type: string };
        if (frame.type === "ready") resolve();
        else reject(new Error(`unexpected frame: ${data.toString()}`));
      });
      ws.once("error", reject);
    });
    expect(getHostRow(app, hostId)!.approvedAt).toBeNull();
    expect(app.agentChannels.has(hostId)).toBe(true);

    // Probe reports "ok" over connected channel while pending
    expect(await getRemoteHostClient(app, hostId).probe()).toBe("ok");

    // Stream open over channel fails for unapproved host
    const streamSock = openStreamOnTransport(
      app,
      { kind: "channel", channel: app.agentChannels.get(hostId)! },
      "events",
      "test",
    );
    expect(streamSock).not.toBeNull();
    await new Promise<void>((resolve) => {
      streamSock!.once("error", (err) => {
        expect(err.message).toBe("host is awaiting approval");
        resolve();
      });
    });

    ws.close();

    // Approve makes it eligible; second approve returns 409
    const approveRes = await app.inject({ method: "POST", url: `/api/hosts/${hostId}/approve` });
    expect(approveRes.statusCode).toBe(200);
    expect(getHostRow(app, hostId)!.approvedAt).not.toBeNull();
    expect(allowedSpawnTargets(app, coordProject).some((p) => p.id === targetProject.id)).toBe(
      true,
    );
    const approveAgain = await app.inject({ method: "POST", url: `/api/hosts/${hostId}/approve` });
    expect(approveAgain.statusCode).toBe(409);

    // Local host approve returns 409
    const approveLocal = await app.inject({ method: "POST", url: "/api/hosts/local/approve" });
    expect(approveLocal.statusCode).toBe(409);
  });

  it("fails closed for unknown hostIds and bare db.insert(hosts) without approvedAt", () => {
    expect(isHostIdApproved(app, "nonexistent-host-id")).toBe(false);
    app.db.insert(hosts).values({ id: "bare-insert", name: "bare-insert" }).run();
    const row = getHostRow(app, "bare-insert")!;
    expect(row.approvedAt).toBeNull();
    expect(isHostIdApproved(app, "bare-insert")).toBe(false);
  });
});
