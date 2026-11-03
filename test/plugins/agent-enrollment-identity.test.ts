import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { identityStatePath, loadAgentIdentity } from "../../src/services/agent-identity.js";

// Issue #2568 — the agent persists {hostId, machineCredential} and
// re-registers by identity, never silently falling back to the bootstrap token.
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

const registered = (extra: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    host_id: "host-1",
    session_id: "sess-1",
    session_secret: "secret-1", // pragma: allowlist secret
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  });

describe("agentEnrollmentPlugin machine identity", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sessionsDir: string;
  let statePath: string;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-identity-plugin-"));
    statePath = identityStatePath(sessionsDir);
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_PRIMARY_URL = "http://primary.invalid";
    process.env.MULLION_ENROLLMENT_TOKEN = "bootstrap-secret";
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    for (const key of [
      "MULLION_ROLE",
      "MULLION_PRIMARY_URL",
      "MULLION_ENROLLMENT_TOKEN",
      "PROJECTS_ROOTS",
      "SESSIONS_DIR",
    ]) {
      delete process.env[key];
    }
  });

  it("asks for a credential on first registration and persists it 0600", async () => {
    fetchMock.mockResolvedValue(registered({ machine_credential: "a1".repeat(32) }));
    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => loadAgentIdentity(statePath) !== null);
      expect(loadAgentIdentity(statePath)).toEqual({
        hostId: "host-1",
        machineCredential: "a1".repeat(32),
      });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.token).toBe("bootstrap-secret");
      expect(body.wantsMachineCredential).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      await app.close();
    }
  });

  it("re-registers with the stored identity, not the bootstrap token, and keeps the rotated credential", async () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ hostId: "host-1", machineCredential: "a1".repeat(32) }),
    );
    fetchMock.mockResolvedValue(registered({ machine_credential: "b2".repeat(32) }));
    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => loadAgentIdentity(statePath)?.machineCredential === "b2".repeat(32));
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toMatchObject({ hostId: "host-1", machineCredential: "a1".repeat(32) });
      expect(body.token).toBeUndefined();
      expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain("bootstrap-secret");
    } finally {
      await app.close();
    }
  });

  it("does not fall back to the bootstrap token when the identity is rejected", async () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ hostId: "host-1", machineCredential: "a1".repeat(32) }),
    );
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "machine credential rejected" }));
    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => fetchMock.mock.calls.length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(app.agentSession).toBeUndefined();
      // The state file is left for the operator to clear.
      expect(loadAgentIdentity(statePath)).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("works against a primary that issues no credential (no state file written)", async () => {
    fetchMock.mockResolvedValue(registered());
    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      expect(fs.existsSync(statePath)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
