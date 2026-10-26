import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  resolveReadTaskRereviewRequest: vi.fn(),
}));

vi.mock("../../src/services/remote-host-client.js", async (importActual) => ({
  ...(await importActual<typeof RemoteHostClientModule>()),
  getRemoteHostClient: () => clientMock,
}));

import { resolveBackend } from "../../src/services/session-backend.js";
import { taskRereviewRequestPath } from "../../src/services/task-prompt.js";

describe("SessionBackend.readTaskRereviewRequest", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "rereview-backend-"));
    app = { pty: { hookSocketPath: path.join(dir, "hooks.sock") } } as unknown as FastifyInstance;
    clientMock.resolveReadTaskRereviewRequest.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("local: null when the worker wrote nothing", async () => {
    await expect(resolveBackend(app, "local").readTaskRereviewRequest(1, 10)).resolves.toBeNull();
  });

  it("local: returns the trimmed reason", async () => {
    fs.writeFileSync(taskRereviewRequestPath(dir, 1, 10), " it grew \n");
    await expect(resolveBackend(app, "local").readTaskRereviewRequest(1, 10)).resolves.toBe(
      "it grew",
    );
  });

  it("local: an empty file still counts as a request", async () => {
    fs.writeFileSync(taskRereviewRequestPath(dir, 1, 10), "\n");
    await expect(resolveBackend(app, "local").readTaskRereviewRequest(1, 10)).resolves.toBe(
      "(no reason given)",
    );
  });

  it("local: is keyed by the verdict time, so another round's request is not seen", async () => {
    fs.writeFileSync(taskRereviewRequestPath(dir, 1, 10), "old");
    await expect(resolveBackend(app, "local").readTaskRereviewRequest(1, 11)).resolves.toBeNull();
  });

  it("remote: delegates to the host client", async () => {
    clientMock.resolveReadTaskRereviewRequest.mockResolvedValue("remote reason");
    await expect(resolveBackend(app, "remote-1").readTaskRereviewRequest(7, 99)).resolves.toBe(
      "remote reason",
    );
    expect(clientMock.resolveReadTaskRereviewRequest).toHaveBeenCalledWith(7, 99);
  });
});
