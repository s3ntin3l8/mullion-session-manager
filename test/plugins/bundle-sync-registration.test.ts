import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp } from "../helpers/app.js";

// Issue #1089 (A9) — bundleSyncPlugin's own doc comment (src/plugins/
// bundle-sync.ts) explains why it must be registered on BOTH src/app.ts role
// branches (primary and MULLION_ROLE === "agent"): a primary-only
// registration would silently never sync the bundle on a remote agent host.
// test/plugins/bundle-sync.test.ts proves the plugin's own internal wiring
// (readInjectMullionBundle's app.db-present-vs-absent fallback) against a
// bare `Fastify()` instance, by design (see that file's own header comment
// for why it deliberately avoids buildApp()) — which means NEITHER of
// src/app.ts's two `await app.register(bundleSyncPlugin)` call sites is ever
// exercised by that file. A developer deleting either line would see every
// existing test still pass.
//
// This file closes that gap at the buildApp() level, for both MULLION_ROLE
// values, using `app.hasPlugin("bundle-sync")` — Fastify's own plugin
// registry, independent of whether the plugin's onReady dispatch actually
// fires (it's gated behind a NODE_ENV=test guard specifically so a
// buildApp()-level test never does real filesystem I/O — see that guard's
// own comment) — rather than trying to observe a dispatch that is, by
// design, never going to happen here.
describe("bundleSyncPlugin registration (issue #1089, A9)", () => {
  afterEach(() => {
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
  });

  it("registers on the primary role", async () => {
    const app = await buildTestApp();
    expect(app.config.MULLION_ROLE).toBe("primary");
    expect(app.hasPlugin("bundle-sync")).toBe(true);
  });

  it("registers on the agent role", async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "test-token";
    const app = await buildTestApp();
    expect(app.config.MULLION_ROLE).toBe("agent");
    expect(app.hasPlugin("bundle-sync")).toBe(true);
  });
});
