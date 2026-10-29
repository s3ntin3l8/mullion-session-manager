import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockListHosts = vi.hoisted(() => vi.fn(() => [] as unknown[]));
const setPalette = vi.hoisted(() => vi.fn(async (_p: unknown) => {}));
const getClient = vi.hoisted(() =>
  vi.fn((_app: unknown, _id: string) => ({ setTerminalPalette: setPalette })),
);

vi.mock("../../src/services/host-registry.js", () => ({
  LOCAL_HOST_ID: "local",
  listHosts: (...args: unknown[]) => mockListHosts(...(args as [])),
}));
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: (a: unknown, id: string) => getClient(a, id),
  HostRequestError: class HostRequestError extends Error {
    constructor(
      _hostId: string,
      public readonly statusCode: number,
      _body: string,
    ) {
      super("rejected");
    }
  },
}));
import { HostRequestError } from "../../src/services/remote-host-client.js";

import {
  pushTerminalPaletteToHost,
  pushTerminalPaletteToHosts,
} from "../../src/services/terminal-palette-sync.js";
import {
  resetTerminalPalette,
  setTerminalPalette,
} from "../../src/services/terminal-query-reply.js";

const palette = { foreground: "#111111", background: "#f2f2f2", cursor: "#111111" };
const warn = vi.fn();
const debug = vi.fn();
const app = { log: { warn, debug } } as unknown as FastifyInstance;

describe("terminal palette sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTerminalPalette();
  });
  afterEach(() => resetTerminalPalette());

  it("pushes nothing until a palette has been reported", async () => {
    await pushTerminalPaletteToHost(app, "h1");
    expect(setPalette).not.toHaveBeenCalled();
  });

  it("pushes the cached palette to one host", async () => {
    setTerminalPalette(palette);
    await pushTerminalPaletteToHost(app, "h1");
    expect(getClient).toHaveBeenCalledWith(app, "h1");
    expect(setPalette).toHaveBeenCalledWith(palette);
  });

  it("never pushes to the local host", async () => {
    setTerminalPalette(palette);
    await pushTerminalPaletteToHost(app, "local");
    expect(setPalette).not.toHaveBeenCalled();
  });

  it("pushes to enrolled remote hosts only, skipping pending rows", async () => {
    setTerminalPalette(palette);
    mockListHosts.mockReturnValue([
      { id: "local", baseUrl: "http://self" },
      { id: "h1", baseUrl: "http://a" },
      { id: "h2", baseUrl: null },
      { id: "h3", baseUrl: "http://c" },
    ]);
    await pushTerminalPaletteToHosts(app);
    expect(getClient.mock.calls.map((c) => c[1])).toEqual(["h1", "h3"]);
  });

  it("swallows an unreachable host quietly", async () => {
    setTerminalPalette(palette);
    setPalette.mockRejectedValueOnce(new Error("offline"));
    await expect(pushTerminalPaletteToHost(app, "h1")).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the agent predates the route (404)", async () => {
    setTerminalPalette(palette);
    setPalette.mockRejectedValueOnce(new HostRequestError("h1", 404, ""));
    await expect(pushTerminalPaletteToHost(app, "h1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
