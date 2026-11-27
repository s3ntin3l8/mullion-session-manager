import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";
import { hosts } from "../../src/db/schema.js";
import { createPairedHost, revokeMachineIdentity } from "../../src/services/host-registry.js";

// Issue #3476 — existing legacy host rows remain flagged (HostSummary.deprecatedKind)
// even after the legacy entry points are removed (#3535).
describe("GET /api/hosts: the legacy host kinds are flagged (issue #3476)", () => {
  it("flags a legacy agent and a manual-token host, and nothing on a host with a live identity", async () => {
    const app = await buildApp();
    try {
      // A legacy agent: existing enrolled row with no machine identity,
      // so the primary has to dial it at the address it stored.
      const legacyId = crypto.randomUUID();
      app.db
        .insert(hosts)
        .values({
          id: legacyId,
          name: "legacy-agent",
          baseUrl: "http://127.0.0.1:4741",
          authTokenEnc: null,
          origin: "enrolled",
          approvedAt: new Date(),
        })
        .run();

      // A manual-token host: existing row with its own static token (the
      // agent's MULLION_AGENT_TOKEN) and the address the primary dials it at.
      const manualId = crypto.randomUUID();
      app.db
        .insert(hosts)
        .values({
          id: manualId,
          name: "manual-token",
          baseUrl: "http://127.0.0.1:4742",
          authTokenEnc: app.encryption.encryptString("manual-tok"),
          origin: "manual",
          approvedAt: new Date(),
        })
        .run();

      // A host with a live machine identity: the current path.
      const paired = createPairedHost(app, {
        baseUrl: "http://127.0.0.1:4743",
        hostname: "paired-agent",
      });

      const list = (await app.inject({ method: "GET", url: "/api/hosts" })).json() as {
        id: string;
        legacyAgent: boolean;
        deprecatedKind: string | null;
      }[];
      const byId = (id: string) => list.find((h) => h.id === id)!;

      expect(byId(legacyId).deprecatedKind).toBe("legacy-agent");
      expect(byId(legacyId).legacyAgent).toBe(true);

      // The kind names the CREDENTIAL path: a manual-token host is dialled
      // by address too (legacyAgent is true), but what it authenticates with
      // is the row's own static token.
      expect(byId(manualId).deprecatedKind).toBe("manual-token");
      expect(byId(manualId).legacyAgent).toBe(true);

      expect(byId(paired.hostId).deprecatedKind).toBeNull();
      // The primary is never a legacy host.
      expect(byId("local").deprecatedKind).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("changes nothing about a legacy host: it is still listed, and still editable", async () => {
    const app = await buildApp();
    try {
      const legacyId = crypto.randomUUID();
      app.db
        .insert(hosts)
        .values({
          id: legacyId,
          name: "still-works",
          baseUrl: "http://127.0.0.1:4744",
          authTokenEnc: null,
          origin: "enrolled",
          approvedAt: new Date(),
        })
        .run();
      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/hosts/${legacyId}`,
        payload: { name: "renamed" },
      });
      expect(renamed.statusCode).toBe(200);
      expect((renamed.json() as { name: string }).name).toBe("renamed");
      expect((renamed.json() as { deprecatedKind: string | null }).deprecatedKind).toBe(
        "legacy-agent",
      );

      const list = (await app.inject({ method: "GET", url: "/api/hosts" })).json() as {
        id: string;
      }[];
      expect(list.some((h) => h.id === legacyId)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("does not flag a revoked host: it needs a re-pair, not a legacy credential", async () => {
    const app = await buildApp();
    try {
      // An outbound-only paired host: no address to dial, an identity of its
      // own. Revoking the identity leaves a row with neither a token nor an
      // address — a host that is waiting for a re-pair, not one on a legacy
      // credential path.
      const paired = createPairedHost(app, {
        hostname: "revoked-outbound",
      });
      expect(revokeMachineIdentity(app, paired.hostId)).toBe(true);

      const list = (await app.inject({ method: "GET", url: "/api/hosts" })).json() as {
        id: string;
        deprecatedKind: string | null;
      }[];
      expect(list.find((h) => h.id === paired.hostId)!.deprecatedKind).toBeNull();
    } finally {
      await app.close();
    }
  });
});
