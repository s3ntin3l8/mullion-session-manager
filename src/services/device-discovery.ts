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
  /** Fully-qualified service name (`Instance._type._tcp.local`) — stable
   * across A-record resolution and IP changes, unlike `host`/`addresses`.
   * Used as the cache key so a `down` event never misses the entry just
   * because the phone's IP changed mid-advertisement. */
  fqdn?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: unknown;
}

/** One bonjour-service advertisement, stored keyed by its `fqdn` (stable —
 * survives A-record resolution and IP changes, unlike `host`/`addresses`).
 * Pairing and connect services of the same phone have *different* fqdns;
 * they're grouped into one `DiscoveredDevice` at read time by their resolved
 * IP (see `getDiscovered`). */
interface ServiceRecord {
  type: (typeof BROWSER_TYPES)[number];
  fqdn: string;
  instanceName: string;
  host?: string;
  addresses?: string[];
  port?: number;
  txt?: unknown;
  /** ISO timestamp of the most recent upsert for this record. */
  lastSeen: string;
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
  private bonjour: InstanceType<typeof Bonjour> | null;
  // The Browser type isn't exported at the top level (it's namespaced under
  // `Bonjour.Browser`), so we keep the list untyped beyond what the
  // concrete methods we use (`stop`) need. Strict-mode won't accept `any`
  // wholesale, but the actual events we wire are typed at the handler
  // boundary.
  private readonly browsers: Array<{ stop(): void }> = [];
  // Keyed by the service's `fqdn` (stable across A-record resolution and IP
  // changes) — NOT by the resolved host, which can flip mid-advertisement
  // and would make a `down` event miss the entry it's supposed to evict.
  // Pairing + connect services of the same phone are grouped into one
  // `DiscoveredDevice` at read time by their resolved IP.
  private readonly cache = new Map<string, ServiceRecord>();
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

  /** Starts the underlying mDNS browsers. Idempotent. Re-constructs the
   * Bonjour instance if `stop()` tore one down (nulls `this.bonjour`) —
   * browsing on a destroyed instance would silently no-op on
   * bonjour-service@1.4.4. */
  start(): void {
    if (!this.opts.enabled) return;
    if (!this.bonjour) {
      this.bonjour = new Bonjour() as InstanceType<typeof Bonjour>;
    }
    if (this.browsers.length > 0) return;
    for (const type of BROWSER_TYPES) {
      const browser = this.bonjour.find({ type });
      browser.on("up", (service: RawService) => this.handleServiceUpsert(type, service));
      // bonjour-service emits `up` exactly once per fqdn (browser.js
      // addService); later A/TXT/SRV record changes arrive as
      // `srv-update`/`txt-update`, both of which call replaceService and
      // swap in a fresh object with the current addresses. Without wiring
      // these, an entry first seen before its A record resolves would keep
      // the hostname forever, and a `down` for a re-keyed service would
      // miss the cache entry it's supposed to evict.
      browser.on("srv-update", (service: RawService) => this.handleServiceUpsert(type, service));
      browser.on("txt-update", (service: RawService) => this.handleServiceUpsert(type, service));
      browser.on("down", (service: RawService) => this.handleServiceDown(type, service));
      this.browsers.push(browser);
    }
  }

  /** Stops all browsers and tears down the Bonjour instance. Idempotent.
   * Safe to call from a teardown hook after a process is already on its way
   * out — every Bonjour API used here is callback-based and we ignore the
   * callbacks on shutdown. Nulls `this.bonjour` so a later `start()` (the
   * announced lazy-bind reconfigure for the Settings-UI toggle) constructs
   * a fresh instance instead of browsing on the destroyed one — on
   * bonjour-service@1.4.4, `find()` after `destroy()` returns a Browser on
   * an already-closed socket without throwing, so discovery would go
   * silently dead. */
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
      this.bonjour = null;
    }
  }

  /** Returns a defensive snapshot of every device the scanner has seen
   * advertising. Each entry's `id` is its host IP — same value the REST
   * `pair-and-connect` endpoint accepts as `discoveryId`. Groups the
   * per-fqdn `ServiceRecord`s by their resolved IP and spreads each
   * `device` object so a caller mutating the returned array cannot reach
   * the live cache. Matches the `onChange` callback's spread convention. */
  getDiscovered(): DiscoveredDevice[] {
    return [...this.groupByHost().values()];
  }

  getById(id: string): DiscoveredDevice | undefined {
    return this.groupByHost().get(id);
  }

  /** Drop every service record whose resolved host is `id` — used by the
   * pair-and-connect route when it finds a cached address that fails
   * `isValidDeviceAddress` (poisoned cache entry), so the next picker
   * open gets a fresh scan rather than the same bad data. */
  evict(id: string): void {
    for (const [fqdn, record] of this.cache) {
      const host = this.resolveHost(record);
      if (host === id) this.cache.delete(fqdn);
    }
  }

  /** Inject a synthetic service event — test seam. Production never calls
   * this; the real path is `up`/`down` events from bonjour-service's own
   * Browser. The `kind` parameter lets tests pre-load state without going
   * through the bonjour-service round-trip (which would require a live
   * mDNS responder). */
  __debugHandleServiceForTest(type: string, service: RawService): void {
    const normalized = normalizeBonjourType(type);
    if (!normalized) return;
    this.handleServiceUpsert(normalized, service);
  }

  __debugHandleDownForTest(type: string, service: RawService): void {
    const normalized = normalizeBonjourType(type);
    if (!normalized) return;
    this.handleServiceDown(normalized, service);
  }

  private resolveHost(service: RawService | ServiceRecord): string | undefined {
    // bonjour-service populates `service.host` from the SRV-record target,
    // which is the mDNS *hostname* (e.g. `Android.local`) — not an IP.
    // `service.addresses[]` is built from the A/AAAA records and is the
    // only field that's an actual IP. Android's adb-over-TCP only listens
    // on IPv4, so:
    //   - addresses has at least one IPv4 → return it.
    //   - addresses has entries but NONE is IPv4 → return undefined
    //     (skip the entry — an IPv6 literal is not dialable by Android's
    //     IPv4-only adb listener and would be rejected by
    //     DEVICE_ADDRESS_PATTERN anyway; see the interface doc on `host`).
    //   - addresses is empty → fall back to `service.host` (rare — the
    //     very first `up` before the A-record query has resolved; may be a
    //     hostname, which adb resolves itself via nss-mdns if available).
    if (Array.isArray(service.addresses) && service.addresses.length > 0) {
      return service.addresses.find(isIPv4Literal);
    }
    if (typeof service.host === "string" && service.host.length > 0) {
      return service.host;
    }
    return undefined;
  }

  /** Collect the per-fqdn `ServiceRecord`s into host-grouped
   * `DiscoveredDevice`s — the read model used by `getDiscovered`,
   * `getById`, and the upsert/down handlers' freshness check. Pairing and
   * connect records for the same resolved IP merge into one entry; the
   * pairing record's TXT name wins for display (the screen the user is
   * looking at while typing the code), falling back to connect's TXT name
   * then either record's instance name. */
  private groupByHost(): Map<string, DiscoveredDevice> {
    // First pass: bucket records by resolved host, keeping pairing and
    // connect separate so the name-preference logic below can see both
    // regardless of insertion order.
    const groups = new Map<string, { pairing?: ServiceRecord; connect?: ServiceRecord }>();
    for (const record of this.cache.values()) {
      const host = this.resolveHost(record);
      if (!host || record.port === undefined) continue;
      let group = groups.get(host);
      if (!group) {
        group = {};
        groups.set(host, group);
      }
      if (record.type === PAIRING_TYPE) group.pairing = record;
      else group.connect = record;
    }

    // Second pass: build the merged DiscoveredDevice for each host.
    const byHost = new Map<string, DiscoveredDevice>();
    for (const [host, group] of groups) {
      const pairing = group.pairing;
      const connect = group.connect;
      // Prefer the pairing record (the one the user is staring at on the
      // phone); fall back to connect when pairing hasn't been seen.
      const primary = pairing ?? connect;
      if (!primary) continue;

      const device: DiscoveredDevice = {
        id: host,
        name: primary.instanceName,
        host,
        discoveredAt: primary.lastSeen,
      };

      if (pairing) device.pairingAddress = `${host}:${pairing.port}`;
      if (connect) device.connectAddress = `${host}:${connect.port}`;

      // TXT-derived fields. Check pairing's TXT first, then connect's;
      // fall back to the instance name of whichever record we have.
      const txtName =
        readTxtString(pairing?.txt, "name") ??
        readTxtString(pairing?.txt, "device") ??
        readTxtString(connect?.txt, "name") ??
        readTxtString(connect?.txt, "device") ??
        primary.instanceName;
      const deviceSerial =
        readTxtString(pairing?.txt, "device") ?? readTxtString(connect?.txt, "device");
      const model = readTxtString(pairing?.txt, "model") ?? readTxtString(connect?.txt, "model");
      const product =
        readTxtString(pairing?.txt, "product") ?? readTxtString(connect?.txt, "product");

      device.name = txtName ?? device.name;
      if (deviceSerial) device.device = deviceSerial;
      if (model) device.model = model;
      if (product) device.product = product;

      // `discoveredAt` is the most recent upsert across both services.
      const latest = [pairing, connect].reduce<string | undefined>(
        (acc, r) => (r && (!acc || r.lastSeen > acc) ? r.lastSeen : acc),
        undefined,
      );
      if (latest) device.discoveredAt = latest;

      byHost.set(host, device);
    }
    return byHost;
  }

  private handleServiceUpsert(type: (typeof BROWSER_TYPES)[number], service: RawService): void {
    const fqdn = service.fqdn;
    if (!fqdn) return;
    const port = typeof service.port === "number" ? service.port : undefined;
    if (port === undefined) return;
    const host = this.resolveHost(service);

    const existing = this.cache.get(fqdn);
    const oldHost = existing ? this.resolveHost(existing) : undefined;

    // Was this host already visible (via THIS or another record) before
    // this upsert? Snapshot the group map BEFORE mutating the cache so
    // `up` vs `update` distinguishes "first time we've seen this phone"
    // from "second service of a pair / re-advertise / A-record landed".
    const wasVisible = host !== undefined && this.groupByHost().has(host);

    this.cache.set(fqdn, {
      type,
      fqdn,
      instanceName: service.name,
      host: service.host,
      addresses: service.addresses,
      port,
      txt: service.txt,
      lastSeen: this.now(),
    });

    // Re-key: this record's resolved host changed (typically the first
    // A-record landing after an `up` that fell back to the hostname).
    // If the OLD host no longer has any records grouping under it, emit
    // `down` for it so consumers drop the phantom hostname entry rather
    // than seeing it linger in their snapshot forever.
    if (oldHost !== undefined && host !== undefined && oldHost !== host) {
      const oldStillVisible = this.groupByHost().has(oldHost);
      if (!oldStillVisible) {
        this.opts.onChange?.({ kind: "down", id: oldHost });
      }
    }

    if (!host) return;
    const device = this.groupByHost().get(host);
    if (!device) return;
    this.opts.onChange?.({
      kind: wasVisible ? "update" : "up",
      device: { ...device },
    });
  }

  private handleServiceDown(type: (typeof BROWSER_TYPES)[number], service: RawService): void {
    const fqdn = service.fqdn;
    if (!fqdn) return;
    const record = this.cache.get(fqdn);
    if (!record || record.type !== type) return;

    const host = this.resolveHost(record);
    this.cache.delete(fqdn);
    if (!host) return;

    // Is the phone still visible via its OTHER service (pairing or
    // connect)? If yes → `update` (one address dropped); if no → `down`
    // (phone gone).
    const remaining = this.groupByHost().get(host);
    if (remaining) {
      this.opts.onChange?.({ kind: "update", device: { ...remaining } });
      return;
    }
    this.opts.onChange?.({ kind: "down", id: host });
  }
}
