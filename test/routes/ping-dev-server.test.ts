/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { EventEmitter } from "node:events";
import { pingDevServer } from "../../src/routes/projects.js";

describe("pingDevServer", () => {
  let connectSpy: any;

  function makeMockSocket() {
    const s = new EventEmitter() as any;
    s.end = vi.fn();
    s.write = vi.fn();
    s.destroy = vi.fn();
    return s;
  }

  /** Helper: connect callback fires immediately, then emit 'data' on nextTick
   * with an HTTP response line so the HTTP-level check passes. */
  function mockHttpOk(connectSpy: any, socket: any) {
    connectSpy.mockImplementation((opts: any, cb: any) => {
      setImmediate(() => {
        cb();
        setImmediate(() => socket.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n")));
      });
      return socket;
    });
  }

  beforeEach(() => {
    connectSpy = vi.spyOn(net, "connect");
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  it("resolves true when the server responds to HTTP HEAD", async () => {
    const socket = makeMockSocket();
    mockHttpOk(connectSpy, socket);

    const result = await pingDevServer("http://localhost:1234");

    expect(result).toBe(true);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("HEAD / HTTP/1.1"));
  });

  it("resolves false when connection errors out before any HTTP response", async () => {
    const socket = makeMockSocket();
    connectSpy.mockImplementation(() => {
      setImmediate(() => socket.emit("error", new Error("connrefused")));
      return socket;
    });

    const result = await pingDevServer("http://localhost:1234");
    expect(result).toBe(false);
  });

  it("resolves false on timeout before any HTTP response", async () => {
    const socket = makeMockSocket();
    connectSpy.mockImplementation(() => {
      setImmediate(() => socket.emit("timeout"));
      return socket;
    });

    const result = await pingDevServer("http://localhost:1234");
    expect(result).toBe(false);
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("resolves false for invalid URLs", async () => {
    const result = await pingDevServer("invalid-url-here");
    expect(result).toBe(false);
  });

  it("resolves false when the socket closes without an HTTP response", async () => {
    const socket = makeMockSocket();
    connectSpy.mockImplementation((opts: any, cb: any) => {
      setImmediate(() => {
        cb();
        setImmediate(() => socket.emit("close"));
      });
      return socket;
    });

    const result = await pingDevServer("http://localhost:1234");
    expect(result).toBe(false);
  });

  it("uses fallback port 80 for http schemes without ports", async () => {
    const socket = makeMockSocket();
    mockHttpOk(connectSpy, socket);

    const result = await pingDevServer("http://localhost");
    expect(result).toBe(true);
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: "localhost", port: 80 }),
      expect.any(Function),
    );
  });

  it("uses fallback port 443 for https schemes without ports and uses TCP-only check", async () => {
    const socket = makeMockSocket();
    // For HTTPS, pingDevServer resolves true on connect without sending HTTP
    connectSpy.mockImplementation((opts: any, cb: any) => {
      setImmediate(() => cb());
      return socket;
    });

    const result = await pingDevServer("https://localhost");
    expect(result).toBe(true);
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: "localhost", port: 443 }),
      expect.any(Function),
    );
    // HTTPS does NOT write a HEAD request — TCP-only check
    expect(socket.write).not.toHaveBeenCalled();
  });

  it("resolves true for https on TCP connect (no HTTP-level check for TLS)", async () => {
    const socket = makeMockSocket();
    connectSpy.mockImplementation((opts: any, cb: any) => {
      setImmediate(() => cb());
      return socket;
    });

    const result = await pingDevServer("https://secure.example:443");
    expect(result).toBe(true);
    expect(socket.write).not.toHaveBeenCalled();
  });
});
