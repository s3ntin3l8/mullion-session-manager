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
 * Bonjour instance is ever constructed, no mDNS socket bound. The
 * `intervalMs` knob is honored only as a poll-tick rate for the
 * `getDiscovered()` snapshot freshness; bonjour-service itself is push-based
 * (Browser emits `up`/`down` events), so a long interval just means stale
 * snapshots, not missed events. */
export interface DeviceDiscoveryOptions {
  enabled: boolean;
  /** Periodic tick at which `getDiscovered()` returns a fresh snapshot.
   * Defaults to 2500ms (matches the env default). bonjour-service's own
   * Browser is push-based, so this only affects staleness on the consumer
   * side. */
  intervalMs: number;
  /** Called for every up/down/update transition. Mostly here for tests —
   * production consumers poll `getDiscovered()` rather than subscribe. */
  onChange?: (change: DiscoveryChange) => void;
}

const PAIRING_TYPE = "_adb-tls-pairing._tcp";
const CONNECT_TYPE = "_adb-tls-connect._tcp";

// Service types bonjour-service expects: `_adb-tls-pairing._tcp` minus the
// leading `_` and the trailing `.tcp`. The library handles the protocol/
// subtype split itself when constructing the query.
const BROWSER_TYPES = [PAIRING_TYPE, CONNECT_TYPE] as const;

function normalizeBonjourType(serviceType: string): (typeof BROWSER_TYPES)[number] | null {
  // bonjour-service surfaces `type` as `_adb-tls-pairing._tcp` verbatim
  // (leading underscore, trailing `._tcp`), but be defensive about both
  // shapes in case a future mDNS responder formats it differently.
  if (serviceType === PAIRING_TYPE || serviceType === "_adb-tls-pairing") return PAIRING_TYPE;
  if (serviceType === CONNECT_TYPE || serviceType === "_adb-tls-connect") return CONNECT_TYPE;
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
   * `pair-and-connect` endpoint accepts as `discoveryId`. */
  getDiscovered(): DiscoveredDevice[] {
    return [...this.cache.values()].map((entry) => entry.device);
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
    if (typeof service.host === "string" && service.host.length > 0) {
      return service.host;
    }
    // bonjour-service sometimes leaves `host` unset on the first `up` event
    // before the A-record resolves; fall back to the first address.
    if (Array.isArray(service.addresses) && service.addresses.length > 0) {
      return service.addresses[0];
    }
    return undefined;
  }

  private handleServiceUp(type: (typeof BROWSER_TYPES)[number], service: RawService): void {
    const host = this.resolveHost(service);
    if (!host) return;
    const port = typeof service.port === "number" ? service.port : undefined;
    if (port === undefined) return;

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

    this.opts.onChange?.({ kind: "up", device: { ...entry.device } });
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
