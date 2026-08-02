import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  signAppJwt,
  listInstallations,
  mintInstallationToken,
  resolveInstallationId,
  getInstallationToken,
  clearInstallationTokenCacheForTests,
  GitHubAppError,
} from "../../src/services/github-app.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A fresh, disposable RSA keypair generated per test run — never a
// checked-in fixture (a PEM in the repo would trip detect-secrets in
// pre-commit/CI and force a .secrets.baseline update for no real key
// material).
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

function verifyJwt(jwt: string): { header: unknown; payload: Record<string, unknown> } {
  const [headerB64, payloadB64, sigB64] = jwt.split(".");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(sigB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature);
  expect(ok).toBe(true);
  const decode = (b64: string) =>
    JSON.parse(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return { header: decode(headerB64), payload: decode(payloadB64) };
}

describe("github-app (#489)", () => {
  beforeEach(() => {
    clearInstallationTokenCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("signAppJwt", () => {
    it("produces a JWT with the correct header/claims, verifiable with the public key", () => {
      const jwt = signAppJwt("12345", privateKey);
      const { header, payload } = verifyJwt(jwt);
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(payload.iss).toBe("12345");
      expect(typeof payload.iat).toBe("number");
      expect(typeof payload.exp).toBe("number");
      expect((payload.exp as number) - (payload.iat as number)).toBeGreaterThan(0);
      // iat is backdated ~60s for clock-skew tolerance.
      expect(payload.iat as number).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 59);
    });

    it("throws a GitHubAppError (not the raw crypto error) for an invalid key", () => {
      expect(() => signAppJwt("12345", "not a real key")).toThrow(GitHubAppError);
    });
  });

  describe("listInstallations", () => {
    it("returns installations with an account login, filtering out those without one", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, [
            { id: 1, account: { login: "acme" } },
            { id: 2, account: { login: "widgets-inc" } },
            { id: 3 },
          ]),
        );
      vi.stubGlobal("fetch", fetchMock);
      const result = await listInstallations("fake.jwt.token");
      expect(result).toEqual([
        { id: 1, login: "acme" },
        { id: 2, login: "widgets-inc" },
      ]);
    });

    it("throws GitHubAppError on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, {})));
      await expect(listInstallations("fake.jwt.token")).rejects.toThrow(GitHubAppError);
    });
  });

  describe("resolveInstallationId", () => {
    it("matches an owner login case-insensitively", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(200, [{ id: 7, account: { login: "Acme" } }])),
      );
      expect(await resolveInstallationId("fake.jwt.token", "acme")).toBe(7);
    });

    it("returns null when no installation matches", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(jsonResponse(200, [{ id: 7, account: { login: "someone-else" } }])),
      );
      expect(await resolveInstallationId("fake.jwt.token", "acme")).toBeNull();
    });
  });

  describe("mintInstallationToken", () => {
    it("narrows the request to exactly one repo and the minimum permission set", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { token: "ghs_abc", expires_at: "2026-01-01T01:00:00Z" }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const result = await mintInstallationToken("fake.jwt.token", 7, "acme/widgets");
      expect(result).toEqual({ token: "ghs_abc", expiresAt: new Date("2026-01-01T01:00:00Z") });
      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.repositories).toEqual(["acme/widgets"]);
      expect(body.permissions).toEqual({
        issues: "write",
        pull_requests: "write",
        contents: "write",
      });
    });

    it("throws GitHubAppError on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, {})));
      await expect(mintInstallationToken("fake.jwt.token", 7, "acme/widgets")).rejects.toThrow(
        GitHubAppError,
      );
    });
  });

  describe("getInstallationToken", () => {
    it("mints a fresh token end-to-end and caches it for a repeat call", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        return Promise.resolve(
          jsonResponse(200, { token: "ghs_fresh", expires_at: "2099-01-01T01:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const first = await getInstallationToken("123", privateKey, "acme", "widgets");
      expect(first).toBe("ghs_fresh");
      const callsAfterFirst = fetchMock.mock.calls.length;

      const second = await getInstallationToken("123", privateKey, "acme", "widgets");
      expect(second).toBe("ghs_fresh");
      // Cached — no new fetch calls for the repeat.
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it("returns null when the App has no installation covering the owner", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(jsonResponse(200, [{ id: 9, account: { login: "someone-else" } }])),
      );
      expect(await getInstallationToken("123", privateKey, "acme", "widgets")).toBeNull();
    });

    it("re-mints once the cached token is within the safety margin of expiring", async () => {
      let mintCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintCount++;
        // Expires in 30s — inside the 60s safety margin, so a second call
        // must re-mint rather than reuse this one.
        const expiresAt = new Date(Date.now() + 30_000).toISOString();
        return Promise.resolve(
          jsonResponse(200, { token: `ghs_${mintCount}`, expires_at: expiresAt }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await getInstallationToken("123", privateKey, "acme", "widgets");
      await getInstallationToken("123", privateKey, "acme", "widgets");
      expect(mintCount).toBe(2);
    });
  });
});
