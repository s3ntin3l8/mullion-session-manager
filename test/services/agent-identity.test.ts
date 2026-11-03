import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
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
    await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c1" });
    expect(loadAgentIdentity(file)).toEqual({ hostId: "h1", machineCredential: "c1" });
  });

  it.skipIf(process.platform === "win32")("is not readable by others (0600)", async () => {
    // A permissive umask must not widen it.
    const previous = process.umask(0o000);
    try {
      await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c1" });
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces atomically, leaving no temp file behind", async () => {
    await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c1" });
    await saveAgentIdentity(file, { hostId: "h1", machineCredential: "c2" });
    expect(loadAgentIdentity(file)?.machineCredential).toBe("c2");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("treats a corrupt or incomplete file as absent", () => {
    fs.writeFileSync(file, "{not json");
    expect(loadAgentIdentity(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ hostId: "h1" }));
    expect(loadAgentIdentity(file)).toBeNull();
  });
});
