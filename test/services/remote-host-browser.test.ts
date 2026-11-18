import { describe, it, expect, vi } from "vitest";
import type { WebSocket as NodeWebSocket } from "ws";
import { createBrowserClient } from "../../src/services/remote-host-browser.js";
import type { BrowserTarget } from "../../src/services/browser-manager.js";

// The browser facet behind RemoteHostClient.browser (#3302): what path,
// query, headers, body and socket target each call uses.

const TARGET: BrowserTarget = {
  projectId: 4,
  hostId: "agent-1",
  checkoutRoot: "/work/app",
  endpoint: "ep-1",
  legacy: false,
};

const unusedOpenInbound = () => {
  throw new Error("unexpected openInbound call");
};

describe("remote-host-browser", () => {
  it("omits content-type and body on post when body is undefined (#2688)", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const browser = createBrowserClient({ request, openInbound: unusedOpenInbound });

    await expect(browser.post("/internal/browser/close", TARGET)).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenCalledTimes(1);
    const [path, init] = request.mock.calls[0];
    expect(path).toBe(
      "/internal/browser/close?projectId=4&hostId=agent-1&checkoutRoot=%2Fwork%2Fapp&legacy=0&endpoint=ep-1",
    );
    expect(init).toEqual({
      method: "POST",
      headers: undefined,
      body: undefined,
    });
  });

  it("sets JSON content-type and stringified body on post, action and find", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const browser = createBrowserClient({ request, openInbound: unusedOpenInbound });

    await browser.post("/internal/sessions/9/browser-target", TARGET, { target: TARGET });
    await browser.action(9, TARGET, { action: "snapshot" });
    await browser.find(9, TARGET, { text: "Submit" });

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/internal/sessions/9/browser-target?projectId=4&hostId=agent-1&checkoutRoot=%2Fwork%2Fapp&legacy=0&endpoint=ep-1",
      "/internal/sessions/9/browser?projectId=4&hostId=agent-1&checkoutRoot=%2Fwork%2Fapp&legacy=0&endpoint=ep-1",
      "/internal/sessions/9/browser/find?projectId=4&hostId=agent-1&checkoutRoot=%2Fwork%2Fapp&legacy=0&endpoint=ep-1",
    ]);
    for (const [, init] of request.mock.calls) {
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "content-type": "application/json" });
    }
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ target: TARGET });
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ action: "snapshot" });
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ text: "Submit" });
  });

  it("opens the browser WS with the target query", () => {
    const openInbound = vi.fn((target: string) => target as unknown as NodeWebSocket);
    const browser = createBrowserClient({ request: vi.fn(), openInbound });

    browser.openSocket(9, TARGET);

    expect(openInbound).toHaveBeenCalledWith(
      "/internal/ws/browser/9?projectId=4&hostId=agent-1&checkoutRoot=%2Fwork%2Fapp&legacy=0&endpoint=ep-1",
    );
  });
});
