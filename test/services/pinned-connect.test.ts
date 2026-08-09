import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import {
  assertAllowedUrl,
  closePinnedConnectors,
  createPinnedLookup,
  findSsrfBlock,
  getPinnedDispatcher,
  getPinnedWsAgent,
  SsrfBlockedError,
} from "../../src/services/pinned-connect.js";
import type { PinnedResolver } from "../../src/services/pinned-connect.js";

// These are the only tests that can actually prove connection-time pinning
// works. `vi.stubGlobal("fetch", ...)` — this repo's usual outbound-HTTP
// pattern — replaces fetch entirely and so never reaches a dispatcher, and
// undici's MockAgent (test/services/oidc.integration.test.ts) intercepts
// *before* connect and so never reaches the lookup. Both would pass whether
// or not the guard exists. So the bulk of the coverage below drives
// createPinnedLookup directly with an injected resolver, plus one real
// loopback round trip at the bottom for the end-to-end wiring.

const ALLOW_ALL = { allowLoopback: true, allowPrivate: true };
const BLOCK_ALL = { allowLoopback: false, allowPrivate: false };

/** A resolver that answers every name with the same fixed address list. */
function fakeResolver(...addresses: string[]): PinnedResolver {
  return (_hostname, _options, callback) => {
    callback(
      null,
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
  };
}

/** Drives a lookup and returns whatever it called back with. */
function runLookup(
  policy: { allowLoopback: boolean; allowPrivate: boolean },
  resolver: PinnedResolver,
  options: { all?: boolean } = { all: true },
): Promise<{ err: Error | null; address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve) => {
    createPinnedLookup(policy, resolver)("host.example", options, (err, address, family) =>
      resolve({ err, address, family }),
    );
  });
}

describe("createPinnedLookup", () => {
  it("passes a public address through under either policy", async () => {
    for (const policy of [ALLOW_ALL, BLOCK_ALL]) {
      const { err, address } = await runLookup(policy, fakeResolver("93.184.216.34"));
      expect(err).toBeNull();
      expect(address).toEqual([{ address: "93.184.216.34", family: 4 }]);
    }
  });

  it("blocks link-local/cloud IMDS under *both* policies — the case the whole change exists for", async () => {
    for (const policy of [ALLOW_ALL, BLOCK_ALL]) {
      const { err } = await runLookup(policy, fakeResolver("169.254.169.254"));
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).address).toBe("169.254.169.254");
    }
    // AWS's IPv6 metadata address, in the bare (unbracketed) form a resolver
    // hands back — url-guard's own IPv6 branch only ever saw bracketed
    // URL hostnames before this.
    const { err } = await runLookup(ALLOW_ALL, fakeResolver("fd00:ec2::254"));
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it("applies the policy to loopback and private answers, allowing them only when the caller does", async () => {
    for (const address of ["127.0.0.1", "::1"]) {
      expect((await runLookup(ALLOW_ALL, fakeResolver(address))).err).toBeNull();
      expect((await runLookup(BLOCK_ALL, fakeResolver(address))).err).toBeInstanceOf(
        SsrfBlockedError,
      );
    }
    for (const address of ["10.0.0.5", "192.168.1.10", "fd12:3456::1"]) {
      expect((await runLookup(ALLOW_ALL, fakeResolver(address))).err).toBeNull();
      expect((await runLookup(BLOCK_ALL, fakeResolver(address))).err).toBeInstanceOf(
        SsrfBlockedError,
      );
    }
  });

  it("rejects the whole answer when any address is blocked, rather than using the good ones", async () => {
    // The attack this shape describes: a resolver answer that pairs a
    // legitimate public address with an internal one, betting the guard will
    // filter rather than refuse. Filtering would connect happily and call
    // itself safe.
    const { err } = await runLookup(
      BLOCK_ALL,
      fakeResolver("93.184.216.34", "127.0.0.1", "93.184.216.35"),
    );
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as SsrfBlockedError).address).toBe("127.0.0.1");
  });

  it("unwraps an IPv4-mapped answer in the dotted form only a resolver produces", async () => {
    // `new URL()` normalizes "::ffff:169.254.169.254" to the hex form, so
    // url-guard's URL path never sees this spelling — but dns.lookup returns
    // it verbatim for a family-6 resolution of an IPv4-only name.
    const { err } = await runLookup(ALLOW_ALL, fakeResolver("::ffff:169.254.169.254"));
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((await runLookup(BLOCK_ALL, fakeResolver("::ffff:127.0.0.1"))).err).toBeInstanceOf(
      SsrfBlockedError,
    );
    expect((await runLookup(ALLOW_ALL, fakeResolver("::ffff:127.0.0.1"))).err).toBeNull();
  });

  it("strips a zone id so a scoped link-local address can't slip past the exact-match forms", async () => {
    const { err } = await runLookup(ALLOW_ALL, fakeResolver("fe80::1%eth0"));
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it("honours both callback shapes — the array form is what autoSelectFamily requires", async () => {
    // Node calls lookup with `{ all: true }` by default and throws "Invalid
    // IP address: undefined" if handed the single-address form there. The
    // reverse shape has to keep working too.
    const all = await runLookup(ALLOW_ALL, fakeResolver("93.184.216.34"), { all: true });
    expect(all.address).toEqual([{ address: "93.184.216.34", family: 4 }]);

    const single = await runLookup(ALLOW_ALL, fakeResolver("93.184.216.34"), { all: false });
    expect(single.address).toBe("93.184.216.34");
    expect(single.family).toBe(4);
  });

  it("checks every address even when the caller only wanted one", async () => {
    // With `all: false` the socket uses the first address — but a blocked
    // one further down the list still means the answer is untrustworthy.
    const { err } = await runLookup(BLOCK_ALL, fakeResolver("93.184.216.34", "169.254.169.254"), {
      all: false,
    });
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it("passes a resolver failure through untouched and reports an empty answer as ENOTFOUND", async () => {
    const failing: PinnedResolver = (_h, _o, cb) => {
      const err: NodeJS.ErrnoException = new Error("nope");
      err.code = "EAI_AGAIN";
      cb(err, []);
    };
    const { err } = await runLookup(ALLOW_ALL, failing);
    expect((err as NodeJS.ErrnoException).code).toBe("EAI_AGAIN");
    expect(err).not.toBeInstanceOf(SsrfBlockedError);

    const empty = await runLookup(ALLOW_ALL, fakeResolver());
    expect((empty.err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

describe("assertAllowedUrl", () => {
  it("rejects an IP-literal host, which a lookup is never consulted for at all", () => {
    // Verified against Node directly: fetch("http://127.0.0.1:port") with a
    // pinning dispatcher calls lookup zero times. Pinning alone therefore
    // leaves literals unguarded on the connect path; this is what covers them.
    expect(() => assertAllowedUrl("http://169.254.169.254/latest/meta-data/", ALLOW_ALL)).toThrow(
      SsrfBlockedError,
    );
    expect(() => assertAllowedUrl("http://127.0.0.1:8080/", BLOCK_ALL)).toThrow(SsrfBlockedError);
    expect(() => assertAllowedUrl("http://127.0.0.1:8080/", ALLOW_ALL)).not.toThrow();
  });

  it("rejects a non-http(s) scheme and an unparseable value", () => {
    expect(() => assertAllowedUrl("file:///etc/passwd", ALLOW_ALL)).toThrow(SsrfBlockedError);
    expect(() => assertAllowedUrl("not-a-url", ALLOW_ALL)).toThrow(SsrfBlockedError);
  });

  it("accepts a URL object as well as a string", () => {
    expect(() => assertAllowedUrl(new URL("https://example.com/"), BLOCK_ALL)).not.toThrow();
  });
});

describe("findSsrfBlock", () => {
  it("digs the block out of the wrapper fetch() reports it in", () => {
    // fetch surfaces a lookup failure as `TypeError: fetch failed` with the
    // real error on `.cause`. Every catch site in the app collapses
    // connection failures into a generic "unreachable", so without this a
    // blocked host is indistinguishable from a down one.
    const blocked = new SsrfBlockedError("evil.example", "169.254.169.254", ALLOW_ALL);
    const wrapped = new TypeError("fetch failed", { cause: blocked });
    expect(findSsrfBlock(wrapped)).toBe(blocked);
    expect(findSsrfBlock(new Error("outer", { cause: wrapped }))).toBe(blocked);
  });

  it("finds it inside an AggregateError, which autoSelectFamily can produce", () => {
    const blocked = new SsrfBlockedError("evil.example", "10.0.0.1", BLOCK_ALL);
    expect(findSsrfBlock(new AggregateError([new Error("ECONNREFUSED"), blocked]))).toBe(blocked);
  });

  it("returns null for an ordinary network failure and doesn't loop on a cyclic cause", () => {
    expect(findSsrfBlock(new Error("ECONNREFUSED"))).toBeNull();
    expect(findSsrfBlock(undefined)).toBeNull();

    const cyclic = new Error("a");
    cyclic.cause = cyclic;
    expect(findSsrfBlock(cyclic)).toBeNull();
  });
});

describe("end-to-end through a real fetch (issue #250)", () => {
  // The wiring the unit tests above can't reach: a real dispatcher, a real
  // resolver, a real socket. "localhost" resolves to loopback via the OS
  // resolver, so this needs no external DNS.
  let server: http.Server;
  let port: number;

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePinnedConnectors();
  });

  it("blocks a hostname that resolves to a disallowed address, and allows it when policy permits", async () => {
    server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    // The gap issue #250 is about, end to end: a *hostname* (so the lookup
    // is genuinely consulted) resolving to loopback.
    const blocked = await fetch(`http://localhost:${port}/`, {
      dispatcher: getPinnedDispatcher(BLOCK_ALL),
    }).catch((err: unknown) => err);
    expect(blocked).toBeInstanceOf(Error);
    expect(findSsrfBlock(blocked)?.address).toMatch(/^(127\.0\.0\.1|::1)$/);

    const allowed = await fetch(`http://localhost:${port}/`, {
      dispatcher: getPinnedDispatcher(ALLOW_ALL),
    });
    expect(await allowed.text()).toBe("ok");
  });

  it("hands back a usable agent per scheme for the ws transport", () => {
    // `ws` takes an http(s).Agent, not a Dispatcher — the transport no
    // dispatcher can reach. Scheme selection matters: an http.Agent on a wss
    // URL would never negotiate TLS.
    expect(getPinnedWsAgent(ALLOW_ALL, "ws://example.com/x")).toHaveProperty("protocol", "http:");
    expect(getPinnedWsAgent(ALLOW_ALL, "wss://example.com/x")).toHaveProperty("protocol", "https:");
    // Memoized per (scheme, policy) so every host shares one pool.
    expect(getPinnedWsAgent(ALLOW_ALL, "ws://a.example/")).toBe(
      getPinnedWsAgent(ALLOW_ALL, "ws://b.example/"),
    );
    expect(getPinnedWsAgent(ALLOW_ALL, "ws://a.example/")).not.toBe(
      getPinnedWsAgent(BLOCK_ALL, "ws://a.example/"),
    );
  });
});
