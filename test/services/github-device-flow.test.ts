import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { getIntegration, getToken } from "../../src/services/github-integration.js";
import {
  DeviceFlowError,
  getDeviceFlowIntervalMsForTests,
  getDeviceFlowStatus,
  pollDeviceFlowOnceForTests,
  resetDeviceFlowForTests,
  startDeviceFlow,
} from "../../src/services/github-device-flow.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEVICE_CODE_RESPONSE = {
  device_code: "device-code-abc",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

const tmpDb = path.join(os.tmpdir(), `github-device-flow-test-${process.pid}.db`);

describe("github-device-flow service", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.GITHUB_OAUTH_CLIENT_ID = "Iv1.test-client-id";
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    resetDeviceFlowForTests();
    vi.unstubAllGlobals();
    const app = await buildApp();
    const { disconnect } = await import("../../src/services/github-integration.js");
    disconnect(app);
    await app.close();
  });

  it("throws DeviceFlowError when no GITHUB_OAUTH_CLIENT_ID is configured", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    const app = await buildApp();
    await expect(startDeviceFlow(app)).rejects.toThrow(DeviceFlowError);
    process.env.GITHUB_OAUTH_CLIENT_ID = "Iv1.test-client-id";
    await app.close();
  });

  it("starts a pending attempt and surfaces user_code/verification_uri", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    const summary = await startDeviceFlow(app);
    expect(summary).toEqual({
      status: "pending",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
    expect(getDeviceFlowStatus()).toEqual(summary);
    await app.close();
  });

  it("never exposes device_code — only user_code/verification_uri/status", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    const summary = await startDeviceFlow(app);
    expect(JSON.stringify(summary)).not.toContain("device-code-abc");
    await app.close();
  });

  it("throws DeviceFlowError when GitHub rejects the device-code request", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "bad request" }));
    const app = await buildApp();
    await expect(startDeviceFlow(app)).rejects.toThrow(DeviceFlowError);
    await app.close();
  });

  it("throws DeviceFlowError when GitHub is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const app = await buildApp();
    await expect(startDeviceFlow(app)).rejects.toThrow(DeviceFlowError);
    await app.close();
  });

  it("stays pending on authorization_pending", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "authorization_pending" }));
    await pollDeviceFlowOnceForTests(app);
    expect(getDeviceFlowStatus()?.status).toBe("pending");
    await app.close();
  });

  it("stays pending on slow_down, without erroring", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "slow_down", interval: 10 }));
    await pollDeviceFlowOnceForTests(app);
    expect(getDeviceFlowStatus()?.status).toBe("pending");
    await app.close();
  });

  it("replaces (not adds to) the poll interval on slow_down, per RFC 8628", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE)); // interval: 5
    const app = await buildApp();
    await startDeviceFlow(app);
    expect(getDeviceFlowIntervalMsForTests()).toBe(5000);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "slow_down", interval: 10 }));
    await pollDeviceFlowOnceForTests(app);
    // Not 5000 + 10000 — the old additive bug would grow this unboundedly
    // across repeated slow_downs.
    expect(getDeviceFlowIntervalMsForTests()).toBe(10000);
    await app.close();
  });

  it("falls back to intervalMs + 5s on a slow_down with no interval field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE)); // interval: 5
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "slow_down" }));
    await pollDeviceFlowOnceForTests(app);
    expect(getDeviceFlowIntervalMsForTests()).toBe(10000); // 5s + 5s
    await app.close();
  });

  it("moves to expired once past expiresAt, without polling GitHub again", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ...DEVICE_CODE_RESPONSE, expires_in: 1 }));
    const app = await buildApp();
    await startDeviceFlow(app);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    await pollDeviceFlowOnceForTests(app);

    expect(getDeviceFlowStatus()?.status).toBe("expired");
    // The expiry check short-circuits before making another request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await app.close();
  });

  it("connects on a successful token exchange, persisting it as tokenType oauth", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: "gho_device_flow_token" }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { login: "octocat" }));
    await pollDeviceFlowOnceForTests(app);

    expect(getDeviceFlowStatus()?.status).toBe("connected");
    const summary = getIntegration(app);
    expect(summary).toEqual(
      expect.objectContaining({ connected: true, tokenType: "oauth", login: "octocat" }),
    );
    expect(getToken(app)).toBe("gho_device_flow_token");
    await app.close();
  });

  it("moves to error if the token exchange succeeds but persisting it fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: "gho_device_flow_token" }));
    // The GET /user call setOAuthToken makes to resolve login/scopes fails.
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await pollDeviceFlowOnceForTests(app);

    expect(getDeviceFlowStatus()).toEqual(
      expect.objectContaining({ status: "error", errorMessage: expect.any(String) }),
    );
    expect(getIntegration(app).connected).toBe(false);
    await app.close();
  });

  it("retries on the same schedule if GitHub's poll response isn't valid JSON", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await pollDeviceFlowOnceForTests(app);
    // Not moved to "error" — just stays pending, waiting for the next
    // scheduled poll (see pollOnce's json-parse-failure catch).
    expect(getDeviceFlowStatus()?.status).toBe("pending");
    await app.close();
  });

  it("moves to expired on expired_token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "expired_token" }));
    await pollDeviceFlowOnceForTests(app);
    expect(getDeviceFlowStatus()?.status).toBe("expired");
    await app.close();
  });

  it("moves to denied on access_denied", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { error: "access_denied" }));
    await pollDeviceFlowOnceForTests(app);
    expect(getDeviceFlowStatus()?.status).toBe("denied");
    await app.close();
  });

  it("moves to error with a message on an unrecognized error code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { error: "incorrect_client_credentials", error_description: "bad client" }),
    );
    await pollDeviceFlowOnceForTests(app);
    expect(getDeviceFlowStatus()).toEqual(
      expect.objectContaining({ status: "error", errorMessage: "bad client" }),
    );
    await app.close();
  });

  it("a new startDeviceFlow supersedes a previous pending attempt", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, DEVICE_CODE_RESPONSE));
    const app = await buildApp();
    await startDeviceFlow(app);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ...DEVICE_CODE_RESPONSE, user_code: "WXYZ-9999" }),
    );
    const second = await startDeviceFlow(app);
    expect(second.userCode).toBe("WXYZ-9999");
    expect(getDeviceFlowStatus()?.userCode).toBe("WXYZ-9999");
    await app.close();
  });

  it("getDeviceFlowStatus returns null with no attempt in progress", () => {
    expect(getDeviceFlowStatus()).toBeNull();
  });
});
