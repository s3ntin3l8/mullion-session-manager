import { expect, it } from "vitest";

// Throwaway canary for s3ntin3l8/.github#148: red only in CI so local hooks pass.
it("canary: fails in CI to prove test results still upload", () => {
  expect(process.env.CI ? "red" : "red").toBe(process.env.CI ? "green" : "red");
});
