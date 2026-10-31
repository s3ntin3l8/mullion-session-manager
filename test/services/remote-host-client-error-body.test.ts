// #2416 — the error body of a failed host request.
//
// A 4xx from a remote agent carries the agent's own rejection text, and the
// client keeps it in `HostRequestError.body` so a caller can forward the real
// reason to its own response instead of re-parsing it out of the message.
//
// But reading that body can itself fail — the connection dropped mid-body —
// and the read used to be swallowed into an EMPTY STRING. The error then said
// nothing at all, indistinguishable from an agent that refused without a
// reason. The fallback now names the status, so the error always says
// something.
//
// This file is separate from test/services/remote-host-client.test.ts
// because that file is at its file-size ceiling (the audit's guardrail).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { RemoteHostClient, HostRequestError } =
  await import("../../src/services/remote-host-client.js");

// The destructuring above shadows the class names with plain consts, so the
// INSTANCE type has to be spelled out for the `as` cast below.
type RequestError = InstanceType<typeof HostRequestError>;

function client() {
  return new RemoteHostClient({
    hostId: "h1",
    baseUrl: "http://example.invalid:1234/",
    token: "tok",
  });
}

/** A 4xx whose BODY cannot be read — the connection dropped mid-body. */
function unreadableBodyResponse(status: number) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("connection reset"));
      },
    }),
    { status },
  );
}

describe("#2416 — a host error body is never silently empty", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the status when a 4xx body cannot be read (the request path)", async () => {
    fetchMock.mockResolvedValue(unreadableBodyResponse(404));
    const err = (await client()
      .statProjectFile("/w", "x")
      .catch((e: unknown) => e)) as RequestError;
    expect(err).toBeInstanceOf(HostRequestError);
    expect(err.body).not.toBe("");
    expect(err.body).toContain("404");
    expect(err.message).toContain("404");
  });

  it("names the status when a 4xx body cannot be read (the download path)", async () => {
    fetchMock.mockResolvedValue(unreadableBodyResponse(403));
    const err = (await client()
      .downloadProjectFile("/w", "f")
      .catch((e: unknown) => e)) as RequestError;
    expect(err).toBeInstanceOf(HostRequestError);
    expect(err.body).not.toBe("");
    expect(err.body).toContain("403");
    expect(err.message).toContain("403");
  });

  it("still carries the agent's own body when it can be read", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "nope", code: "not_found" }), { status: 404 }),
    );
    const err = (await client()
      .statProjectFile("/w", "x")
      .catch((e: unknown) => e)) as RequestError;
    expect(err).toBeInstanceOf(HostRequestError);
    expect(JSON.parse(err.body)).toMatchObject({ code: "not_found" });
  });
});
