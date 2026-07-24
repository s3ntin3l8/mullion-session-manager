import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getCodexHookTrust } from "../../../src/services/hook-adapters/codex-trust.js";

// Mirrors codex.test.ts's own CODEX_HOME temp-dir convention. MULLION_HOME is
// also pinned here (to an arbitrary, non-existent path — resolveForwarderPath
// only ever joins it, never touches the filesystem) so the forwarder path
// getCodexHookTrust() resolves is deterministic across dev/CI, rather than
// depending on where this repo happens to be checked out — see shared.ts.
describe("getCodexHookTrust (issue #259)", () => {
  let codexHome: string;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalMullionHome = process.env.MULLION_HOME;
  const mullionHome = "/opt/mullion";
  const forwarderPath = path.join(mullionHome, "current", "dist", "hooks", "forwarder.mjs");

  beforeEach(() => {
    codexHome = mkdtempSync(path.join(os.tmpdir(), "mullion-codex-trust-"));
    process.env.CODEX_HOME = codexHome;
    process.env.MULLION_HOME = mullionHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
    else process.env.MULLION_HOME = originalMullionHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  function mullionGroup(kind: "Stop" | "PostToolUse") {
    return {
      ...(kind === "PostToolUse" ? { matcher: "apply_patch" } : {}),
      hooks: [{ type: "command", command: `node ${forwarderPath} codex ${kind}` }],
    };
  }

  function writeHooksJson(hooks: Record<string, unknown[]>) {
    writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks }));
  }

  function writeConfigToml(trustedKeys: string[]) {
    const hooksPath = path.join(codexHome, "hooks.json");
    const body = trustedKeys
      .map((key) => `[hooks.state."${hooksPath}:${key}"]\ntrusted_hash = "sha256:deadbeef"\n`)
      .join("\n");
    writeFileSync(path.join(codexHome, "config.toml"), body);
  }

  it('reports "not-installed" when hooks.json does not exist', () => {
    expect(getCodexHookTrust()).toBe("not-installed");
  });

  it('reports "not-installed" when hooks.json is malformed JSON', () => {
    writeFileSync(path.join(codexHome, "hooks.json"), "not json at all");
    expect(getCodexHookTrust()).toBe("not-installed");
  });

  it('reports "not-installed" when hooks.json has no Mullion-owned group', () => {
    writeHooksJson({ Stop: [{ hooks: [{ type: "command", command: "./my-own-script.sh" }] }] });
    expect(getCodexHookTrust()).toBe("not-installed");
  });

  it('reports "pending" when the Mullion group is present but config.toml does not exist', () => {
    writeHooksJson({ Stop: [mullionGroup("Stop")], PostToolUse: [mullionGroup("PostToolUse")] });
    expect(getCodexHookTrust()).toBe("pending");
  });

  it('reports "trusted" once ANY one of the Mullion groups is trusted, not requiring every event', () => {
    // Deliberately `.some()`, not `.every()` — see getCodexHookTrust's own
    // comment for why: a real install observed only PostToolUse ever
    // getting a trust entry, with no Stop entry at all despite active use.
    // Requiring every registered event to individually show up trusted
    // risks a banner that can never clear for a user who already completed
    // Codex's `/hooks` review.
    writeHooksJson({ Stop: [mullionGroup("Stop")], PostToolUse: [mullionGroup("PostToolUse")] });
    writeConfigToml(["post_tool_use:0:0"]);
    expect(getCodexHookTrust()).toBe("trusted");
  });

  it('reports "trusted" once both Mullion groups are granted trust', () => {
    writeHooksJson({ Stop: [mullionGroup("Stop")], PostToolUse: [mullionGroup("PostToolUse")] });
    writeConfigToml(["stop:0:0", "post_tool_use:0:0"]);
    expect(getCodexHookTrust()).toBe("trusted");
  });

  it("keys the trust lookup off the Mullion group's own index, not always 0", () => {
    writeHooksJson({
      Stop: [{ hooks: [{ type: "command", command: "./my-own-script.sh" }] }, mullionGroup("Stop")],
    });
    // Trusting index 0 (the user's own group) must not count as trusting
    // Mullion's group at index 1.
    writeConfigToml(["stop:0:0"]);
    expect(getCodexHookTrust()).toBe("pending");

    writeConfigToml(["stop:1:0"]);
    expect(getCodexHookTrust()).toBe("trusted");
  });

  it("ignores a stale group from a previous Mullion release — reports on the current forwarder path only", () => {
    const staleForwarderPath = path.join(
      "/opt/mullion",
      "releases",
      "0.2.1",
      "dist",
      "hooks",
      "forwarder.mjs",
    );
    writeHooksJson({
      Stop: [
        { hooks: [{ type: "command", command: `node ${staleForwarderPath} codex Stop` }] },
        mullionGroup("Stop"),
      ],
      PostToolUse: [mullionGroup("PostToolUse")],
    });
    // Only the CURRENT (index-1 Stop, index-0 PostToolUse) groups are
    // trusted; the stale group at Stop index 0 has no trust entry at all.
    writeConfigToml(["stop:1:0", "post_tool_use:0:0"]);
    expect(getCodexHookTrust()).toBe("trusted");
  });
});
