import { describe, it, expect, beforeEach } from "vitest";
import {
  GITHUB_TOKEN_MISSING_HINT,
  buildGithubTokenReply,
  clearSessionGithubAuthForTests,
  dropSessionGithubAuth,
  getSessionGithubAuth,
  setSessionGithubAuth,
} from "../../src/services/session-github-token.js";
import { buildGitConfigEnv } from "../../src/services/session-env.js";
import { githubCredentialHelperCommand } from "../../src/services/session-github-helper.js";

beforeEach(() => clearSessionGithubAuthForTests());

describe("session GitHub token store (issue #2246)", () => {
  it("keeps entries per session and drops them", () => {
    setSessionGithubAuth("1", { mode: "task", token: "t1" });
    setSessionGithubAuth("2", { mode: "manual", token: "t2" });
    expect(getSessionGithubAuth("1")?.token).toBe("t1");
    dropSessionGithubAuth("1");
    expect(getSessionGithubAuth("1")).toBeUndefined();
    expect(getSessionGithubAuth("2")?.token).toBe("t2");
  });

  it("prunes expired entries when another is set", () => {
    setSessionGithubAuth("old", { mode: "task", token: "x", expiresAt: Date.now() - 1 });
    setSessionGithubAuth("new", { mode: "task", token: "y" });
    expect(getSessionGithubAuth("old")).toBeUndefined();
  });

  it("builds the hook reply for every state", () => {
    expect(buildGithubTokenReply(undefined)).toEqual({
      error: GITHUB_TOKEN_MISSING_HINT,
      hostFirst: false,
    });
    expect(buildGithubTokenReply({ mode: "manual", hint: "install the App" })).toEqual({
      error: "install the App",
      hostFirst: true,
    });
    expect(buildGithubTokenReply({ mode: "task" })).toMatchObject({
      error: GITHUB_TOKEN_MISSING_HINT,
      hostFirst: false,
    });
    expect(buildGithubTokenReply({ mode: "task", token: "t", username: "u" })).toEqual({
      token: "t",
      username: "u",
      hostFirst: false,
    });
    const expired = buildGithubTokenReply({ mode: "task", token: "t", expiresAt: 1000 }, 2000);
    expect(expired).toMatchObject({ error: expect.stringMatching(/expired/) });
    expect(JSON.stringify(expired)).not.toContain('"t"');
  });
});

describe("buildGitConfigEnv credential helper (issue #2246)", () => {
  const command = githubCredentialHelperCommand();
  const keys = (env: Record<string, string>) =>
    Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);

  it("quotes the node binary and script for git's shell", () => {
    expect(command).toMatch(/^!'.*node.*' '.*git-credential-mullion\.mjs'$/);
  });

  it("manual: helper appended, no reset", () => {
    const env = buildGitConfigEnv({ credentialHelper: { mode: "manual", command } });
    expect(keys(env)).toEqual(["gc.auto", "credential.helper"]);
    expect(env.GIT_CONFIG_VALUE_1).toBe(command);
  });

  it("task: an empty-valued reset precedes Mullion's helper", () => {
    const env = buildGitConfigEnv({
      taskPushBlock: true,
      credentialHelper: { mode: "task", command },
    });
    expect(keys(env)).toEqual([
      "gc.auto",
      "remote.origin.pushurl",
      "credential.helper",
      "credential.helper",
    ]);
    expect(env.GIT_CONFIG_VALUE_2).toBe("");
    expect(env.GIT_CONFIG_VALUE_3).toBe(command);
  });

  it("is absent without the option", () => {
    expect(keys(buildGitConfigEnv({}))).toEqual(["gc.auto"]);
  });
});
