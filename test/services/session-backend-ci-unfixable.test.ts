import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  resolveReadTaskCiUnfixable: vi.fn(),
}));

vi.mock("../../src/services/remote-host-client.js", async (importActual) => ({
  ...(await importActual<typeof RemoteHostClientModule>()),
  getRemoteHostClient: () => clientMock,
}));

import { resolveBackend } from "../../src/services/session-backend.js";
import { taskCiUnfixablePath } from "../../src/services/task-prompt.js";

const HEAD = "a1".repeat(20);

describe("SessionBackend.readTaskCiUnfixable", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-unfixable-backend-"));
    app = {
      pty: { hookSocketPath: path.join(dir, "hooks.sock"), sessionsDir: dir },
    } as unknown as FastifyInstance;
    clientMock.resolveReadTaskCiUnfixable.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("local: null when the worker declared nothing", async () => {
    await expect(resolveBackend(app, "local").readTaskCiUnfixable(1, HEAD)).resolves.toBeNull();
  });

  it("local: returns the trimmed reason, and a placeholder for an empty file", async () => {
    fs.writeFileSync(taskCiUnfixablePath(dir, 1, HEAD), " no patched release \n");
    fs.writeFileSync(taskCiUnfixablePath(dir, 2, HEAD), "\n");
    await expect(resolveBackend(app, "local").readTaskCiUnfixable(1, HEAD)).resolves.toBe(
      "no patched release",
    );
    await expect(resolveBackend(app, "local").readTaskCiUnfixable(2, HEAD)).resolves.toBe(
      "(no reason given)",
    );
  });

  it("local: is keyed by head, so another head's declaration is not seen", async () => {
    fs.writeFileSync(taskCiUnfixablePath(dir, 1, HEAD), "old");
    await expect(
      resolveBackend(app, "local").readTaskCiUnfixable(1, "b2".repeat(20)),
    ).resolves.toBeNull();
  });

  it("refuses a head that is not a full lowercase SHA before building any path", async () => {
    for (const bad of ["", "abc", "../x", "A1".repeat(20), `${HEAD}0`]) {
      await expect(resolveBackend(app, "local").readTaskCiUnfixable(1, bad)).rejects.toThrow(
        "40-char lowercase hex SHA",
      );
      expect(() => resolveBackend(app, "remote-1").readTaskCiUnfixable(1, bad)).toThrow();
    }
    expect(clientMock.resolveReadTaskCiUnfixable).not.toHaveBeenCalled();
  });

  it("remote: delegates to the host client", async () => {
    clientMock.resolveReadTaskCiUnfixable.mockResolvedValue("remote reason");
    await expect(resolveBackend(app, "remote-1").readTaskCiUnfixable(7, HEAD)).resolves.toBe(
      "remote reason",
    );
    expect(clientMock.resolveReadTaskCiUnfixable).toHaveBeenCalledWith(7, HEAD);
  });
});
