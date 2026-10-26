import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const liveStatus = vi.fn();
vi.mock("../../src/services/session-backend.js", () => ({
  resolveBackend: () => ({ liveStatus }),
}));

const { readSessionLiveInfo } = await import("../../src/services/session-live-info.js");
const { HostRequestError, HostUnreachableError } =
  await import("../../src/services/remote-host-client.js");

// Issue #1962 — the one read both `GET /api/sessions/:id` and the control
// socket's remote wait build a session's status from.

const warn = vi.fn();
const app = { log: { warn } } as unknown as FastifyInstance;
const row = { id: 7 } as never;

describe("readSessionLiveInfo", () => {
  afterEach(() => {
    liveStatus.mockReset();
    warn.mockReset();
  });

  it("returns the host's info for the session", async () => {
    const info = { alive: true };
    liveStatus.mockResolvedValue({ "7": info });
    await expect(readSessionLiveInfo(app, row, 30_000, "mac")).resolves.toEqual({
      info,
      hostReachable: true,
    });
    // A plain read asks exactly as `withLiveStatus` always did.
    expect(liveStatus).toHaveBeenCalledWith(["7"], 30_000);
  });

  it("asks the host for a fresh read, bypassing its cache, when told to", async () => {
    liveStatus.mockResolvedValue({ "7": null });
    await readSessionLiveInfo(app, row, 30_000, "mac", { fresh: true });
    expect(liveStatus).toHaveBeenCalledWith(["7"], 30_000, undefined, { fresh: true });
  });

  it("reports a session the host does not know as null info on a reachable host", async () => {
    liveStatus.mockResolvedValue({});
    await expect(readSessionLiveInfo(app, row, 30_000, "mac")).resolves.toEqual({
      info: null,
      hostReachable: true,
    });
  });

  it("calls a host that cannot be reached unreachable, and hands back why", async () => {
    const err = new HostUnreachableError("mac", new Error("ECONNREFUSED"));
    liveStatus.mockRejectedValue(err);

    const result = await readSessionLiveInfo(app, row, 30_000, "mac");

    expect(result).toEqual({ info: null, hostReachable: false, error: err });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "mac", sessionId: 7 }),
      "host unreachable, reporting default live status",
    );
  });

  it("does not blame the network for a host that ANSWERED with an error", async () => {
    const err = new HostRequestError("mac", 429, "Too Many Requests");
    liveStatus.mockRejectedValue(err);

    const result = await readSessionLiveInfo(app, row, 30_000, "mac");

    expect(result).toEqual({ info: null, hostReachable: false, error: err });
    // The same default view as an unreachable host (the REST path is unchanged),
    // but a log line that says what actually happened.
    const [, message] = warn.mock.calls[0] as [unknown, string];
    expect(message).toMatch(/answered .* with an error/);
    expect(message).not.toMatch(/unreachable/);
  });
});
