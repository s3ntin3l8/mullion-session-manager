import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { buildApp } from "../../src/app.js";

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
