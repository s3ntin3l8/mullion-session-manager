import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  signAppJwt,
  listInstallations,
  mintInstallationToken,
  resolveInstallationId,
  getInstallationToken,
  getAuthenticatedApp,
  computeKeyFingerprint,
  clearInstallationTokenCacheForApp,
  clearInstallationTokenCacheForTests,
  getInstallationCacheSizesForTests,
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

    it("wraps a raw network failure into GitHubAppError (Hermes review, PR #504, round 7)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      await expect(listInstallations("fake.jwt.token")).rejects.toThrow(GitHubAppError);
    });
  });

  describe("getAuthenticatedApp (#514)", () => {
    it("returns the App's own id/slug/name from GET /app", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(jsonResponse(200, { id: 12345, slug: "acme-bot", name: "Acme Bot" })),
      );
      const result = await getAuthenticatedApp("fake.jwt.token");
      expect(result).toEqual({ id: 12345, slug: "acme-bot", name: "Acme Bot" });
    });

    it("throws GitHubAppError carrying the status on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, {})));
      const err = await getAuthenticatedApp("fake.jwt.token").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubAppError);
      expect((err as GitHubAppError).status).toBe(401);
    });

    it("wraps a raw network failure into GitHubAppError (same pattern as listInstallations)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      await expect(getAuthenticatedApp("fake.jwt.token")).rejects.toThrow(GitHubAppError);
    });
  });

  describe("computeKeyFingerprint (#514)", () => {
    it("matches an independently-computed SHA-256/base64 fingerprint of the public key", () => {
      // Verified during planning (outside this test suite) to be
      // byte-identical to GitHub's own documented recipe: `openssl rsa -in
      // key.pem -pubout -outform DER | openssl sha256 -binary | openssl
      // base64`. This test guards the implementation against regressing
      // from that algorithm, independent of that one-time cross-check —
      // it recomputes the same sha256(spki-der)/base64 chain from the
      // runtime-generated key above via a separate call path than
      // computeKeyFingerprint itself uses, so a bug in one wouldn't be
      // masked by the same bug in the other.
      const expected = crypto
        .createHash("sha256")
        .update(crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" }))
        .digest("base64");
      expect(computeKeyFingerprint(privateKey)).toBe(expected);
    });

    it("is deterministic across repeat calls for the same key", () => {
      expect(computeKeyFingerprint(privateKey)).toBe(computeKeyFingerprint(privateKey));
    });

    it("differs for a different key", () => {
      const other = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
      });
      expect(computeKeyFingerprint(privateKey)).not.toBe(computeKeyFingerprint(other.privateKey));
    });

    it("throws a GitHubAppError (not the raw crypto error) for an invalid key", () => {
      // Same reasoning as signAppJwt's own equivalent test above — some
      // Node/OpenSSL versions echo key material back into a malformed-key
      // error string, and this function's callers either log the error or
      // could plausibly surface it, so the raw error must never escape.
      expect(() => computeKeyFingerprint("not a real key")).toThrow(GitHubAppError);
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
      const result = await mintInstallationToken("fake.jwt.token", 7, "acme", "widgets");
      expect(result).toEqual({ token: "ghs_abc", expiresAt: new Date("2026-01-01T01:00:00Z") });
      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      // Hermes review, PR #504: GitHub's `repositories` field takes bare
      // repo names, not "owner/repo" — `owner` is already the installation
      // id's own account, fixed by the URL path.
      expect(body.repositories).toEqual(["widgets"]);
      expect(body.permissions).toEqual({
        issues: "write",
        pull_requests: "write",
        contents: "write",
      });
    });

    it("throws GitHubAppError on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, {})));
      await expect(mintInstallationToken("fake.jwt.token", 7, "acme", "widgets")).rejects.toThrow(
        GitHubAppError,
      );
    });

    it("wraps a raw network failure into GitHubAppError (Hermes review, PR #504, round 7)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
      await expect(mintInstallationToken("fake.jwt.token", 7, "acme", "widgets")).rejects.toThrow(
        GitHubAppError,
      );
    });

    it("rejects a malformed owner/repo before ever making a request (CodeQL js/request-forgery)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        mintInstallationToken("fake.jwt.token", 7, "not valid/owner", "widgets"),
      ).rejects.toThrow(/Invalid GitHub owner/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // #489 remaining scope — two permission sets, not one widened one.
    it("requests the read permission set for scope: 'read'", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { token: "ghs_abc", expires_at: "2026-01-01T01:00:00Z" }),
        );
      vi.stubGlobal("fetch", fetchMock);
      await mintInstallationToken("fake.jwt.token", 7, "acme", "widgets", "read");
      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.permissions).toEqual({
        actions: "read",
        metadata: "read",
        pull_requests: "read",
      });
    });

    // #744 — a third permission set for the release-please dispatch trigger.
    // Deliberately its own set, not folded into WRITE_PERMISSIONS: Task
    // Master's ordinary issue/PR/push writes have no business holding
    // `actions: write`.
    it("requests the dispatch permission set for scope: 'dispatch'", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { token: "ghs_abc", expires_at: "2026-01-01T01:00:00Z" }),
        );
      vi.stubGlobal("fetch", fetchMock);
      await mintInstallationToken("fake.jwt.token", 7, "acme", "widgets", "dispatch");
      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.permissions).toEqual({
        actions: "write",
        metadata: "read",
      });
    });

    // #737 — the reviewer App's permission set: only `pull_requests: write`
    // + `metadata: read`, deliberately excluding `issues`/`contents` — this
    // identity only ever submits PR reviews.
    it("requests the review permission set for scope: 'review'", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { token: "ghs_abc", expires_at: "2026-01-01T01:00:00Z" }),
        );
      vi.stubGlobal("fetch", fetchMock);
      await mintInstallationToken("fake.jwt.token", 7, "acme", "widgets", "review");
      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.permissions).toEqual({
        pull_requests: "write",
        metadata: "read",
      });
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
      expect(first.token).toBe("ghs_fresh");
      const callsAfterFirst = fetchMock.mock.calls.length;

      const second = await getInstallationToken("123", privateKey, "acme", "widgets");
      expect(second.token).toBe("ghs_fresh");
      // Cached — no new fetch calls for the repeat.
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it("returns a null token and the checked count when the App has no installation covering the owner (Hermes review, PR #504, round 6)", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(jsonResponse(200, [{ id: 9, account: { login: "someone-else" } }])),
      );
      const result = await getInstallationToken("123", privateKey, "acme", "widgets");
      expect(result.token).toBeNull();
      expect(result.installationsChecked).toBe(1);
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

    it("does not serve a different App's cached token for the same owner/repo (Hermes review, PR #504)", async () => {
      let mintCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintCount++;
        return Promise.resolve(
          jsonResponse(200, { token: `ghs_${mintCount}`, expires_at: "2099-01-01T01:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const first = await getInstallationToken("app-one", privateKey, "acme", "widgets");
      // A different appId, same owner/repo, within the first token's TTL —
      // must mint fresh under the new App rather than reusing app-one's
      // cached token.
      const second = await getInstallationToken("app-two", privateKey, "acme", "widgets");

      expect(first.token).toBe("ghs_1");
      expect(second.token).toBe("ghs_2");
      expect(mintCount).toBe(2);
    });

    // #489 remaining scope — "write" and "read" mint independently and
    // don't share a cache slot, since a single (appId, owner, repo) can
    // legitimately need two live tokens with different permission sets at
    // once.
    it("caches 'write' and 'read' scopes independently for the same owner/repo", async () => {
      let mintCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintCount++;
        return Promise.resolve(
          jsonResponse(200, { token: `ghs_${mintCount}`, expires_at: "2099-01-01T01:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const write1 = await getInstallationToken("123", privateKey, "acme", "widgets", "write");
      const read1 = await getInstallationToken("123", privateKey, "acme", "widgets", "read");
      const write2 = await getInstallationToken("123", privateKey, "acme", "widgets", "write");
      const read2 = await getInstallationToken("123", privateKey, "acme", "widgets", "read");

      expect(write1.token).toBe("ghs_1");
      expect(read1.token).toBe("ghs_2");
      // Both scopes' repeat calls hit their own cache — only 2 real mints.
      expect(write2.token).toBe("ghs_1");
      expect(read2.token).toBe("ghs_2");
      expect(mintCount).toBe(2);
    });

    // #737 — same independence for the fourth flavor: a "review" call for
    // this (appId, owner, repo) must not share a cache slot with (or ever
    // be served instead of) "write".
    it("caches 'review' independently of 'write' for the same owner/repo", async () => {
      let mintCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintCount++;
        return Promise.resolve(
          jsonResponse(200, { token: `ghs_${mintCount}`, expires_at: "2099-01-01T01:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const write = await getInstallationToken("123", privateKey, "acme", "widgets", "write");
      const review = await getInstallationToken("123", privateKey, "acme", "widgets", "review");

      expect(write.token).toBe("ghs_1");
      expect(review.token).toBe("ghs_2");
      expect(mintCount).toBe(2);
    });

    // #489 remaining scope — an App not (yet) re-approved with the
    // actions/metadata permissions "read" needs 422s on every mint
    // attempt; without a negative cache this would re-attempt (and re-fail)
    // that mint on every single call. The first (live) failure still
    // throws — same as any other mint failure — but a repeat call within
    // the negative-cache TTL is served from the cache instead of hitting
    // GitHub again, and resolves gracefully (`token: null`) rather than
    // re-throwing, since by then the failure is a known, confirmed state.
    it("caches a mint failure for the requested scope and stops retrying it", async () => {
      let mintAttempts = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintAttempts++;
        return Promise.resolve(jsonResponse(422, { message: "permissions not granted" }));
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        getInstallationToken("123", privateKey, "acme", "widgets", "read"),
      ).rejects.toThrow(GitHubAppError);
      expect(mintAttempts).toBe(1);

      const second = await getInstallationToken("123", privateKey, "acme", "widgets", "read");
      expect(second.token).toBeNull();
      // No second mint attempt — served from the negative cache.
      expect(mintAttempts).toBe(1);
    });

    // #744 — same negative-cache-then-null posture as the "read" scope
    // above, exercised for "dispatch": an installation not yet re-approved
    // with `actions: write` 422s on the mint, and a repeat call within the
    // TTL is served `token: null` from cache rather than re-attempting.
    // resolveGitHubToken (github-integration.ts) is what turns that null
    // into a PAT fallback — this only verifies the mint/cache half.
    it("caches a mint failure for the 'dispatch' scope and stops retrying it", async () => {
      let mintAttempts = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintAttempts++;
        return Promise.resolve(jsonResponse(422, { message: "permissions not granted" }));
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        getInstallationToken("123", privateKey, "acme", "widgets", "dispatch"),
      ).rejects.toThrow(GitHubAppError);
      expect(mintAttempts).toBe(1);

      const second = await getInstallationToken("123", privateKey, "acme", "widgets", "dispatch");
      expect(second.token).toBeNull();
      expect(mintAttempts).toBe(1);
    });

    // Hermes review, PR #512 — a transient failure (5xx, network error)
    // must NOT be cached the same way an expected 4xx is: caching it for
    // the full hour-long TTL would silently keep every write on the PAT
    // fallback for an hour after a momentary GitHub blip, nullifying the
    // least-privilege point of the App-token path for that whole window.
    it("does not cache a 5xx mint failure — the very next call retries", async () => {
      let mintAttempts = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintAttempts++;
        if (mintAttempts === 1) {
          return Promise.resolve(jsonResponse(503, { message: "GitHub is down" }));
        }
        return Promise.resolve(
          jsonResponse(200, { token: "ghs_recovered", expires_at: "2099-01-01T01:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        getInstallationToken("123", privateKey, "acme", "widgets", "write"),
      ).rejects.toThrow(GitHubAppError);
      expect(mintAttempts).toBe(1);

      // Not served from a negative cache — a real second mint attempt,
      // which succeeds this time.
      const second = await getInstallationToken("123", privateKey, "acme", "widgets", "write");
      expect(second.token).toBe("ghs_recovered");
      expect(mintAttempts).toBe(2);
    });

    // Same principle for a network-level failure (no HTTP response at all,
    // so GitHubAppError.status is undefined) — must not be cached either.
    it("does not cache a network-error mint failure — the very next call retries", async () => {
      let mintAttempts = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintAttempts++;
        if (mintAttempts === 1) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        return Promise.resolve(
          jsonResponse(200, { token: "ghs_recovered", expires_at: "2099-01-01T01:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        getInstallationToken("123", privateKey, "acme", "widgets", "write"),
      ).rejects.toThrow(GitHubAppError);
      expect(mintAttempts).toBe(1);

      const second = await getInstallationToken("123", privateKey, "acme", "widgets", "write");
      expect(second.token).toBe("ghs_recovered");
      expect(mintAttempts).toBe(2);
    });

    it("does not let a cached 'read' failure affect a 'write' mint for the same owner/repo", async () => {
      let writeMints = 0;
      const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        const body = JSON.parse(String(opts?.body)) as { permissions: Record<string, string> };
        if (body.permissions.actions) {
          return Promise.resolve(jsonResponse(422, { message: "permissions not granted" }));
        }
        writeMints++;
        return Promise.resolve(
          jsonResponse(200, { token: "ghs_write", expires_at: "2099-01-01T01:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        getInstallationToken("123", privateKey, "acme", "widgets", "read"),
      ).rejects.toThrow(GitHubAppError);
      const write = await getInstallationToken("123", privateKey, "acme", "widgets", "write");

      expect(write.token).toBe("ghs_write");
      expect(writeMints).toBe(1);
    });
  });

  describe("clearInstallationTokenCacheForApp", () => {
    it("evicts only the given App's cache entries, leaving other Apps' entries intact", async () => {
      let mintCount = 0;
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        mintCount++;
        return Promise.resolve(
          jsonResponse(200, { token: `ghs_${mintCount}`, expires_at: "2099-01-01T01:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await getInstallationToken("app-one", privateKey, "acme", "widgets");
      await getInstallationToken("app-two", privateKey, "acme", "widgets");
      expect(mintCount).toBe(2);

      clearInstallationTokenCacheForApp("app-one");

      // app-one's entry was evicted — a repeat call re-mints.
      await getInstallationToken("app-one", privateKey, "acme", "widgets");
      expect(mintCount).toBe(3);
      // app-two's entry survives — a repeat call is still cached.
      await getInstallationToken("app-two", privateKey, "acme", "widgets");
      expect(mintCount).toBe(3);
    });
  });

  describe("cache pruning (Hermes review, PR #504, round 7)", () => {
    it("sweeps an already-expired token entry for a key that's never revisited", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/app/installations") && !url.includes("access_tokens")) {
          return Promise.resolve(jsonResponse(200, [{ id: 9, account: { login: "acme" } }]));
        }
        // Already expired by the time it's cached — this key is never
        // looked up again, so only the next unrelated cache write's
        // opportunistic prune can remove it.
        return Promise.resolve(
          jsonResponse(200, { token: "ghs_stale", expires_at: "2020-01-01T00:00:00Z" }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      await getInstallationToken("app-one", privateKey, "acme", "widgets");
      expect(getInstallationCacheSizesForTests().tokens).toBe(1);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("/app/installations") && !url.includes("access_tokens")) {
            return Promise.resolve(
              jsonResponse(200, [{ id: 11, account: { login: "widgets-inc" } }]),
            );
          }
          return Promise.resolve(
            jsonResponse(200, { token: "ghs_fresh", expires_at: "2099-01-01T00:00:00Z" }),
          );
        }),
      );
      await getInstallationToken("app-two", privateKey, "widgets-inc", "other-repo");

      // The stale app-one entry was pruned on the write that cached the
      // fresh app-two entry — only one entry survives, not two.
      expect(getInstallationCacheSizesForTests().tokens).toBe(1);
    });
  });
});
