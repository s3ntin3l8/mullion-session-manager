import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCommand } from "../../src/cli/core.mjs";

function fakeIo() {
  const written: Buffer[] = [];
  return {
    stdin: new EventEmitter(),
    stdout: { write: vi.fn((chunk: Buffer | string) => written.push(Buffer.from(chunk))) },
    stderr: { write: vi.fn() },
    written,
    getSize: () => ({ cols: 80, rows: 24 }),
    onResize: () => () => {},
    onInterrupt: () => {},
    setRawMode: vi.fn(),
    env: {},
    gitTarget: (): { repo?: string; branch?: string } => ({}),
  };
}

function fakeClient(overrides: Partial<{ request: unknown }> = {}) {
  return {
    tokenSource: "MULLION_AUTH_TOKEN",
    close: vi.fn(),
    request: vi.fn(async () => ({ ok: true })),
    openStream: vi.fn(),
    ...overrides,
  };
}

describe("mullion task list / get (issue #3165)", () => {
  it("task list formats one line per task (id, status, title) by default", async () => {
    const tasks = [
      { id: 1, status: "ready", title: "First task" },
      { id: 2, status: "in_progress", title: "Second task" },
    ];
    const client = fakeClient({ request: vi.fn(async () => tasks) });
    const io = fakeIo();
    const code = await runCommand(["task", "list"], { client, io });
    expect(code).toBe(0);
    expect(client.request).toHaveBeenCalledWith("tasks.list", {});
    expect(io.written.join("")).toBe("1\tready\tFirst task\n2\tin_progress\tSecond task\n");
  });

  it("task list forwards --status and --project and supports --json", async () => {
    const tasks = [{ id: 5, status: "ready", title: "Filtered" }];
    const client = fakeClient({ request: vi.fn(async () => tasks) });
    const io = fakeIo();
    const code = await runCommand(
      ["task", "list", "--status", "ready", "--project", "3", "--json"],
      { client, io },
    );
    expect(code).toBe(0);
    expect(client.request).toHaveBeenCalledWith("tasks.list", {
      status: "ready",
      projectId: "3",
    });
    expect(JSON.parse(io.written.join(""))).toEqual(tasks);
  });

  it("task get fetches a single task by id and outputs JSON", async () => {
    const task = { id: 42, status: "done", title: "Done task" };
    const client = fakeClient({ request: vi.fn(async () => task) });
    const io = fakeIo();
    const code = await runCommand(["task", "get", "42", "--json"], { client, io });
    expect(code).toBe(0);
    expect(client.request).toHaveBeenCalledWith("tasks.get", { taskId: "42" });
    expect(JSON.parse(io.written.join(""))).toEqual(task);
  });

  it("task get exits 2 when id is missing and exits 1 on 404", async () => {
    const missingIo = fakeIo();
    const missingCode = await runCommand(["task", "get"], {
      client: fakeClient(),
      io: missingIo,
    });
    expect(missingCode).toBe(2);

    const err = Object.assign(new Error("Not Found"), { status: 404 });
    const notFoundClient = fakeClient({ request: vi.fn().mockRejectedValue(err) });
    const notFoundIo = fakeIo();
    const notFoundCode = await runCommand(["task", "get", "99999"], {
      client: notFoundClient,
      io: notFoundIo,
    });
    expect(notFoundCode).toBe(1);
    expect(notFoundIo.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Not Found"));
  });
});
