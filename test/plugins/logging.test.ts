import { describe, it, expect } from "vitest";
import { buildTestApp } from "../helpers/app.js";

describe("logging plugin", () => {
  it("configures structured JSON logging", async () => {
    const app = await buildTestApp();
    expect(app.log.level).toBe(app.config.LOG_LEVEL);
  });
});
