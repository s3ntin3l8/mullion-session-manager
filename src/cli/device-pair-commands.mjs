/**
 * CLI handlers for `mullion device pair | discovered | pair-and-connect`
 * (#1378, #3399). Each takes an optional `--host <hostId>` that targets an
 * enrolled agent host's adb server instead of the primary's.
 */
export function createDevicePairCommands({ extractFlags, requireOne, CliUsageError }) {
  return {
    // A separate verb from `create` rather than an optional flag on it:
    // `create` does `requireOne(args, "avd name")` unconditionally (this
    // file's own explicit-verb convention, see this const's header comment),
    // and pairing/connecting take entirely different arguments (a pairing
    // address + code, or a connect address) with no AVD name at all — making
    // that conditional would fight the shape every other verb here follows.
    async pair(client, args) {
      const { flags, rest } = extractFlags(args, { host: "string" });
      const pairingAddress = requireOne(rest, "pairing address (host:port)");
      const pairingCode = rest[1];
      if (pairingCode === undefined) throw new CliUsageError("pairing code is required");
      const body = { pairingAddress, pairingCode };
      if (typeof flags.host === "string" && flags.host.length > 0) body.hostId = flags.host;
      return { json: await client.request("device.pair", body) };
    },
    // Lists nearby phones in Wireless-debugging mode (mDNS snapshot from
    // GET /api/devices/discovered). Empty array when DEVICE_DISCOVERY_ENABLED
    // is false or nothing is in range — both are returned as `[]`, not as an
    // error, mirroring the REST endpoint's "empty is a valid answer" posture.
    async discovered(client, args) {
      const { flags, rest } = extractFlags(args, { host: "string" });
      if (rest.length > 0) {
        throw new CliUsageError(
          "device discovered takes only --host <hostId> (use --json for machine-readable output)",
        );
      }
      const body = {};
      if (typeof flags.host === "string" && flags.host.length > 0) body.hostId = flags.host;
      return { json: await client.request("device.discovered", body) };
    },
    // Atomic pair + connect + insert — the text equivalent of the new "Pair
    // a phone" modal (issue #1378). Two modes:
    //
    //   device pair-and-connect --discovery-id 192.168.1.23 --pairing-code 123456
    //
    // drives pair+connect from a cached mDNS entry (use `device discovered`
    // to find one). `--connect-address` overrides the cached connect port
    // when mDNS reached the wrong transport.
    //
    //   device pair-and-connect --pairing-address 192.168.1.23:41234 \
    //     --connect-address 192.168.1.23:37251 --pairing-code 123456
    //
    // is the manual fallback for networks where mDNS doesn't reach — both
    // ports must be supplied.
    //
    // Quoted-key form because the CLI's verb lookup is verbatim — see how
    // sessionCommands' "spawn-child" (line 768) does the same.
    "pair-and-connect": async (client, args) => {
      const { flags } = extractFlags(args, {
        "discovery-id": "string",
        "pairing-address": "string",
        "connect-address": "string",
        "pairing-code": "string",
        name: "string",
        host: "string",
      });
      if (flags["pairing-code"] === undefined)
        throw new CliUsageError("--pairing-code is required");
      const hasDiscovery =
        typeof flags["discovery-id"] === "string" && flags["discovery-id"].length > 0;
      const hasManual =
        typeof flags["pairing-address"] === "string" && flags["pairing-address"].length > 0;
      if (hasDiscovery === hasManual)
        throw new CliUsageError("exactly one of --discovery-id or --pairing-address is required");
      const body = { pairingCode: flags["pairing-code"] };
      if (hasDiscovery) body.discoveryId = flags["discovery-id"];
      else body.pairingAddress = flags["pairing-address"];
      if (typeof flags["connect-address"] === "string" && flags["connect-address"].length > 0)
        body.connectAddress = flags["connect-address"];
      if (typeof flags.name === "string" && flags.name.length > 0) body.name = flags.name;
      if (typeof flags.host === "string" && flags.host.length > 0) body.hostId = flags.host;
      return { json: await client.request("device.pair-and-connect", body) };
    },
  };
}
