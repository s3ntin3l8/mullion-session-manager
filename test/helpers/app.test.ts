// Regression test for issue #1481: buildTestApp() must close an app whose
// build was still in flight when the test that started it finished (what a
// test timeout mid-build looks like). The first test starts a build and
// returns without awaiting it; the second then checks that the build was
// closed rather than left holding this file's shared hooks.sock.
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./app.js";

describe("buildTestApp() with a build still in flight when the test finishes (#1481)", () => {
  let inFlight: Promise<FastifyInstance> | undefined;

  it("starts a build and returns without awaiting it", () => {
    inFlight = buildTestApp();
    // Nothing awaits `inFlight` here — the build resolves after this test
    // has already finished.
  });

  it("closed that build instead of leaking its hooks.sock", async () => {
    expect(inFlight).toBeDefined();
    const app = await inFlight!;
    expect(
      fs.existsSync(app.pty.hookSocketPath),
      `hooks.sock still exists after the in-flight build's test finished: ${app.pty.hookSocketPath}`,
    ).toBe(false);
  });
});
