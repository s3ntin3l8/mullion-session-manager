import type { Device, DiscoveredDevice } from "../../api/index.js";

// Issue #1380 — pairs a stored physical device row with the mDNS entry that
// says the same phone has come back on a different connect port (Android
// re-rolls that port every time Wireless debugging is toggled; issue #1347's
// manual Edit-address button was the only remedy until now).

export interface ReconnectSuggestion {
  // Discovered entries that plausibly are this row's phone, best match first.
  // One entry → a plain "Reconnect to <name>?" prompt; several → the row
  // renders a disambiguation prompt with one button per candidate.
  candidates: DiscoveredDevice[];
  // True when the pick isn't unambiguous: several candidates, or another
  // physical row claims the same phone.
  ambiguous: boolean;
}

// `host:port` → host. IPv6 literals must be bracketed (`[fe80::1]:5555`); a
// bare, unbracketed IPv6 address (`fe80::1`) has no port to split off and is
// rejected rather than mis-split at one of its own colons.
export function hostOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const m = /^\[([^\]]+)\]:\d+$/.exec(address) ?? /^([^:[\]]+):\d+$/.exec(address);
  return m ? m[1] : null;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function nameMatches(device: Device, d: DiscoveredDevice): boolean {
  const own = norm(device.name);
  if (!own) return false;
  return own === norm(d.name) || own === norm(d.model);
}

// Returns row id → suggestion for every active physical row whose stored
// address is stale. Matching order (the mDNS record carries no stable
// hardware fingerprint the rows also store, so the closest stable signals
// are used): (1) same host, (2) if the phone also changed IP, same
// user-given name as the advertised name/model. A row already pointing at a
// currently-advertised connect address is up to date and never prompts.
export function findReconnectSuggestions(
  devices: Device[],
  discovered: DiscoveredDevice[],
): Map<number, ReconnectSuggestion> {
  const out = new Map<number, ReconnectSuggestion>();
  const rows = devices.filter((d) => d.kind === "physical" && d.status === "active" && d.serial);
  // An advertised address another stored row already points at belongs to
  // that row's phone — never offer it to a different row.
  const claimed = new Set(devices.filter((d) => d.serial).map((d) => d.serial as string));
  const connectable = discovered.filter((d) => d.connectAddress && !claimed.has(d.connectAddress));
  const advertised = new Set(discovered.map((d) => d.connectAddress));
  const stale = rows.filter((r) => !advertised.has(r.serial as string));

  for (const row of stale) {
    const host = hostOf(row.serial);
    if (!host) continue;
    let candidates = connectable.filter((d) => d.host === host);
    // A name-only match (the phone changed IP) is a weaker signal than a
    // host match — names like "Pixel" collide — so it's always confirmed
    // via the ambiguity-style prompt rather than a plain one.
    const nameOnly = candidates.length === 0;
    if (nameOnly) candidates = connectable.filter((d) => nameMatches(row, d));
    if (candidates.length === 0) continue;
    // Prefer an advertised name/model match when a host serves several.
    candidates = [...candidates].sort(
      (a, b) => Number(nameMatches(row, b)) - Number(nameMatches(row, a)),
    );
    // Another stale row on the same host competes for the same candidates.
    const sharing = stale.filter((o) => o.id !== row.id && hostOf(o.serial) === host).length > 0;
    out.set(row.id, { candidates, ambiguous: candidates.length > 1 || sharing || nameOnly });
  }
  return out;
}
