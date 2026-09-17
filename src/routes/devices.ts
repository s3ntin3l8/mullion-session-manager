import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { devices } from "../db/schema.js";
import type { DeviceInfo } from "../services/device-manager.js";

// CRUD + one-shot action execution for devices (the `devices` DB table's
// own route — routes/device.ts, singular, is the separate live WS video/
// input route). Two distinct consumption modes, deliberately kept apart:
//
//   - The live WS panel (routes/device.ts) drives input through the scrcpy
//     control channel while a human/agent is actively watching the stream.
//   - `mullion device <verb>` (this route, via control-socket.ts's
//     "device.action" op) is request/response, plain `adb shell` commands
//     against Device.adbConnection — works whether or not anyone has the
//     panel open, same "CLI doesn't need a live viewer" posture
//     browser-automation.ts's executeBrowserAction has for the Controllable
//     Browser feature.
//
// Same "DB row is intent, DeviceManager is live truth" merge every other
// route in this app applies to sessions/previews — see AGENTS.md's own
// "non-obvious session model" note.

interface DeviceListItem {
  id: number;
  hostId: string;
  projectId: number | null;
  name: string | null;
  avdName: string;
  status: "active" | "killed";
  createdAt: string;
  live: DeviceInfo | null;
}

function toListItem(
  row: typeof devices.$inferSelect,
  live: DeviceInfo | undefined,
): DeviceListItem {
  return {
    id: row.id,
    hostId: row.hostId,
    projectId: row.projectId,
    name: row.name,
    avdName: row.avdName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    live: live ?? null,
  };
}

// Hermes review — @yume-chan/adb's `AdbNoneProtocolSubprocessService`
// builds its `exec:` service string as `command.join(" ")` (see that
// package's own source: adb's `exec:`/`shell:` transport is inherently a
// single string the device's OWN shell (`sh -c`) re-tokenizes — there is
// no argv-array adb service that skips shell interpretation). An
// argv element containing a space silently re-splits into extra shell
// words; one containing a shell metacharacter (`;`, `$()`, a backtick, …)
// EXECUTES on the device. Both `text` and `logcat`'s `filter` are
// arbitrary, agent-supplied strings reachable at session scope (device.*
// control-socket ops, control-socket.ts) — on-device command injection,
// not just a formatting bug. Standard POSIX single-quote escaping closes
// this for every spawnWaitText/spawnWait call in this file, numeric args
// included (quoting a digit string is a no-op, so applying it uniformly
// is simpler and safer than remembering which individual call sites carry
// untrusted content).
function shellQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function shellExecArgv(argv: string[]): string[] {
  return argv.map(shellQuoteArg);
}

type DeviceAction =
  | { action: "screenshot" }
  | { action: "tap"; x: number; y: number }
  | { action: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { action: "text"; text: string }
  | { action: "key"; androidKeyCode: number }
  | { action: "logcat"; lines?: number; filter?: string };

function isDeviceAction(value: unknown): value is DeviceAction {
  const v = value as Partial<DeviceAction> | null;
  if (typeof v !== "object" || v === null || typeof v.action !== "string") return false;
  switch (v.action) {
    case "screenshot":
      return true;
    case "tap":
      return typeof v.x === "number" && typeof v.y === "number";
    case "swipe":
      return (
        typeof v.x1 === "number" &&
        typeof v.y1 === "number" &&
        typeof v.x2 === "number" &&
        typeof v.y2 === "number"
      );
    case "text":
      return typeof v.text === "string";
    case "key":
      return typeof v.androidKeyCode === "number";
    case "logcat":
      // Unlike screenshot, logcat has two OPTIONAL fields — both must be
      // the right type when present, not just "any object passes" the way
      // this branch used to (Hermes review): a stray non-number `lines` or
      // non-string `filter` must 400 here, not surface as a confusing
      // downstream error once it reaches the shell-escaping in the
      // handler below.
      return (
        (v.lines === undefined || typeof v.lines === "number") &&
        (v.filter === undefined || typeof v.filter === "string")
      );
    default:
      return false;
  }
}

export async function devicesRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { avdName: string; projectId?: number; name?: string } }>(
    "/api/devices",
    async (request, reply) => {
      if (!app.config.DEVICE_ENABLED) {
        return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
      }
      const { avdName, projectId, name } = request.body;
      if (!avdName) return reply.badRequest("avdName is required");

      const [row] = app.db
        .insert(devices)
        .values({ avdName, projectId: projectId ?? null, name: name ?? null })
        .returning()
        .all();

      // Only the isScopeAlive() pre-check inside getOrCreate is awaited
      // here — the emulator's actual boot is still fire-and-forget, same
      // shape as PtyManager.getOrCreate: the caller gets the row back once
      // that quick check clears, live status is polled via GET afterward
      // (or observed by connecting the WS route, which naturally blocks
      // until streaming or error).
      try {
        await app.device.getOrCreate({ id: String(row.id), avdName: row.avdName, label: row.name });
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }

      reply.code(201);
      return toListItem(row, app.device.get(String(row.id))?.toInfo());
    },
  );

  app.get("/api/devices", async () => {
    const rows = app.db.select().from(devices).all();
    return rows.map((row) => toListItem(row, app.device.get(String(row.id))?.toInfo()));
  });

  app.get<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
    const [row] = app.db.select().from(devices).where(eq(devices.id, id)).all();
    if (!row) return reply.notFound(`No device ${id}`);
    return toListItem(row, app.device.get(String(row.id))?.toInfo());
  });

  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
    const [row] = app.db.select().from(devices).where(eq(devices.id, id)).all();
    if (!row) return reply.notFound(`No device ${id}`);

    // Flip intent BEFORE awaiting the live teardown — same TOCTOU-avoidance
    // shape session-lifecycle.ts's killSession uses (see its own comment):
    // a concurrent WS connect that lands mid-terminate must see "killed",
    // not a stale "active" row.
    app.db.update(devices).set({ status: "killed" }).where(eq(devices.id, id)).run();
    await app.device.terminate(String(id));

    reply.code(204);
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/devices/:id/action",
    async (request, reply) => {
      if (!app.config.DEVICE_ENABLED) {
        return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
      const [row] = app.db.select().from(devices).where(eq(devices.id, id)).all();
      if (!row) return reply.notFound(`No device ${id}`);
      if (!isDeviceAction(request.body)) return reply.badRequest("invalid action body");

      const device = app.device.get(String(id));
      const adb = device?.adbConnection;
      if (!adb) {
        return reply.badRequest(
          `device ${id} has no live adb connection (status: ${device?.toInfo().status ?? "not running"})`,
        );
      }

      const shell = adb.subprocess.noneProtocol;
      const action = request.body;
      switch (action.action) {
        case "screenshot": {
          const png = await shell.spawnWait(shellExecArgv(["screencap", "-p"]));
          return { screenshot: Buffer.from(png).toString("base64") };
        }
        case "tap": {
          await shell.spawnWaitText(
            shellExecArgv(["input", "tap", String(action.x), String(action.y)]),
          );
          return { ok: true };
        }
        case "swipe": {
          const args = [
            "input",
            "swipe",
            String(action.x1),
            String(action.y1),
            String(action.x2),
            String(action.y2),
          ];
          if (action.durationMs !== undefined) args.push(String(action.durationMs));
          await shell.spawnWaitText(shellExecArgv(args));
          return { ok: true };
        }
        case "text": {
          // Routed through the scrcpy control channel (same as the live WS
          // panel's own "text" input — routes/device.ts's dispatchInput),
          // NOT `adb shell input text`: that path re-tokenizes through the
          // device's own shell (see this file's shellQuoteArg comment) for
          // no reason — injectText needs no shell at all. Requires the
          // scrcpy connection specifically (not just adb), which can lag
          // adbConnection briefly during boot (device-manager.ts's spawn()
          // establishes adb, then pushes+starts scrcpy) — a clear 400 in
          // that narrow window rather than falling back to the shell.
          if (!device.controller) {
            return reply.badRequest(
              `device ${id} has no live scrcpy control connection yet (status: ${device.toInfo().status})`,
            );
          }
          await device.controller.injectText(action.text);
          return { ok: true };
        }
        case "key": {
          await shell.spawnWaitText(
            shellExecArgv(["input", "keyevent", String(action.androidKeyCode)]),
          );
          return { ok: true };
        }
        case "logcat": {
          const args = ["logcat", "-d", "-t", String(action.lines ?? 200)];
          if (action.filter) args.push(action.filter);
          const output = await shell.spawnWaitText(shellExecArgv(args));
          return { logcat: output };
        }
      }
    },
  );
}
