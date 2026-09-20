import { vi, describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Mock spawn but pass through everything else (execFile, exec, etc.)
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const spawnMock = vi.fn();
  return { ...actual, spawn: spawnMock };
});

import { spawn } from "node:child_process";
import { acceptLicenses } from "../../src/services/avd-manager.js";

interface MockChild extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("acceptLicenses", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it("spawns sdkmanager --licenses with --sdk_root", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    // Resolve after the function sets up listeners
    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");

    // Let the promise executor run and set up listeners
    await new Promise((r) => setTimeout(r, 10));

    // Now emit success
    child.stdout.emit("data", Buffer.from("All SDK licenses accepted.\n"));
    child.emit("close", 0);

    await done;

    expect(spawn).toHaveBeenCalledWith(
      "/opt/sdk/sdkmanager",
      ["--licenses", "--sdk_root", "/opt/sdk"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("streams progress lines via onLine callback", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);
    const onLine = vi.fn();

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk", { onLine });
    await new Promise((r) => setTimeout(r, 10));

    child.stdout.emit("data", Buffer.from("License accepted\nDone\n"));
    child.emit("close", 0);

    await done;

    expect(onLine).toHaveBeenCalledWith("License accepted");
    expect(onLine).toHaveBeenCalledWith("Done");
  });

  it("resolves when stdout contains 'accepted' even with exit code 1", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");
    await new Promise((r) => setTimeout(r, 10));

    child.stdout.emit("data", Buffer.from("All SDK licenses accepted.\n"));
    child.emit("close", 1);

    await expect(done).resolves.toBeUndefined();
  });

  it("resolves when stderr contains 'accepted'", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");
    await new Promise((r) => setTimeout(r, 10));

    child.stderr.emit("data", Buffer.from("All SDK licenses accepted.\n"));
    child.emit("close", 1);

    await expect(done).resolves.toBeUndefined();
  });

  it("resolves on exit code 0 without 'accepted' string", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");
    await new Promise((r) => setTimeout(r, 10));

    child.stdout.emit("data", Buffer.from("No licenses to accept\n"));
    child.emit("close", 0);

    await expect(done).resolves.toBeUndefined();
  });

  it("rejects on non-zero exit code without 'accepted' string", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");
    await new Promise((r) => setTimeout(r, 10));

    child.stdout.emit("data", Buffer.from("Something went wrong\n"));
    child.stderr.emit("data", Buffer.from("Error occurred\n"));
    child.emit("close", 2);

    await expect(done).rejects.toThrow(/Error occurred/);
  });

  it("rejects when spawn emits an error event", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");
    await new Promise((r) => setTimeout(r, 10));

    child.emit("error", new Error("spawn ENOENT"));

    await expect(done).rejects.toThrow(/spawn ENOENT/);
  });

  it("writes multiple y lines to stdin for auto-accept", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");
    await new Promise((r) => setTimeout(r, 10));

    child.stdout.emit("data", Buffer.from("accepted\n"));
    child.emit("close", 0);

    await done;

    expect(child.stdin.write).toHaveBeenCalledTimes(5);
    expect(child.stdin.write).toHaveBeenCalledWith("y\n");
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("rejects with stdout fallback when stderr is empty", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");
    await new Promise((r) => setTimeout(r, 10));

    child.stdout.emit("data", Buffer.from("Something went wrong\n"));
    child.emit("close", 3);

    await expect(done).rejects.toThrow(/Something went wrong/);
  });

  it("rejects with generic message when both stdout and stderr are empty", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const done = acceptLicenses("/opt/sdk/sdkmanager", "/opt/sdk");
    await new Promise((r) => setTimeout(r, 10));

    child.emit("close", 4);

    await expect(done).rejects.toThrow(/sdkmanager --licenses exited with code 4/);
  });
});
