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

describe("mullion task retry / start / close / archive / unarchive (issue #3173)", () => {
  it("task retry sends tasks.retry, prints id and status, and supports --agent/--review-agent/--json", async () => {
    const task = { id: 42, status: "ready" };
    const client = fakeClient({ request: vi.fn(async () => task) });
    const io = fakeIo();
    const code = await runCommand(["task", "retry", "42"], { client, io });
    expect(code).toBe(0);
    expect(client.request).toHaveBeenCalledWith("tasks.retry", { taskId: "42" });
    expect(io.written.join("")).toBe("42\tready\n");

    const jsonIo = fakeIo();
    const jsonCode = await runCommand(
      ["task", "retry", "42", "--agent", "codex", "--review-agent", "hermes", "--json"],
      { client, io: jsonIo },
    );
    expect(jsonCode).toBe(0);
    expect(client.request).toHaveBeenLastCalledWith("tasks.retry", {
      taskId: "42",
      agent: "codex",
      reviewAgent: "hermes",
    });
    expect(JSON.parse(jsonIo.written.join(""))).toEqual(task);
  });

  it("task start sends tasks.start and prints resulting status", async () => {
    const task = { id: 10, status: "claimed" };
    const client = fakeClient({ request: vi.fn(async () => task) });
    const io = fakeIo();
    const code = await runCommand(["task", "start", "10", "--agent", "claude"], { client, io });
    expect(code).toBe(0);
    expect(client.request).toHaveBeenCalledWith("tasks.start", { taskId: "10", agent: "claude" });
    expect(io.written.join("")).toBe("10\tclaimed\n");
  });

  it("task close sends tasks.close with optional --reason and prints resulting status", async () => {
    const task = { id: 11, status: "failed", failureReason: "superseded" };
    const client = fakeClient({ request: vi.fn(async () => task) });
    const io = fakeIo();
    const code = await runCommand(["task", "close", "11", "--reason", "superseded"], {
      client,
      io,
    });
    expect(code).toBe(0);
    expect(client.request).toHaveBeenCalledWith("tasks.close", {
      taskId: "11",
      reason: "superseded",
    });
    expect(io.written.join("")).toBe("11\tfailed\n");
  });

  it("task archive and unarchive send tasks.archive / tasks.unarchive and print status", async () => {
    const archivedTask = { id: 12, status: "done", archivedAt: "2026-11-17T00:00:00.000Z" };
    const unarchivedTask = { id: 12, status: "done", archivedAt: null };
    const client = fakeClient({
      request: vi.fn().mockResolvedValueOnce(archivedTask).mockResolvedValueOnce(unarchivedTask),
    });

    const archIo = fakeIo();
    expect(await runCommand(["task", "archive", "12"], { client, io: archIo })).toBe(0);
    expect(client.request).toHaveBeenNthCalledWith(1, "tasks.archive", { taskId: "12" });
    expect(archIo.written.join("")).toBe("12\tdone\tarchived\n");

    const unarchIo = fakeIo();
    expect(await runCommand(["task", "unarchive", "12"], { client, io: unarchIo })).toBe(0);
    expect(client.request).toHaveBeenNthCalledWith(2, "tasks.unarchive", { taskId: "12" });
    expect(unarchIo.written.join("")).toBe("12\tdone\tunarchived\n");
  });

  it("exits 2 when id is missing and exits 1 with route message on refused transition", async () => {
    for (const verb of ["retry", "start", "close", "archive", "unarchive"]) {
      const io = fakeIo();
      expect(await runCommand(["task", verb], { client: fakeClient(), io })).toBe(2);
    }

    const err = Object.assign(new Error("Task is not failed (status: ready)"), { status: 409 });
    const client = fakeClient({ request: vi.fn().mockRejectedValue(err) });
    const io = fakeIo();
    const code = await runCommand(["task", "retry", "99"], { client, io });
    expect(code).toBe(1);
    expect(io.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Task is not failed (status: ready)"),
    );
  });
});
