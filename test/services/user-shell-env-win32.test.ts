import { describe, it, expect, afterEach } from "vitest";
import { getSessionEnvInfo, getSessionPathEntries } from "../../src/services/user-shell-env.js";

// Runs in CI's test-windows job: the default delimiter is `node:path`'s, bound
// at import, so only a real Windows process exercises the `;` default (the
// faked-platform test in user-shell-env.test.ts has to pass it explicitly).
describe.skipIf(process.platform !== "win32")("user-shell-env on a real Windows host", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  it("splits the PATH on ';', keeping drive letters, and does not warn", () => {
    process.env.PATH = "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd";
    expect(getSessionPathEntries()).toEqual([
      "C:\\Windows\\system32",
      "C:\\Program Files\\Git\\cmd",
    ]);
    expect(getSessionEnvInfo()).toMatchObject({
      interactiveResolve: "not-applicable",
      reason: null,
    });
  });
});
