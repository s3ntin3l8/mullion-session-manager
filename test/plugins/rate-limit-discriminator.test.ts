import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestApp } from "../helpers/app.js";

// Issue #1006 — frontend/src/api/client.ts's 429 breaker widens to a global
// gate only when a response's `x-ratelimit-limit` header equals the
// server's global max (app.config.RATE_LIMIT_MAX, security.ts). That
// discriminator only works if no per-route rate-limit max ever equals the
// global max — otherwise a route-scoped 429 (e.g. the 10/min login limiter,
// auth.ts's LOGIN_RATE_LIMIT) would be misread as a global one and freeze
// the whole dashboard for up to a minute. This scans src/ for every
// `{ max: N, timeWindow: ... }` shape — both inline (e.g. projects.ts's
// `config: { rateLimit: { max: 30, timeWindow: "1 minute" } }`) and
// hoisted-to-a-named-const (e.g. auth.ts's
// `const LOGIN_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };`, applied
// elsewhere as `config: { rateLimit: LOGIN_RATE_LIMIT }`) — since anchoring
// on a literal `rateLimit: { max:` prefix alone misses every named-const
// site. Pins the invariant so a future per-route limiter accidentally set
// to the default global max (100) fails loudly here instead of silently
// breaking the frontend gate.

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));

function findPerRouteRateLimitMaxes(dir: string): { file: string; max: number }[] {
  const results: { file: string; max: number }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPerRouteRateLimitMaxes(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const content = fs.readFileSync(full, "utf8");
    for (const match of content.matchAll(/max:\s*(\d+)\s*,\s*timeWindow:/g)) {
      results.push({ file: full, max: Number(match[1]) });
    }
  }
  return results;
}

describe("per-route rate-limit max never collides with the global max", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_MAX;
  });

  it("no literal per-route config.rateLimit.max equals app.config.RATE_LIMIT_MAX", async () => {
    const app = await buildTestApp();
    const globalMax = app.config.RATE_LIMIT_MAX;

    const perRouteMaxes = findPerRouteRateLimitMaxes(srcDir);
    // Sanity check the scan itself found real route-level limiters — an
    // empty (or suspiciously small) result would make this test vacuously
    // pass if the scan regex ever stopped matching (e.g. after a formatting
    // change). 51 as of this writing, comfortably above both shapes' counts.
    expect(perRouteMaxes.length).toBeGreaterThan(40);

    const colliding = perRouteMaxes.filter((entry) => entry.max === globalMax);
    expect(colliding).toEqual([]);
  });

  it("x-ratelimit-limit reflects the ACTUAL bucket a response came from — a route's own config.rateLimit replaces the global one, not just adds to it", async () => {
    // The frontend discriminator's whole premise is that this header tells
    // you which bucket answered: security.ts's global limiter for a route
    // with no override, or that route's own `config.rateLimit` for one that
    // has it (@fastify/rate-limit — a per-route `config.rateLimit` REPLACES
    // the global limiter for that route, per projects.ts's own comment on
    // this). Proven end to end here, no 429 needed — the header is sent on
    // every response, success included (@fastify/rate-limit's addHeaders
    // default).
    process.env.RATE_LIMIT_MAX = "2";
    const app = await buildTestApp();

    const globalBucketRes = await app.inject({ method: "GET", url: "/health" });
    // /api/skills carries skills.ts's own SKILLS_RATE_LIMIT (max: 30),
    // distinct from the global max configured above.
    const perRouteBucketRes = await app.inject({ method: "GET", url: "/api/skills" });

    expect(globalBucketRes.headers["x-ratelimit-limit"]).toBe("2");
    expect(perRouteBucketRes.headers["x-ratelimit-limit"]).toBe("30");
  });

  it("x-ratelimit-limit is still present on the 429 response itself, not just under-limit ones", async () => {
    // @fastify/rate-limit gates this via two independently-defaulted
    // options — addHeadersOnExceeding (under-limit responses) and
    // addHeaders (the 429 itself). The test above only proves the former;
    // client.ts's isGlobalBucket check reads the header off the 429
    // response specifically, so that's the one this pins.
    process.env.RATE_LIMIT_MAX = "2";
    const app = await buildTestApp();

    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/health" });
    const thirdRes = await app.inject({ method: "GET", url: "/health" });

    expect(thirdRes.statusCode).toBe(429);
    expect(thirdRes.headers["x-ratelimit-limit"]).toBe("2");
  });
});
