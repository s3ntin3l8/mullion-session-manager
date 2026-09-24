import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { devices } from "../db/schema.js";
import type { DeviceInfo, DeviceKind } from "../services/device-manager.js";

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
  kind: DeviceKind;
  avdName: string | null;
  serial: string | null;
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
    kind: row.kind,
    avdName: row.avdName,
    serial: row.serial,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    live: live ?? null,
  };
}

// A physical device's adb TCP address, as both the one-time pairing address
// (`adb pair <host:port>`) and the ongoing connect address (`adb connect
// <host:port>`) — Android shows a DIFFERENT port for each, but both are the
// same "host:port" shape. Validated as an allowlist, not shell-escaped:
// DeviceManager.pair()/getOrCreate() pass this straight into
// AdbServerClient.wireless.pair()/connect(), which builds an adb SERVICE
// STRING (`host:pair:<password>:<address>`), not a shell command — a stray
// `:` or newline here corrupts that framing, so shellQuoteArg (below, used
// only for the on-device `adb shell` action route) is the wrong tool for
// this input.
const DEVICE_ADDRESS_PATTERN = /^([A-Za-z0-9.-]+):(\d{1,5})$/;

function isValidDeviceAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  const match = DEVICE_ADDRESS_PATTERN.exec(address);
  if (!match) return false;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535;
}

// The 6-digit code Android's Wireless debugging screen shows during
// pairing.
const PAIRING_CODE_PATTERN = /^\d{6}$/;

function isValidPairingCode(code: unknown): code is string {
  return typeof code === "string" && PAIRING_CODE_PATTERN.test(code);
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

interface CreateDeviceBody {
  kind?: DeviceKind;
  // Emulator form.
  avdName?: string;
  // Physical form — the adb connect address ("host:port").
  address?: string;
  projectId?: number;
  name?: string;
}

export async function devicesRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateDeviceBody }>("/api/devices", async (request, reply) => {
    if (!app.config.DEVICE_ENABLED) {
      return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
    }
    const { kind = "emulator", avdName, address, projectId, name } = request.body ?? {};

    if (kind === "physical") {
      if (avdName !== undefined) {
        return reply.badRequest("avdName must not be set for a physical device");
      }
      if (!isValidDeviceAddress(address)) {
        return reply.badRequest("address must be host:port (e.g. 192.168.1.23:37251)");
      }

      // Guard against two `devices` rows racing to own the same adb
      // address — Device.connectPhysical() deliberately treats
      // AlreadyConnectedError as success (needed for the restart-reattach
      // case, where the adb server already has this address connected from
      // before a Mullion restart), so a second insert for the same address
      // would otherwise succeed too and produce a second in-memory Device
      // independently pushing/starting its own scrcpy server against the
      // same live serial. Emulators get an equivalent guard for free via
      // allocatePort() (see readActiveDevicePorts()); physical devices have
      // no port to collide on, so this checks the address directly.
      // Synchronous, no `await` in between, and better-sqlite3 is
      // synchronous too — this check-then-insert can't interleave with
      // another request's.
      const [existingActive] = app.db
        .select({ id: devices.id })
        .from(devices)
        .where(
          and(
            eq(devices.status, "active"),
            eq(devices.kind, "physical"),
            eq(devices.serial, address),
          ),
        )
        .all();
      if (existingActive) {
        return reply.conflict(
          `device ${existingActive.id} is already active for address ${address}`,
        );
      }

      const [row] = app.db
        .insert(devices)
        .values({
          kind: "physical",
          serial: address,
          avdName: null,
          projectId: projectId ?? null,
          name: name ?? null,
        })
        .returning()
        .all();

      // Same fire-and-forget-past-the-quick-check shape as the emulator
      // branch below — see that branch's own comment.
      try {
        await app.device.getOrCreate({
          id: String(row.id),
          kind: "physical",
          avdName: null,
          serial: address,
          label: row.name,
          port: null,
        });
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }

      reply.code(201);
      return toListItem(row, app.device.get(String(row.id))?.toInfo());
    }

    if (address !== undefined) {
      return reply.badRequest("address must not be set for an emulator device");
    }
    if (!avdName) return reply.badRequest("avdName is required");

    const [row] = app.db
      .insert(devices)
      .values({
        kind: "emulator",
        avdName,
        serial: null,
        projectId: projectId ?? null,
        name: name ?? null,
      })
      .returning()
      .all();

    // Only the isScopeAlive() pre-check inside getOrCreate is awaited
    // here — the emulator's actual boot is still fire-and-forget, same
    // shape as PtyManager.getOrCreate: the caller gets the row back once
    // that quick check clears, live status is polled via GET afterward
    // (or observed by connecting the WS route, which naturally blocks
    // until streaming or error).
    try {
      await app.device.getOrCreate({
        id: String(row.id),
        kind: "emulator",
        avdName,
        serial: null,
        label: row.name,
        port: row.port,
      });
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }

    reply.code(201);
    return toListItem(row, app.device.get(String(row.id))?.toInfo());
  });

  // Stateless — pairing writes a key into the adb SERVER's own keystore,
  // outside Mullion's ownership (see the schema's own comment on
  // `devices.kind`), so this creates no `devices` row. A separate
  // `POST /api/devices` call (kind: "physical") does the actual `adb
  // connect` afterward. Deliberately off the CRUD resource rather than a
  // sub-route of it, since it doesn't touch one.
  app.post<{ Body: { pairingAddress?: string; pairingCode?: string } }>(
    "/api/devices/pair",
    async (request, reply) => {
      if (!app.config.DEVICE_ENABLED) {
        return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
      }
      const { pairingAddress, pairingCode } = request.body ?? {};
      if (!isValidDeviceAddress(pairingAddress)) {
        return reply.badRequest("pairingAddress must be host:port (e.g. 192.168.1.23:41234)");
      }
      if (!isValidPairingCode(pairingCode)) {
        return reply.badRequest("pairingCode must be the 6-digit code shown on the device");
      }
      try {
        await app.device.pair(pairingAddress, pairingCode);
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }
      reply.code(200);
      return { ok: true };
    },
  );

  // Atomic pair-then-connect-and-insert for the new "Pair a phone" modal
  // (issue #1378). The phone-discovery UX shows the user one button; behind
  // it, two adb wire-protocol calls plus a DB row insert. Exactly one of
  // `discoveryId` or `pairingAddress` is required — the former looks the
  // cached mDNS entry up for both pairing + connect addresses, the latter
  // is the manual fallback for networks where mDNS doesn't reach.
  //
  // `connectAddress` is REQUIRED when going the manual route (the user has
  // to type both ports, same as the legacy two-form flow, but in a single
  // POST). With a `discoveryId` it's optional — the cache normally has it,
  // and we only ask for it as a manual override if it doesn't.
  //
  // Same full-scope-only blast-radius reasoning as the existing
  // `device.pair` op (control-socket.ts:1100) — this dials an arbitrary
  // network address a caller supplies. The route itself does NOT gate on
  // scope; the control-socket handler does, when called via CLI/MCP.
  app.post<{
    Body: {
      discoveryId?: string;
      pairingAddress?: string;
      connectAddress?: string;
      pairingCode?: string;
      name?: string;
    };
  }>("/api/devices/pair-and-connect", async (request, reply) => {
    if (!app.config.DEVICE_ENABLED) {
      return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
    }
    const { discoveryId, pairingAddress, connectAddress, pairingCode, name } = request.body ?? {};

    if (!isValidPairingCode(pairingCode)) {
      return reply.badRequest("pairingCode must be the 6-digit code shown on the device");
    }

    // Resolve the two adb addresses. `discoveryId` wins if both are set —
    // the cache is always fresher than what the user typed, and silently
    // mixing the two (e.g. typed pairing address + discovered connect
    // address for a DIFFERENT phone) would be a confusing failure mode.
    let resolvedPairing: string | undefined;
    let resolvedConnect: string | undefined;

    if (typeof discoveryId === "string" && discoveryId.length > 0) {
      const cached = app.deviceDiscovery.getById(discoveryId);
      if (!cached) {
        return reply.badRequest(
          `discoveryId ${JSON.stringify(discoveryId)} is no longer in the discovery cache — re-open the picker`,
        );
      }
      // DeviceManager.pair()'s own doc states "address/password are
      // validated by the route before this is reached" — that invariant
      // must hold on the cached branch too, not just the manual one below.
      // A poisoned cache entry (e.g. an IPv6 literal that slipped past
      // resolveHost, or a stale hostname:port that no longer parses) would
      // otherwise reach wireless.pair()'s `host:pair:<code>:<address>`
      // framing and corrupt it on the `:` separators. Evict so the next
      // picker open gets a fresh scan rather than the same bad data.
      if (cached.pairingAddress !== undefined && !isValidDeviceAddress(cached.pairingAddress)) {
        app.deviceDiscovery.evict(discoveryId);
        app.log.warn(
          { discoveryId, pairingAddress: cached.pairingAddress },
          "discovery cache contained an invalid pairingAddress — evicted",
        );
        return reply.badRequest(
          "discovery cache contains an invalid address — re-open the picker to refresh",
        );
      }
      if (cached.connectAddress !== undefined && !isValidDeviceAddress(cached.connectAddress)) {
        app.deviceDiscovery.evict(discoveryId);
        app.log.warn(
          { discoveryId, connectAddress: cached.connectAddress },
          "discovery cache contained an invalid connectAddress — evicted",
        );
        return reply.badRequest(
          "discovery cache contains an invalid address — re-open the picker to refresh",
        );
      }
      resolvedPairing = cached.pairingAddress;
      resolvedConnect = cached.connectAddress;
      // User-supplied `connectAddress` overrides the cached one — useful
      // when discovery sees the wrong port (e.g. mDNS reached a different
      // transport than the one Mullion's adb server can actually use).
      if (typeof connectAddress === "string" && connectAddress.length > 0) {
        if (!isValidDeviceAddress(connectAddress)) {
          return reply.badRequest("connectAddress must be host:port");
        }
        resolvedConnect = connectAddress;
      }
    } else if (typeof pairingAddress === "string" && pairingAddress.length > 0) {
      if (!isValidDeviceAddress(pairingAddress)) {
        return reply.badRequest("pairingAddress must be host:port (e.g. 192.168.1.23:41234)");
      }
      resolvedPairing = pairingAddress;
      if (!isValidDeviceAddress(connectAddress)) {
        return reply.badRequest(
          "connectAddress is required in manual mode — both Android's pairing port and connect port must be supplied",
        );
      }
      resolvedConnect = connectAddress;
    } else {
      return reply.badRequest("either discoveryId or pairingAddress is required");
    }

    if (!resolvedConnect) {
      return reply.badRequest(
        "this device's connect service was not advertised — supply connectAddress manually",
      );
    }

    // Address-collision guard — same reasoning as POST /api/devices's own
    // kind:"physical" branch above: two rows racing for the same serial
    // would each spin up their own scrcpy against the same live device,
    // since connectPhysical()'s AlreadyConnectedError handling is
    // correct-but-permissive for the restart-reattach case. The INSERT
    // below is synchronous (better-sqlite3) with no `await` between this
    // check and it, so a concurrent double-click can't interleave — the
    // second request finds the row and gets 409. Insert the row FIRST
    // (intent), then attempt pair(): if pair() fails the row stays (same
    // no-rollback posture as POST /api/devices), and the collision guard
    // remains airtight because there's still no `await` between check and
    // insert.
    const [existingActive] = app.db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          eq(devices.status, "active"),
          eq(devices.kind, "physical"),
          eq(devices.serial, resolvedConnect),
        ),
      )
      .all();
    if (existingActive) {
      return reply.conflict(
        `device ${existingActive.id} is already active for address ${resolvedConnect}`,
      );
    }

    const [row] = app.db
      .insert(devices)
      .values({
        kind: "physical",
        serial: resolvedConnect,
        avdName: null,
        projectId: null,
        name: name ?? null,
      })
      .returning()
      .all();

    // Pairing is attempted UNLESS we have evidence the phone is NOT in
    // pairing mode: the discovery cache saw the connect service for this
    // host but never the pairing one. Android stops advertising the
    // pairing port the moment the user navigates off the "Pair device with
    // pairing code" screen, and again after a successful pair (the
    // keystore now has a key for this host, so re-pairing would fail
    // anyway). In both those cases skipping pair() and going straight to
    // connect is correct.
    //
    // In manual mode (`discoveryId` absent) we have no idea whether the
    // phone is in pairing mode — the modal's user just typed both ports —
    // so we always try pair() there. If it fails (wrong code, host
    // unreachable, port-closed-because-already-paired, etc.) we surface
    // the error directly; the modal renders it and the user can re-open
    // the phone's pairing screen and retry. We deliberately don't fall
    // through to a "blind connect" attempt on pair-failure: that hides the
    // most common user error (typo'd code) behind a different confusing
    // downstream error, and a fresh pair attempt is cheap.
    //
    // `resolvedPairing` is `string | undefined` because it can be unset in
    // the cached connect-only case, but we only reach the pair() call when
    // it's been validated upstream — the narrowing is per-branch:
    const skipPairBecauseCachedConnectOnly =
      resolvedPairing === undefined && typeof discoveryId === "string" && discoveryId.length > 0;
    if (!skipPairBecauseCachedConnectOnly) {
      // Both branches leading here guarantee a pairing address:
      //   - manual mode → resolvedPairing came from the user's
      //     `pairingAddress` (validated at the top of this handler)
      //   - discovery mode with a pairing service → resolvedPairing came
      //     from the cache's `pairingAddress`, which was validated by
      //     isValidDeviceAddress above before being assigned.
      try {
        await app.device.pair(resolvedPairing as string, pairingCode);
      } catch (err) {
        // Roll back the row we just inserted: a wrong code is the most
        // common failure (typo) and the user will immediately retry —
        // leaving the row would make that retry hit the collision guard
        // with a confusing 409 instead of re-attempting pair(). The
        // delete is synchronous; by the time pair() has rejected, any
        // concurrent request has already either received 409 (the row
        // existed when its synchronous guard ran) or inserted its own row
        // before ours landed — either way this delete only removes OUR
        // row and doesn't reopen the race the insert-before-pair ordering
        // closed.
        app.db.delete(devices).where(eq(devices.id, row.id)).run();
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }
    }

    try {
      await app.device.getOrCreate({
        id: String(row.id),
        kind: "physical",
        avdName: null,
        serial: resolvedConnect,
        label: row.name,
        port: null,
      });
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : String(err));
    }

    reply.code(201);
    return toListItem(row, app.device.get(String(row.id))?.toInfo());
  });

  app.get("/api/devices", async () => {
    const rows = app.db.select().from(devices).all();
    return rows.map((row) => toListItem(row, app.device.get(String(row.id))?.toInfo()));
  });

  // Issue #1378 — read-only mDNS snapshot of nearby Android phones that
  // are currently advertising `_adb-tls-pairing._tcp` and/or
  // `_adb-tls-connect._tcp`. Empty array when discovery is disabled or
  // nothing is in range — never an error, so a disabled-discovery deploy
  // can still render the empty-list UI cleanly. Returned alongside the
  // matching connect address when both are known, so the modal can offer
  // a single-click "Pair & Connect" without re-fetching.
  app.get("/api/devices/discovered", async () => {
    if (!app.config.DEVICE_DISCOVERY_ENABLED) return [];
    return app.deviceDiscovery.getDiscovered();
  });

  app.get<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
    const [row] = app.db.select().from(devices).where(eq(devices.id, id)).all();
    if (!row) return reply.notFound(`No device ${id}`);
    return toListItem(row, app.device.get(String(row.id))?.toInfo());
  });

  // Edits a physical device's stored adb address in place — issue #1347,
  // the follow-up to the v1 wireless-debugging support (kind: "physical"
  // above): Android randomizes the wireless-debugging port every time the
  // toggle is cycled, and a reboot drops the connection entirely, so the
  // persisted `serial` routinely goes stale. Without this, the only fix was
  // delete-and-recreate, losing the row's `id`/history. Physical only — an
  // emulator's `serial` is synthesized (`emulator-<port>`) from its own
  // `port` column, not user-supplied, so there is nothing here for an
  // emulator row to edit.
  app.patch<{ Params: { id: string }; Body: { address?: string } }>(
    "/api/devices/:id",
    async (request, reply) => {
      if (!app.config.DEVICE_ENABLED) {
        return reply.badRequest("Device panel is disabled — set DEVICE_ENABLED=true.");
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.badRequest("id path param is required");
      const [row] = app.db.select().from(devices).where(eq(devices.id, id)).all();
      if (!row) return reply.notFound(`No device ${id}`);
      if (row.kind !== "physical") {
        return reply.badRequest("only a physical device's address can be edited");
      }
      // No un-kill path exists anywhere in this API (DELETE only ever flips
      // status forward, never back) — an address edit on a killed row would
      // have nothing reachable to reconnect, so this rejects rather than
      // silently rewriting a dead row's address.
      if (row.status !== "active") {
        return reply.badRequest("cannot edit the address of a stopped device");
      }
      const { address } = request.body ?? {};
      if (!isValidDeviceAddress(address)) {
        return reply.badRequest("address must be host:port (e.g. 192.168.1.23:37251)");
      }

      // Row records intent BEFORE the reconnect below — same ordering
      // DELETE uses (see its own comment) — and is never rolled back if the
      // reconnect fails: a transient adb hiccup must not discard the user's
      // edit, same reasoning Device.attach()'s own comment gives for why a
      // connection failure there doesn't tear down what it didn't create.
      const [updated] = app.db
        .update(devices)
        .set({ serial: address })
        .where(eq(devices.id, id))
        .returning()
        .all();

      // The existing live Device (if any) is still connected at the OLD,
      // now-stale address — getOrCreate() below is a no-op against it
      // (existing.isAlive is true for "booting"/"streaming", same guard
      // POST's create path relies on), so it must be torn down first or
      // this PATCH would silently persist the new address while leaving
      // the live connection pointed at the dead one. terminate() never
      // touches the DB row (only the in-memory map), so `updated.status`
      // stays "active" throughout.
      await app.device.terminate(String(id), "physical");

      try {
        await app.device.getOrCreate({
          id: String(id),
          kind: "physical",
          avdName: null,
          serial: address,
          label: updated.name,
          port: null,
        });
      } catch (err) {
        return reply.badRequest(err instanceof Error ? err.message : String(err));
      }

      return toListItem(updated, app.device.get(String(id))?.toInfo());
    },
  );

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
    await app.device.terminate(String(id), row.kind);

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
