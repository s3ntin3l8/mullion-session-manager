import Bonjour from "bonjour-service";

// bonjour-service exports its `Bonjour` symbol both as a class (default
// export, `new`-able) and a namespace (re-exports of Service/Browser/etc.).
// The default import here is the class itself; we don't need the namespace
// re-exports because we touch the Browser/Service types through the return
// value of `find()`, which is typed at the use site.

// Android advertises wireless-debugging endpoints over mDNS while Wireless
// debugging is enabled (Settings → Developer options → Wireless debugging):
//
//   _adb-tls-pairing._tcp  — the one-time pairing listener; `wireless.pair()`
//                            dials it with the 6-digit code shown on screen.
//   _adb-tls-connect._tcp  — the longer-lived adb-over-TCP listener;
//                            `wireless.connect()` dials it after pairing.
//
// Both services are advertised from the same device IP and share most of
// their TXT record (name / model / device-serial / product) — the matching
// key is the host IP, with the device-serial from TXT as a tiebreaker when
// two devices NAT to the same external address (rare, but seen on some
// home-routed setups). We group by host so a phone shows up as ONE entry in
// the UI with both pairingAddress + connectAddress, not two duplicate rows.
//
// Discovery is best-effort and read-only — if mDNS doesn't reach the phone
// (segmented LAN, mDNS-reflector not configured, etc.) the existing manual
// address+code entry path stays fully functional; nothing here is in the
// critical path of actually pairing a device.

/** A device the scanner has seen advertising mDNS. Stable `id` is the host
 * IP, since both pairing and connect services come from the same phone. */
export interface DiscoveredDevice {
  /** Stable per-device id (`host`) — used by the REST layer to round-trip a
   * selection from the modal back to `pair-and-connect` without re-scanning. */
  id: string;
  /** Display name from the pairing TXT record (e.g. "Pixel 7"). Falls back
   * to the connect TXT name if the pairing record hasn't been seen yet. */
  name: string;
  /** The IP the phone advertised itself at — what `adb pair`/`adb connect`
   * dial. IPv4 only for now; bonjour-service will surface AAAA records too
   * but Android's adb-over-TCP only listens on IPv4. */
  host: string;
  /** `host:port` for the pairing listener, if seen. Until it's seen the UI
   * can't offer "Pair" against this entry yet — manual fallback remains. */
  pairingAddress?: string;
  /** `host:port` for the connect listener, if seen. Same UX caveat. */
  connectAddress?: string;
  /** Android device-serial from TXT, used as a fingerprint to match against
   * existing physical `devices` rows when prompting reconnect (issue #1380).
   * Best-effort — older Android versions omit it. */
  device?: string;
  /** `model` from TXT (e.g. "Pixel 7"). Optional, for UI labelling. */
  model?: string;
  /** `product` from TXT (e.g. "panther"). Optional, for UI labelling. */
  product?: string;
  /** ISO timestamp of the most recent `up` event for either service. */
  discoveredAt: string;
}

/** Reason a service entry was evicted from the cache. Surfaced in
 * `onChange` callbacks so tests can assert on the lifecycle without
 * poking the internals. */
export type DiscoveryChange =
  | { kind: "up"; device: DiscoveredDevice }
  | { kind: "down"; id: string }
  | { kind: "update"; device: DiscoveredDevice };

/** Configuration knobs. `enabled: false` short-circuits everything — no
 * Bonjour instance is ever constructed, no mDNS socket bound. */
export interface DeviceDiscoveryOptions {
  enabled: boolean;
  /** Called for every up/down/update transition. Mostly here for tests —
   * production consumers poll `getDiscovered()` rather than subscribe. */
  onChange?: (change: DiscoveryChange) => void;
}

// Canonical short form — what bonjour-service expects on `find({type})`,
// and what the `up`-event `type` field then surfaces back. See the load-
// bearing comment on `BROWSER_TYPES` below for why the short form (and
// not the full `_adb-tls-pairing._tcp`) is correct.
const PAIRING_TYPE = "adb-tls-pairing";
const CONNECT_TYPE = "adb-tls-connect";

// Service types bonjour-service expects — and this is the load-bearing
// detail that determines whether the scanner matches a real advertisement:
// bonjour-service's `find({type})` constructs its PTR browse name as
// `'_'+type+'._tcp.local'` (see `dist/lib/browser.js`). Passing the full
// `_adb-tls-pairing._tcp` would produce the browse name
// `__adb-tls-pairing._tcp._tcp.local`, which no real Android advertisement
// matches (Android advertises the canonical `_adb-tls-pairing._tcp.local`).
// The short form `adb-tls-pairing` is what bonjour-service expects; the
// library re-adds the surrounding `_` and `._tcp` itself. We still accept
// the long form in `normalizeBonjourType` for callers that surface an
// `up`-event type in the longer shape (a future mDNS responder could in
// principle format it differently), so both shapes remain interchangeable
// at the handler boundary.
const BROWSER_TYPES = [PAIRING_TYPE, CONNECT_TYPE] as const;

function normalizeBonjourType(serviceType: string): (typeof BROWSER_TYPES)[number] | null {
  // bonjour-service's Browser surfaces the `up`-event `type` field in
  // whichever form was passed to `find()` — today that's the short form
  // (see BROWSER_TYPES), but accept the long form too in case a future
  // mDNS responder formats it that way. Always return the short form so
  // downstream comparisons against PAIRING_TYPE/CONNECT_TYPE stay simple.
  if (serviceType === PAIRING_TYPE || serviceType === "_adb-tls-pairing._tcp") return PAIRING_TYPE;
  if (serviceType === CONNECT_TYPE || serviceType === "_adb-tls-connect._tcp") return CONNECT_TYPE;
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTxtString(txt: unknown, key: string): string | undefined {
  if (!isPlainObject(txt)) return undefined;
  const raw = txt[key];
  if (typeof raw === "string") return raw;
  // bonjour-service sometimes returns Buffer for binary TXT keys; coerce.
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return undefined;
}

interface RawService {
  name: string;
  type: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: unknown;
}

interface HostEntry {
  device: DiscoveredDevice;
  pairingPort?: number;
  connectPort?: number;
  // Per-type TXT fields, kept separate so the display name prefers the
  // pairing record (the one the user is staring at on their phone) but
  // falls back to the connect record when only that's been seen.
  pairingName?: string;
  connectName?: string;
  deviceSerial?: string;
  model?: string;
  product?: string;
}

// Practical IPv4-literal check — `:`-free dotted-quad shape. We don't need
// full RFC validation here; the goal is just to pick v4 out of a mixed v4/v6
// `addresses[]` array. The common `192.168.x.x` / `10.x.x.x` shapes phones
// advertise all match; loopback/link-local IPv4 likewise.
function isIPv4Literal(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.includes(":")) return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return false;
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

export class DeviceDiscoveryService {
  private readonly opts: DeviceDiscoveryOptions;
  private readonly bonjour: InstanceType<typeof Bonjour> | null;
  // The Browser type isn't exported at the top level (it's namespaced under
  // `Bonjour.Browser`), so we keep the list untyped beyond what the
  // concrete methods we use (`stop`) need. Strict-mode won't accept `any`
  // wholesale, but the actual events we wire are typed at the handler
  // boundary.
  private readonly browsers: Array<{ stop(): void }> = [];
  private readonly cache = new Map<string, HostEntry>();
  // Captured `Date` at the moment a service transitioned up. Used both as
  // the displayed `discoveredAt` and (loosely) as a freshness hint — true
  // TTL eviction is handled by bonjour-service's own goodbyes.
  private readonly now = () => new Date().toISOString();

  constructor(opts: DeviceDiscoveryOptions) {
    this.opts = opts;
    if (!opts.enabled) {
      this.bonjour = null;
      return;
    }
    // `new Bonjour()` binds a UDP socket on construction and queries
    // immediately — defer until the caller actually wants discovery
    // running. Plugin wiring (src/plugins/device.ts) only calls start()
    // after this returns, so a disabled service never even opens the
    // socket. The default export is a class (newable) per bonjour-service's
    // own index.d.ts, but TypeScript sees it as `typeof Bonjour` (the
    // namespace) — assert to the instance type here.
    this.bonjour = new Bonjour() as InstanceType<typeof Bonjour>;
  }

  /** Starts the underlying mDNS browsers. Idempotent. */
  start(): void {
    if (!this.bonjour) return;
    if (this.browsers.length > 0) return;
    for (const type of BROWSER_TYPES) {
      const browser = this.bonjour.find({ type });
      browser.on("up", (service: RawService) => this.handleServiceUp(type, service));
      browser.on("down", (service: RawService) => this.handleServiceDown(type, service));
      this.browsers.push(browser);
    }
  }

  /** Stops all browsers and tears down the Bonjour instance. Idempotent.
   * Safe to call from a teardown hook after a process is already on its way
   * out — every Bonjour API used here is callback-based and we ignore the
   * callbacks on shutdown. */
  stop(): void {
    for (const browser of this.browsers) {
      try {
        browser.stop();
      } catch {
        // Bonjour.stop() can throw if the underlying socket is already
        // closed; teardown must never throw.
      }
    }
    this.browsers.length = 0;
    if (this.bonjour) {
      try {
        this.bonjour.destroy();
      } catch {
        // Same teardown tolerance.
      }
    }
  }

  /** Returns a defensive snapshot of every device the scanner has seen
   * advertising. Each entry's `id` is its host IP — same value the REST
   * `pair-and-connect` endpoint accepts as `discoveryId`. Spreads each
   * `device` object so a caller mutating the returned array cannot reach
   * the live cache entry (which `handleServiceUp`/`Down` mutate in place
   * — and the REST layer JSON-serializes whatever we hand back). Matches
   * the `onChange` callback's spread convention. */
  getDiscovered(): DiscoveredDevice[] {
    return [...this.cache.values()].map((entry) => ({ ...entry.device }));
  }

  getById(id: string): DiscoveredDevice | undefined {
    return this.cache.get(id)?.device;
  }

  /** Inject a synthetic service event — test seam. Production never calls
   * this; the real path is `up`/`down` events from bonjour-service's own
   * Browser. The `kind` parameter lets tests pre-load state without going
   * through the bonjour-service round-trip (which would require a live
   * mDNS responder). */
  __debugHandleServiceForTest(type: string, service: RawService): void {
    const normalized = normalizeBonjourType(type);
    if (!normalized) return;
    this.handleServiceUp(normalized, service);
  }

  __debugHandleDownForTest(type: string, service: RawService): void {
    const normalized = normalizeBonjourType(type);
    if (!normalized) return;
    this.handleServiceDown(normalized, service);
  }

  private resolveHost(service: RawService): string | undefined {
    // bonjour-service populates `service.host` from the SRV-record target,
    // which is the mDNS *hostname* (e.g. `Android.local`) — not an IP.
    // `service.addresses[]` is built from the A/AAAA records and is the
    // only field that's an actual IP. Android's adb-over-TCP only listens
    // on IPv4, so prefer the first IPv4 entry and only fall back to
    // `service.host` if no A-records came back at all (rare — happens on
    // the very first `up` event before the A-record query has resolved).
    if (Array.isArray(service.addresses) && service.addresses.length > 0) {
      const ipv4 = service.addresses.find(isIPv4Literal);
      if (ipv4) return ipv4;
      const anyAddress = service.addresses[0];
      if (typeof anyAddress === "string" && anyAddress.length > 0) return anyAddress;
    }
    if (typeof service.host === "string" && service.host.length > 0) {
      return service.host;
    }
    return undefined;
  }

  private handleServiceUp(type: (typeof BROWSER_TYPES)[number], service: RawService): void {
    const host = this.resolveHost(service);
    if (!host) return;
    const port = typeof service.port === "number" ? service.port : undefined;
    if (port === undefined) return;

    const isFresh = !this.cache.has(host);
    let entry = this.cache.get(host);
    if (!entry) {
      entry = {
        device: {
          id: host,
          name: service.name,
          host,
          discoveredAt: this.now(),
        },
      };
      this.cache.set(host, entry);
    }

    if (type === PAIRING_TYPE) {
      entry.pairingPort = port;
      entry.device.pairingAddress = `${host}:${port}`;
      entry.pairingName = service.name;
    } else {
      entry.connectPort = port;
      entry.device.connectAddress = `${host}:${port}`;
      entry.connectName = service.name;
    }

    // TXT-derived fields. Prefer the pairing record (the screen the user is
    // looking at while typing the code) but fall back to the connect record
    // if only that's been seen.
    const txtName =
      readTxtString(service.txt, "name") ??
      readTxtString(service.txt, "device") ??
      (type === PAIRING_TYPE ? entry.pairingName : entry.connectName);
    const deviceSerial = readTxtString(service.txt, "device");
    const model = readTxtString(service.txt, "model");
    const product = readTxtString(service.txt, "product");

    if (txtName) entry.device.name = txtName;
    if (deviceSerial) {
      entry.deviceSerial = deviceSerial;
      entry.device.device = deviceSerial;
    }
    if (model) {
      entry.model = model;
      entry.device.model = model;
    }
    if (product) {
      entry.product = product;
      entry.device.product = product;
    }

    entry.device.discoveredAt = this.now();

    // `up` means the host was not in the cache before this event — the
    // first service (either pairing or connect) to arrive from a phone
    // introduces it. Subsequent `up` events for an already-known host —
    // the second service arriving, or a service re-advertising — are
    // `update`. Consumers that want "something new showed up" should
    // listen for `up`; consumers that want "the picture changed" should
    // listen for `update`. This keeps the two semantics distinct, which
    // the previous always-`up`-on-every-event shape didn't.
    this.opts.onChange?.({
      kind: isFresh ? "up" : "update",
      device: { ...entry.device },
    });
  }

  private handleServiceDown(type: (typeof BROWSER_TYPES)[number], service: RawService): void {
    const host = this.resolveHost(service);
    if (!host) return;
    const entry = this.cache.get(host);
    if (!entry) return;
    if (type === PAIRING_TYPE) {
      entry.pairingPort = undefined;
      entry.device.pairingAddress = undefined;
      entry.pairingName = undefined;
    } else {
      entry.connectPort = undefined;
      entry.device.connectAddress = undefined;
      entry.connectName = undefined;
    }
    // Drop the entry entirely if neither service is left — there's nothing
    // to display anymore.
    if (entry.pairingPort === undefined && entry.connectPort === undefined) {
      this.cache.delete(host);
      this.opts.onChange?.({ kind: "down", id: host });
      return;
    }
    this.opts.onChange?.({ kind: "update", device: { ...entry.device } });
  }
}
