import { describe, it, expect, vi } from "vitest";

const calls: unknown[][] = [];
vi.mock("../../src/services/git-run.js", () => ({
  runGitCommand: async (...args: unknown[]) => {
    calls.push(args);
    return { ok: false, detail: "fatal: boom [redacted]" };
  },
}));

const { runGitFetch } = await import("../../src/services/git-fetch.js");

describe("runGitFetch with a token", () => {
  it("passes the token through the shared extraHeader helper and returns its redacted detail", async () => {
    const result = await runGitFetch("/srv/repo", "tok123");
    const [cwd, args, header, token, encoded] = calls[0] as string[];
    expect(cwd).toBe("/srv/repo");
    expect(args).toEqual(["fetch", "--quiet", "--prune"]);
    expect(token).toBe("tok123");
    expect(header).toBe(`AUTHORIZATION: basic ${encoded}`);
    expect(Buffer.from(encoded, "base64").toString()).toBe("x-access-token:tok123");
    expect(result).toEqual({ success: false, error: "fatal: boom [redacted]" });
    expect(JSON.stringify(result)).not.toContain("tok123");
  });
});
