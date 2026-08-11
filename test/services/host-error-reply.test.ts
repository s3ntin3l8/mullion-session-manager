import { describe, it, expect, vi } from "vitest";
import type { FastifyReply } from "fastify";
import { forwardHostRequestError } from "../../src/services/host-error-reply.js";
import { HostRequestError } from "../../src/services/remote-host-client.js";

// Route-level tests (agent-rules.test.ts, dock-config.test.ts, skills.test.ts,
// hosts.test.ts) exercise this through a real remote agent, but every agent
// response body in those suites is JSON with a string `message` — so the
// `catch` fallback (a non-JSON body) and the "parsed but not a
// message-bearing object" branch are unreachable from that suite alone.
// This file drives forwardHostRequestError directly to cover them.
function mockReply() {
  const send = vi.fn();
  const serviceUnavailable = vi.fn();
  const code = vi.fn(() => ({ send }));
  const reply = { code, serviceUnavailable, send } as unknown as FastifyReply;
  return { reply, code, serviceUnavailable, send };
}

describe("forwardHostRequestError", () => {
  it("folds a 401 from the agent into a 503 with a friendly, non-leaking message", () => {
    const { reply, serviceUnavailable, code } = mockReply();
    const err = new HostRequestError("host-1", 401, JSON.stringify({ message: "unauthorized" }));
    forwardHostRequestError(reply, err);
    expect(serviceUnavailable).toHaveBeenCalledWith(
      "Host rejected the request — check its agent token",
    );
    expect(code).not.toHaveBeenCalled();
  });

  it("folds a 403 from the agent into a 503 the same way as a 401", () => {
    const { reply, serviceUnavailable } = mockReply();
    const err = new HostRequestError("host-1", 403, "forbidden");
    forwardHostRequestError(reply, err);
    expect(serviceUnavailable).toHaveBeenCalledWith(
      "Host rejected the request — check its agent token",
    );
  });

  it("forwards a real 4xx's status and extracts the message from a JSON body", () => {
    const { reply, code, send } = mockReply();
    const err = new HostRequestError(
      "host-1",
      400,
      JSON.stringify({ message: "duplicate control id" }),
    );
    forwardHostRequestError(reply, err);
    expect(code).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({ message: "duplicate control id" });
  });

  it("falls back to the HostRequestError's own message when the body isn't JSON", () => {
    const { reply, code, send } = mockReply();
    const err = new HostRequestError("host-1", 502, "<html>Bad Gateway</html>");
    forwardHostRequestError(reply, err);
    expect(code).toHaveBeenCalledWith(502);
    expect(send).toHaveBeenCalledWith({ message: err.message });
  });

  it("falls back to the HostRequestError's own message when the JSON body isn't a message-bearing object", () => {
    const { reply, code, send } = mockReply();
    const err = new HostRequestError("host-1", 400, JSON.stringify(["not", "an", "object"]));
    forwardHostRequestError(reply, err);
    expect(code).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({ message: err.message });
  });

  it("falls back to the HostRequestError's own message when the JSON body's message isn't a string", () => {
    const { reply, code, send } = mockReply();
    const err = new HostRequestError("host-1", 400, JSON.stringify({ message: 42 }));
    forwardHostRequestError(reply, err);
    expect(code).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({ message: err.message });
  });
});
