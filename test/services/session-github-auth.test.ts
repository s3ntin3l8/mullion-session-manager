import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(),
  login: vi.fn<() => string | null>(),
  resolveGitHubToken: vi.fn(),
  resolveReviewerSessionReadToken: vi.fn(),
  appId: vi.fn((_app: unknown, provider?: string) => (provider ? "reviewer-app" : "main-app")),
  peek: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../../src/services/github-integration.js", () => ({
  GITHUB_REVIEWER_PROVIDER: "github-reviewer",
  getToken: () => mocks.getToken(),
  getIntegration: () => ({ login: mocks.login() }),
  getConfiguredAppId: (app: unknown, provider?: string) => mocks.appId(app, provider),
  resolveGitHubToken: (...args: unknown[]) => mocks.resolveGitHubToken(...args),
  resolveReviewerSessionReadToken: (...args: unknown[]) =>
    mocks.resolveReviewerSessionReadToken(...args),
}));
vi.mock("../../src/services/github-app.js", () => ({
  peekInstallationTokenExpiry: (...args: unknown[]) => mocks.peek(...args),
}));
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: () => ({ sendSessionGithubAuth: mocks.send }),
}));
vi.mock("../../src/services/host-git.js", () => ({ resolveRepoRef: vi.fn() }));

const {
  resolveSessionGithubAuth,
  trackSessionGithubAuth,
  refreshSessionGithubAuth,
  clearTrackedSessionGithubAuthForTests,
  untrackSessionGithubAuth,
  SESSION_TOKEN_RENEW_BEFORE_MS,
} = await import("../../src/services/session-github-auth.js");
const { GITHUB_TOKEN_MISSING_HINT } = await import("../../src/services/session-github-token.js");

const repo = { owner: "o", repo: "r" };
const app = {
  log: { warn: vi.fn() },
  db: {
    select: () => ({ from: () => ({ where: () => ({ all: () => [{ status: "active" }] }) }) }),
  },
} as unknown as FastifyInstance;

beforeEach(() => {
  vi.clearAllMocks();
  clearTrackedSessionGithubAuthForTests();
  mocks.appId.mockImplementation((_a, provider) => (provider ? "reviewer-app" : "main-app"));
  mocks.peek.mockReturnValue(undefined);
});

describe("resolveSessionGithubAuth (issue #2246)", () => {
  it("manual: the user's account token, shown as the user", async () => {
    mocks.getToken.mockReturnValue("gho_user");
    mocks.login.mockReturnValue("octocat");
    expect(await resolveSessionGithubAuth(app, { role: "manual", repo: null })).toEqual({
      mode: "manual",
      token: "gho_user",
      username: "octocat",
    });
    expect(mocks.resolveGitHubToken).not.toHaveBeenCalled();
  });

  it("manual with no GitHub connected: an actionable hint, no token", async () => {
    mocks.getToken.mockReturnValue(null);
    expect(await resolveSessionGithubAuth(app, { role: "manual", repo: null })).toEqual({
      mode: "manual",
      hint: GITHUB_TOKEN_MISSING_HINT,
    });
  });

  it("worker: the main App token with the session-work scope, and its expiry", async () => {
    mocks.resolveGitHubToken.mockResolvedValue("ghs_work");
    mocks.peek.mockReturnValue(1_700_000_000_000);
    const auth = await resolveSessionGithubAuth(app, { role: "worker", repo });
    expect(mocks.resolveGitHubToken).toHaveBeenCalledWith(app, repo, "session-work");
    expect(mocks.peek).toHaveBeenCalledWith("main-app", "session-work", "o", "r", "ghs_work");
    expect(auth).toEqual({
      mode: "task",
      token: "ghs_work",
      username: "x-access-token",
      expiresAt: 1_700_000_000_000,
    });
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("reviewer: the reviewer App first, never touching the main App", async () => {
    mocks.resolveReviewerSessionReadToken.mockResolvedValue("ghs_rev");
    const auth = await resolveSessionGithubAuth(app, { role: "reviewer", repo });
    expect(auth.token).toBe("ghs_rev");
    expect(mocks.resolveGitHubToken).not.toHaveBeenCalled();
    expect(mocks.peek).toHaveBeenCalledWith("reviewer-app", "session-read", "o", "r", "ghs_rev");
  });

  it("reviewer falls back to the main App's read token", async () => {
    mocks.resolveReviewerSessionReadToken.mockResolvedValue(null);
    mocks.resolveGitHubToken.mockResolvedValue("ghs_main_read");
    const auth = await resolveSessionGithubAuth(app, { role: "reviewer", repo });
    expect(mocks.resolveGitHubToken).toHaveBeenCalledWith(app, repo, "session-read");
    expect(auth.token).toBe("ghs_main_read");
  });

  it("a task session with no repo or no token gets the install-the-App hint", async () => {
    expect(await resolveSessionGithubAuth(app, { role: "worker", repo: null })).toMatchObject({
      mode: "task",
      hint: expect.stringMatching(/install the Mullion GitHub App/),
    });
    mocks.resolveGitHubToken.mockResolvedValue(null);
    const auth = await resolveSessionGithubAuth(app, { role: "worker", repo });
    expect(auth.token).toBeUndefined();
    expect(auth.hint).toMatch(/GitHub App/);
  });
});

describe("refreshSessionGithubAuth (issue #2246)", () => {
  const input = { role: "worker" as const, repo };

  it("re-sends an App token before it expires, and not before", async () => {
    const now = 10_000_000;
    const expiresAt = now + 3 * SESSION_TOKEN_RENEW_BEFORE_MS;
    trackSessionGithubAuth("7", "dev-01", input, { mode: "task", token: "old", expiresAt });
    mocks.resolveGitHubToken.mockResolvedValue("ghs_new");
    mocks.peek.mockReturnValue(now + 6_000_000);

    await refreshSessionGithubAuth(app, now);
    expect(mocks.send).not.toHaveBeenCalled();

    await refreshSessionGithubAuth(app, expiresAt - SESSION_TOKEN_RENEW_BEFORE_MS + 1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith("7", expect.objectContaining({ token: "ghs_new" }));
  });

  it("does not track local sessions or tokens without an expiry", async () => {
    trackSessionGithubAuth("1", "local", input, { mode: "task", token: "t", expiresAt: 1 });
    trackSessionGithubAuth("2", "dev-01", input, { mode: "manual", token: "t" });
    mocks.resolveGitHubToken.mockResolvedValue("x");
    await refreshSessionGithubAuth(app, 10 ** 12);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a failed push is retried on the next tick; an ended session is dropped", async () => {
    trackSessionGithubAuth("7", "dev-01", input, { mode: "task", token: "o", expiresAt: 1 });
    mocks.resolveGitHubToken.mockResolvedValue("n");
    mocks.send.mockRejectedValueOnce(new Error("offline"));
    await refreshSessionGithubAuth(app, 100);
    expect(app.log.warn).toHaveBeenCalled();
    await refreshSessionGithubAuth(app, 200);
    expect(mocks.send).toHaveBeenCalledTimes(2);

    untrackSessionGithubAuth("7");
    await refreshSessionGithubAuth(app, 300);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
});
