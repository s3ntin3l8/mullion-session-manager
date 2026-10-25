import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  resolvePrompt: vi.fn(),
  resolveWaitOutput: vi.fn(),
}));

vi.mock("../../src/services/remote-host-client.js", async (importActual) => ({
  ...(await importActual<typeof RemoteHostClientModule>()),
  getRemoteHostClient: () => clientMock,
}));

import { resolveBackend } from "../../src/services/session-backend.js";
import { REMOTE_WAIT_CHUNK_MS } from "../../src/services/session-prompt.js";
import { HostRequestError, HostUnreachableError } from "../../src/services/remote-host-client.js";

// Issue #1951 — `sessions.prompt` / `sessions.wait_for_output` against a child
// whose PTY lives on another host. A refusal is a VALUE, never a throw.

const backend = () => resolveBackend({} as FastifyInstance, "mac-1");
const waitReq = (over: Record<string, unknown> = {}) => ({
  match: "BUILD OK",
  regex: false,
  timeoutMs: 120_000,
  signal: new AbortController().signal,
  alive: () => true,
  ...over,
});

describe("RemoteBackend.prompt", () => {
  beforeEach(() => {
    clientMock.resolvePrompt.mockReset();
    clientMock.resolveWaitOutput.mockReset();
  });

  it("returns the output offset the agent reports", async () => {
    clientMock.resolvePrompt.mockResolvedValue({ outputOffset: 17 });
    await expect(backend().prompt("5", { text: "go", submit: true })).resolves.toEqual({
      ok: true,
      outputOffset: 17,
    });
    expect(clientMock.resolvePrompt).toHaveBeenCalledWith("5", { text: "go", submit: true });
  });

  it("passes through the status and message of an agent's 422 refusal", async () => {
    clientMock.resolvePrompt.mockRejectedValue(
      new HostRequestError("mac-1", 422, JSON.stringify({ status: 501, error: "no framing" })),
    );
    await expect(backend().prompt("5", { text: "go", submit: true })).resolves.toEqual({
      ok: false,
      status: 501,
      error: "no framing",
    });
  });

  it("reports an agent too old to have the route as 501 'upgrade it'", async () => {
    clientMock.resolvePrompt.mockRejectedValue(new HostRequestError("mac-1", 404, "Not Found"));
    const out = await backend().prompt("5", { text: "go", submit: true });
    expect(out).toMatchObject({ ok: false, status: 501 });
    expect(out.ok === false && out.error).toMatch(/too old.*upgrade/);
  });

  it("reports an unparseable 422 and any other rejection as 502", async () => {
    clientMock.resolvePrompt.mockRejectedValueOnce(new HostRequestError("mac-1", 422, "not json"));
    await expect(backend().prompt("5", { text: "go", submit: true })).resolves.toMatchObject({
      ok: false,
      status: 502,
    });
    clientMock.resolvePrompt.mockRejectedValueOnce(new HostRequestError("mac-1", 403, ""));
    await expect(backend().prompt("5", { text: "go", submit: true })).resolves.toMatchObject({
      ok: false,
      status: 502,
    });
  });

  it("reports an unreachable host as 502 rather than throwing", async () => {
    clientMock.resolvePrompt.mockRejectedValue(
      new HostUnreachableError("mac-1", new Error("ECONNREFUSED")),
    );
    await expect(backend().prompt("5", { text: "go", submit: true })).resolves.toMatchObject({
      ok: false,
      status: 502,
      error: expect.stringMatching(/unreachable/),
    });
  });
});

describe("RemoteBackend.waitOutput", () => {
  beforeEach(() => {
    clientMock.resolvePrompt.mockReset();
    clientMock.resolveWaitOutput.mockReset();
  });

  it("returns a match from the first chunk", async () => {
    clientMock.resolveWaitOutput.mockResolvedValue({
      matched: true,
      text: "BUILD OK",
      line: "BUILD OK",
      outputOffset: 99,
    });
    await expect(backend().waitOutput("5", waitReq({ afterOffset: 4 }))).resolves.toEqual({
      matched: true,
      text: "BUILD OK",
      line: "BUILD OK",
      outputOffset: 99,
    });
    expect(clientMock.resolveWaitOutput).toHaveBeenCalledWith("5", {
      match: "BUILD OK",
      regex: false,
      timeoutMs: REMOTE_WAIT_CHUNK_MS,
      afterOffset: 4,
    });
  });

  it("loops in bounded chunks, resuming each from the previous chunk's offset", async () => {
    clientMock.resolveWaitOutput
      .mockResolvedValueOnce({ matched: false, timedOut: true, outputOffset: 100 })
      .mockResolvedValueOnce({ matched: false, timedOut: true, outputOffset: 250 })
      .mockResolvedValueOnce({ matched: true, text: "x", line: "x", outputOffset: 300 });
    const out = await backend().waitOutput("5", waitReq());
    expect(out).toMatchObject({ matched: true, outputOffset: 300 });
    const calls = clientMock.resolveWaitOutput.mock.calls.map((c) => c[1]);
    // The first chunk had no cursor ("only output from now on"); later ones
    // resume exactly where the last stopped, so nothing is lost between two
    // requests.
    expect(calls[0]).not.toHaveProperty("afterOffset");
    expect(calls[1]).toMatchObject({ afterOffset: 100 });
    expect(calls[2]).toMatchObject({ afterOffset: 250 });
    expect(calls.every((c) => c.timeoutMs <= REMOTE_WAIT_CHUNK_MS)).toBe(true);
  });

  it("times out once the overall deadline has passed, with the cursor to resume from", async () => {
    vi.useFakeTimers();
    try {
      clientMock.resolveWaitOutput.mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(REMOTE_WAIT_CHUNK_MS);
        return { matched: false, timedOut: true, outputOffset: 7 };
      });
      const out = await backend().waitOutput("5", waitReq({ timeoutMs: 90_000 }));
      expect(out).toEqual({ matched: false, timedOut: true, outputOffset: 7 });
      // 90s = one 60s chunk, then a 30s remainder — not a third request.
      expect(clientMock.resolveWaitOutput).toHaveBeenCalledTimes(2);
      expect(clientMock.resolveWaitOutput.mock.calls[1][1].timeoutMs).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops without asking the host again once the caller aborts", async () => {
    const controller = new AbortController();
    clientMock.resolveWaitOutput.mockImplementation(async () => {
      controller.abort();
      return { matched: false, timedOut: true, outputOffset: 1 };
    });
    await expect(
      backend().waitOutput("5", waitReq({ signal: controller.signal })),
    ).resolves.toEqual({ aborted: true });
    expect(clientMock.resolveWaitOutput).toHaveBeenCalledTimes(1);
  });

  it("reports gone, without another request, once the caller is no longer active", async () => {
    let active = true;
    clientMock.resolveWaitOutput.mockImplementation(async () => {
      active = false;
      return { matched: false, timedOut: true, outputOffset: 5 };
    });
    await expect(
      backend().waitOutput("5", waitReq({ alive: () => active })),
    ).resolves.toMatchObject({ matched: false, gone: true });
    expect(clientMock.resolveWaitOutput).toHaveBeenCalledTimes(1);
  });

  it("passes through a gone result and a not-running one", async () => {
    clientMock.resolveWaitOutput.mockResolvedValueOnce({
      matched: false,
      gone: true,
      outputOffset: 3,
    });
    await expect(backend().waitOutput("5", waitReq())).resolves.toMatchObject({ gone: true });
    clientMock.resolveWaitOutput.mockResolvedValueOnce({ notRunning: true });
    await expect(backend().waitOutput("5", waitReq())).resolves.toEqual({ notRunning: true });
  });

  it("reports an old agent and an unreachable host as failures, not throws", async () => {
    clientMock.resolveWaitOutput.mockRejectedValueOnce(
      new HostRequestError("mac-1", 404, "Not Found"),
    );
    await expect(backend().waitOutput("5", waitReq())).resolves.toMatchObject({
      failed: true,
      status: 501,
    });
    clientMock.resolveWaitOutput.mockRejectedValueOnce(
      new HostUnreachableError("mac-1", new Error("down")),
    );
    await expect(backend().waitOutput("5", waitReq())).resolves.toMatchObject({
      failed: true,
      status: 502,
    });
  });
});
