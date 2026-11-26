import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { enrollHost, revokeMachineIdentity } from "../../src/services/host-registry.js";

// Issue #3476 — the legacy host kinds are FLAGGED, not refused. This issue
// only produces the signal (HostSummary.deprecatedKind) and says so in the
// UI; the gate that refuses NEW legacy hosts (MULLION_ALLOW_LEGACY_HOSTS,
// issue #3477) and the removal are separate issues — a flagged host keeps
// working either way.
describe("GET /api/hosts: the legacy host kinds are flagged (issue #3476)", () => {
  it("flags a legacy agent and a manual-token host, and nothing on a host with a live identity", async () => {
    const app = await buildApp();
    try {
      // A legacy agent: enrolled with the fleet secret, no machine identity,
      // so the primary has to dial it at the address it stored.
      const legacy = enrollHost(app, {
        baseUrl: "http://127.0.0.1:4741",
        hostname: "legacy-agent",
      });

      // A manual-token host: added by hand, with its own static token (the
      // agent's MULLION_AGENT_TOKEN) and the address the primary dials it
      // at.
      const manual = (
        await app.inject({
          method: "POST",
          url: "/api/hosts",
          payload: { name: "manual-token", baseUrl: "http://127.0.0.1:4742" },
        })
      ).json() as { id: string };

      // A host with a live machine identity: the current path.
      const paired = enrollHost(app, {
        baseUrl: "http://127.0.0.1:4743",
        hostname: "paired-agent",
        wantsMachineCredential: true,
      });

      const list = (await app.inject({ method: "GET", url: "/api/hosts" })).json() as {
        id: string;
        legacyAgent: boolean;
        deprecatedKind: string | null;
      }[];
      const byId = (id: string) => list.find((h) => h.id === id)!;

      expect(byId(legacy.hostId).deprecatedKind).toBe("legacy-agent");
      expect(byId(legacy.hostId).legacyAgent).toBe(true);

      // The kind names the CREDENTIAL path: a manual-token host is dialled
      // by address too (legacyAgent is true), but what it authenticates with
      // is the row's own static token.
      expect(byId(manual.id).deprecatedKind).toBe("manual-token");
      expect(byId(manual.id).legacyAgent).toBe(true);

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
      const legacy = enrollHost(app, {
        baseUrl: "http://127.0.0.1:4744",
        hostname: "still-works",
      });
      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/hosts/${legacy.hostId}`,
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
      expect(list.some((h) => h.id === legacy.hostId)).toBe(true);
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
      const paired = enrollHost(app, {
        hostname: "revoked-outbound",
        wantsMachineCredential: true,
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
