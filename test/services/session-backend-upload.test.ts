import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  uploadImage: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../../src/services/remote-host-client.js", async (importActual) => ({
  ...(await importActual<typeof RemoteHostClientModule>()),
  getRemoteHostClient: () => clientMock,
}));

import { resolveBackend } from "../../src/services/session-backend.js";

describe("SessionBackend uploads", () => {
  beforeEach(() => {
    clientMock.uploadImage.mockReset();
    clientMock.uploadFile.mockReset();
  });

  it("RemoteBackend.uploadFile delegates to the host client", async () => {
    clientMock.uploadFile.mockResolvedValue({ path: "/r/.mullion-uploads/u/a.txt" });
    const backend = resolveBackend({} as FastifyInstance, "remote-1");
    const buf = Buffer.from("x");

    await expect(backend.uploadFile("/r", buf, "a.txt")).resolves.toEqual({
      path: "/r/.mullion-uploads/u/a.txt",
    });
    expect(clientMock.uploadFile).toHaveBeenCalledWith("/r", buf, "a.txt");
  });
});
