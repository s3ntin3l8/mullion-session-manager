import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { rememberSessionBrowserTarget } from "../../src/services/session-browser-targets.js";
import { identityStatePath } from "../../src/services/agent-identity.js";

// Issue #2448 — the agent-side browser routes take the target from the query
// (the primary names it) and refuse a caller that omits it.
const TOKEN = "internal-browser-test-token";
const headers = { authorization: `Bearer ${TOKEN}` };
const query = "projectId=1&hostId=local&checkoutRoot=%2Fwork%2Fp&legacy=1";

describe("agent browser routes (/internal/.../browser)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    process.env.BROWSER_ENABLED = "true";
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    delete process.env.BROWSER_ENABLED;
  });
  afterEach(() => vi.restoreAllMocks());

  function fakePage() {
    return {
      content: vi.fn(async () => "<html></html>"),
      url: () => "http://localhost/",
      title: async () => "t",
      getByText: () => ({ all: async () => [] }),
      locator: () => ({ ariaSnapshot: async () => "- body" }),
      evaluate: async () => [],
    };
  }

  it("refuses a request that names no browser target", async () => {
    for (const url of ["/internal/sessions/7/browser", "/internal/sessions/7/browser/find"]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { action: "get", by: "text", value: "x" },
      });
      expect(res.statusCode).toBe(400);
    }
    const close = await app.inject({ method: "POST", url: "/internal/browser/close", headers });
    expect(close.statusCode).toBe(400);
  });

  it("refuses a target that names another host once this agent knows its own id", async () => {
    const statePath = identityStatePath(app.config.SESSIONS_DIR);
    fs.writeFileSync(
      statePath,
      JSON.stringify({ hostId: "agent-own", machineCredential: "c".repeat(32) }),
    );
    try {
      const launch = vi.spyOn(app.browser, "getOrLaunch");
      const wrong = await app.inject({
        method: "POST",
        url: `/internal/sessions/7/browser?${query.replace("hostId=local", "hostId=someone-else")}`,
        headers,
        payload: { action: "get" },
      });
      expect(wrong.statusCode).toBe(400);
      const close = await app.inject({
        method: "POST",
        url: `/internal/browser/close?${query.replace("hostId=local", "hostId=someone-else")}`,
        headers,
      });
      expect(close.statusCode).toBe(400);
      expect(launch).not.toHaveBeenCalled();

      launch.mockResolvedValue({
        page: fakePage(),
        consoleLogs: [],
        pageErrors: [],
      } as unknown as Awaited<ReturnType<typeof app.browser.getOrLaunch>>);
      const own = await app.inject({
        method: "POST",
        url: `/internal/sessions/7/browser?${query.replace("hostId=local", "hostId=agent-own")}`,
        headers,
        payload: { action: "get" },
      });
      expect(own.statusCode).toBe(200);
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it("runs an action on the target's page", async () => {
    const page = fakePage();
    const launch = vi
      .spyOn(app.browser, "getOrLaunch")
      .mockResolvedValue({ page, consoleLogs: [], pageErrors: [] } as unknown as Awaited<
        ReturnType<typeof app.browser.getOrLaunch>
      >);
    const res = await app.inject({
      method: "POST",
      url: `/internal/sessions/7/browser?${query}`,
      headers,
      payload: { action: "get" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ html: "<html></html>" });
    expect(launch).toHaveBeenCalledWith({
      projectId: 1,
      hostId: "local",
      checkoutRoot: "/work/p",
      legacy: true,
    });
  });

  it("reports a launch failure as 502 and an action failure as 400", async () => {
    vi.spyOn(app.browser, "getOrLaunch").mockRejectedValueOnce(new Error("no chromium"));
    const bad = await app.inject({
      method: "POST",
      url: `/internal/sessions/7/browser?${query}`,
      headers,
      payload: { action: "get" },
    });
    expect(bad.statusCode).toBe(502);

    vi.spyOn(app.browser, "getOrLaunch").mockResolvedValue({
      page: { content: async () => Promise.reject(new Error("boom")) },
    } as unknown as Awaited<ReturnType<typeof app.browser.getOrLaunch>>);
    const failed = await app.inject({
      method: "POST",
      url: `/internal/sessions/7/browser?${query}`,
      headers,
      payload: { action: "get" },
    });
    expect(failed.statusCode).toBe(400);
  });

  it("finds elements on the target's page, with launch and find failures mapped", async () => {
    const page = fakePage();
    vi.spyOn(app.browser, "getOrLaunch").mockResolvedValueOnce({
      page,
    } as unknown as Awaited<ReturnType<typeof app.browser.getOrLaunch>>);
    const ok = await app.inject({
      method: "POST",
      url: `/internal/sessions/7/browser/find?${query}`,
      headers,
      payload: { by: "text", value: "x" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, matchCount: 0 });

    vi.spyOn(app.browser, "getOrLaunch").mockRejectedValueOnce(new Error("no chromium"));
    const launchFail = await app.inject({
      method: "POST",
      url: `/internal/sessions/7/browser/find?${query}`,
      headers,
      payload: { by: "text", value: "x" },
    });
    expect(launchFail.statusCode).toBe(502);

    vi.spyOn(app.browser, "getOrLaunch").mockResolvedValueOnce({
      page: { getByText: () => ({ all: async () => Promise.reject(new Error("bad")) }) },
    } as unknown as Awaited<ReturnType<typeof app.browser.getOrLaunch>>);
    const findFail = await app.inject({
      method: "POST",
      url: `/internal/sessions/7/browser/find?${query}`,
      headers,
      payload: { by: "text", value: "x" },
    });
    expect(findFail.statusCode).toBe(400);
  });

  it("reports a session's browserUrl only for the browser of its own target", async () => {
    const own = { projectId: 3, hostId: "h", checkoutRoot: "/work/a", legacy: true };
    const other = { projectId: 3, hostId: "h", checkoutRoot: "/work/b", legacy: false };
    const targets: Record<string, typeof own | null> = { "601": own, "602": other, "603": null };
    vi.spyOn(app.pty, "get").mockImplementation(
      () => ({ toInfo: () => ({ browserUrl: null }) }) as unknown as ReturnType<typeof app.pty.get>,
    );
    for (const [id, t] of Object.entries(targets)) {
      rememberSessionBrowserTarget(app.pty, id, t ?? undefined);
    }
    // Only worktree A's browser is running.
    vi.spyOn(app.browser, "get").mockImplementation((t) =>
      t.checkoutRoot === "/work/a"
        ? ({
            browser: { isConnected: () => true },
            page: { url: () => "http://localhost:3000/?token=secret" },
          } as unknown as ReturnType<typeof app.browser.get>)
        : undefined,
    );
    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions/live",
      headers,
      // An older primary's per-project hint is accepted but no longer used.
      payload: {
        ids: ["601", "602", "603"],
        idleThresholdMs: 30_000,
        sessionProjectIds: { "602": 3 },
      },
    });
    const live = res.json();
    expect(live["601"].browserUrl).toBe("http://localhost:3000/?token=secret");
    // A session in another worktree must not see A's page.
    expect(live["602"].browserUrl).toBeNull();
    expect(live["603"].browserUrl).toBeNull();
  });

  it("closes one target's browser, idempotently", async () => {
    const close = vi.spyOn(app.browser, "closeTarget").mockResolvedValue(undefined);
    const res = await app.inject({
      method: "POST",
      url: `/internal/browser/close?${query}`,
      headers,
    });
    expect(res.json()).toEqual({ ok: true });
    expect(close).toHaveBeenCalledWith({
      projectId: 1,
      hostId: "local",
      checkoutRoot: "/work/p",
      legacy: true,
    });
  });
});
