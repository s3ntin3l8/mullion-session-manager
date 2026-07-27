/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { EventEmitter } from "node:events";
import { pingDevServer } from "../../src/routes/projects.js";

describe("pingDevServer", () => {
  let connectSpy: any;

  beforeEach(() => {
    connectSpy = vi.spyOn(net, "connect");
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  it("resolves true when connection succeeds", async () => {
    const mockSocket = new EventEmitter() as any;
    mockSocket.end = vi.fn();
    connectSpy.mockImplementation((opts: any, cb: any) => {
      setImmediate(() => cb());
      return mockSocket;
    });

    const result = await pingDevServer("http://localhost:1234");
    expect(result).toBe(true);
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: "localhost", port: 1234 }),
      expect.any(Function),
    );
  });

  it("resolves false when connection errors out", async () => {
    const mockSocket = new EventEmitter() as any;
    connectSpy.mockImplementation(() => {
      setImmediate(() => mockSocket.emit("error", new Error("connrefused")));
      return mockSocket;
    });

    const result = await pingDevServer("http://localhost:1234");
    expect(result).toBe(false);
  });

  it("resolves false on timeout", async () => {
    const mockSocket = new EventEmitter() as any;
    mockSocket.destroy = vi.fn();
    connectSpy.mockImplementation(() => {
      setImmediate(() => mockSocket.emit("timeout"));
      return mockSocket;
    });

    const result = await pingDevServer("http://localhost:1234");
    expect(result).toBe(false);
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("resolves false for invalid URLs", async () => {
    const result = await pingDevServer("invalid-url-here");
    expect(result).toBe(false);
  });

  it("uses fallback port 80 for http schemes without ports", async () => {
    const mockSocket = new EventEmitter() as any;
    mockSocket.end = vi.fn();
    connectSpy.mockImplementation((opts: any, cb: any) => {
      setImmediate(() => cb());
      return mockSocket;
    });

    const result = await pingDevServer("http://localhost");
    expect(result).toBe(true);
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: "localhost", port: 80 }),
      expect.any(Function),
    );
  });

  it("uses fallback port 443 for https schemes without ports", async () => {
    const mockSocket = new EventEmitter() as any;
    mockSocket.end = vi.fn();
    connectSpy.mockImplementation((opts: any, cb: any) => {
      setImmediate(() => cb());
      return mockSocket;
    });

    const result = await pingDevServer("https://localhost");
    expect(result).toBe(true);
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ host: "localhost", port: 443 }),
      expect.any(Function),
    );
  });
});
