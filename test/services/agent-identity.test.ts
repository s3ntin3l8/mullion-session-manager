import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  agentServesHost,
  identityStatePath,
  loadAgentIdentity,
  saveAgentIdentity,
} from "../../src/services/agent-identity.js";

// Issue #2568 — the agent's persisted {hostId, machineCredential}.
describe("agent identity state file", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-identity-"));
    file = identityStatePath(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips an identity", async () => {
    expect(loadAgentIdentity(file)).toBeNull();
    await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c1".repeat(16) });
    expect(loadAgentIdentity(file)).toEqual({ hostId: "h1", machineCredential: "c1".repeat(16) });
  });

  it.skipIf(process.platform === "win32")("is not readable by others (0600)", async () => {
    // A permissive umask must not widen it.
    const previous = process.umask(0o000);
    try {
      await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c1".repeat(16) });
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses to persist a malformed identity", async () => {
    await expect(
      saveAgentIdentity(file, { hostId: "../h1", machineCredential: "c1".repeat(16) }),
    ).rejects.toThrow(/malformed/);
    await expect(saveAgentIdentity(file, { hostId: "h1", machineCredential: "x" })).rejects.toThrow(
      /malformed/,
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it("replaces atomically, leaving no temp file behind", async () => {
    await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c1".repeat(16) });
    await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c2".repeat(16) });
    expect(loadAgentIdentity(file)?.machineCredential).toBe("c2".repeat(16));
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("treats a corrupt or incomplete file as absent", () => {
    fs.writeFileSync(file, "{not json");
    expect(loadAgentIdentity(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ hostId: "h1" }));
    expect(loadAgentIdentity(file)).toBeNull();
  });

  describe("agentServesHost (#2672)", () => {
    it("fails open, by design, on an agent with no enrolled identity", () => {
      // Nothing to compare against: a legacy/manual deployment accepts the
      // name the primary gave it (documented on agentServesHost).
      expect(agentServesHost(dir, "any-host")).toBe(true);
    });

    it("enforces its own id once enrolled", async () => {
      await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c1".repeat(16) });
      expect(agentServesHost(dir, "h1")).toBe(true);
      expect(agentServesHost(dir, "h2")).toBe(false);
    });
  });
});
