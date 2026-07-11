import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildApp } from "../../src/app.js";

describe("staticPlugin", () => {
  const originalFrontendDist = process.env.FRONTEND_DIST;
  let tmpDist: string | undefined;

  afterEach(() => {
    if (tmpDist) fs.rmSync(tmpDist, { recursive: true, force: true });
    tmpDist = undefined;
    process.env.FRONTEND_DIST = originalFrontendDist;
  });

  it("serves the built frontend at / instead of the placeholder, once it exists", async () => {
    tmpDist = path.join(
      os.tmpdir(),
      `static-plugin-test-${crypto.randomBytes(4).toString("hex")}`,
    );
    fs.mkdirSync(tmpDist, { recursive: true });
    fs.writeFileSync(path.join(tmpDist, "index.html"), "<h1>the real frontend</h1>");
    process.env.FRONTEND_DIST = tmpDist;

    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("the real frontend");

    await app.close();
  });
});
