import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyHookAdapters } from "../src/services/hook-adapters/index.js";
import { resolveBundleSyncManifestPath } from "../src/services/bundle-sync.js";
import {
  INSTALLED_MARKER_NAME,
  INSTALLED_MARKER_CONTENT,
} from "../src/services/hook-adapters/mullion-bundle.js";

// Issue #1944 — test/setup.ts gives every test file a throwaway HOME. This is
// the regression guard: an adapter launched with sessions.injectMullionBundle
// off runs managedInstall -> removeBundleContentForCli, which must land on the
// throwaway home and never on the developer's real ~/.claude or manifest.
describe("test HOME isolation (issue #1944)", () => {
  it("points os.homedir() at a throwaway directory, not the real account home", () => {
    const realHome = os.userInfo().homedir;
    expect(os.homedir()).not.toBe(realHome);
    expect(os.homedir().startsWith(os.tmpdir())).toBe(true);
  });

  it("a bundle-off claude launch removes from the throwaway home and leaves the real one alone", async () => {
    const realManifest = path.join(os.userInfo().homedir, ".mullion", "bundle-sync.json");
    const before = existsSync(realManifest) ? statSync(realManifest).mtimeMs : null;

    const skillDir = path.join(os.homedir(), ".claude", "skills", "mullion-host");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: mullion-host\n---\n");
    writeFileSync(path.join(skillDir, INSTALLED_MARKER_NAME), INSTALLED_MARKER_CONTENT);
    mkdirSync(path.dirname(resolveBundleSyncManifestPath()), { recursive: true });
    writeFileSync(
      resolveBundleSyncManifestPath(),
      JSON.stringify({
        version: 1,
        bundleHash: "x",
        entries: [{ path: skillDir, kind: "dir", hash: "x" }],
      }),
    );

    const dir = mkdtempSync(path.join(os.tmpdir(), "mullion-home-isolation-"));
    applyHookAdapters("claude", {
      sessionId: "1",
      sessionsDir: dir,
      hookSocketPath: path.join(dir, "hooks.sock"),
      hookToken: "tok",
      controlSocketPath: path.join(dir, "mullion.sock"),
      forwarderPath: "/abs/forwarder.mjs",
      injectAgentGuide: false,
      injectProjectBriefing: false,
      injectMullionBundle: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(existsSync(skillDir)).toBe(false);
    const after = existsSync(realManifest) ? statSync(realManifest).mtimeMs : null;
    expect(after).toBe(before);
  });
});
