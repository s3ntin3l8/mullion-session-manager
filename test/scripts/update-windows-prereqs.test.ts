// scripts/update-windows-prereqs.mjs -- the parts that decide what gets pinned,
// fed fixtures of the vendors' listings (the network half is not tested).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyPins,
  parseNodeShasums,
  pickPortableGit,
  renderPins,
  run,
} from "../../scripts/update-windows-prereqs.mjs";

const hash = (c: string) => c.repeat(64);

const SHASUMS = [
  `${hash("a")}  node-v26.12.1-darwin-arm64.tar.gz`,
  `${hash("b")}  node-v26.12.1-win-arm64.zip`,
  `${hash("c")}  node-v26.12.1-win-x64.zip`,
  `${hash("d")}  node-v26.12.1-x64.msi`,
].join("\n");

const RELEASE = {
  assets: [
    { name: "Git-2.56.0.4-64-bit.exe", digest: `sha256:${hash("1")}`, browser_download_url: "u1" },
    {
      name: "PortableGit-2.56.0.4-64-bit.7z.exe",
      digest: `sha256:${hash("2")}`,
      browser_download_url: "https://example.test/PortableGit-2.56.0.4-64-bit.7z.exe",
    },
    {
      name: "PortableGit-2.56.0.4-arm64.7z.exe",
      digest: `sha256:${hash("3")}`,
      browser_download_url: "u3",
    },
  ],
};

describe("update-windows-prereqs", () => {
  it("picks the win-x64 zip of the required Node major", () => {
    expect(parseNodeShasums(SHASUMS, "26")).toEqual({
      nodeVersion: "26.12.1",
      nodeUrl: "https://nodejs.org/dist/v26.12.1/node-v26.12.1-win-x64.zip",
      nodeSha256: hash("c"),
    });
  });

  it("refuses a listing for another major, and one with no win-x64 zip", () => {
    expect(() => parseNodeShasums(SHASUMS, "27")).toThrow(/expected a Node 27/);
    expect(() => parseNodeShasums("nothing here", "26")).toThrow(/no win-x64 zip/);
  });

  it("picks the 64-bit PortableGit asset and its GitHub digest", () => {
    expect(pickPortableGit(RELEASE)).toEqual({
      gitVersion: "2.56.0.4",
      gitUrl: "https://example.test/PortableGit-2.56.0.4-64-bit.7z.exe",
      gitSha256: hash("2"),
    });
  });

  it("refuses a PortableGit asset with no digest, and a release with none", () => {
    expect(() =>
      pickPortableGit({ assets: [{ ...RELEASE.assets[1], digest: undefined }] }),
    ).toThrow(/no sha256 digest/);
    expect(() => pickPortableGit({ assets: [RELEASE.assets[0]] })).toThrow(/no 64-bit PortableGit/);
  });

  it("rewrites the pins block of the real script, keeping the rest and the line endings", () => {
    const script = fs.readFileSync(
      fileURLToPath(new URL("../../deploy/windows/mullion-install.ps1", import.meta.url)),
      "utf8",
    );
    const pins = {
      ...parseNodeShasums(SHASUMS, "26"),
      ...pickPortableGit(RELEASE),
    };
    const updated = applyPins(script, pins);
    expect(updated).toContain(
      renderPins(pins).replace(/\n/g, script.includes("\r\n") ? "\r\n" : "\n"),
    );
    expect(updated).toContain(`$PinNodeSha256 = '${hash("c")}'`);
    // rcedit is a fixed pin: it comes back unchanged, from the updater's own table.
    expect(updated).toMatch(
      /\$PinRceditUrl = 'https:\/\/github\.com\/electron\/rcedit\/releases\/download\/v[\d.]+\/rcedit-x64\.exe'/,
    );
    expect(updated).toMatch(/\$PinRceditSha256 = '[0-9a-f]{64}' # pragma: allowlist secret/);
    // Applying the same pins again changes nothing.
    expect(applyPins(updated, pins)).toBe(updated);
    // Everything outside the block is untouched.
    const outside = (s: string) => s.replace(/# BEGIN PINS[\s\S]*# END PINS/, "");
    expect(outside(updated)).toBe(outside(script));
  });

  it("refuses a script without the markers", () => {
    expect(() => applyPins("no markers", {})).toThrow(/markers are missing/);
  });

  describe("run", () => {
    const script = fs.readFileSync(
      fileURLToPath(new URL("../../deploy/windows/mullion-install.ps1", import.meta.url)),
      "utf8",
    );
    const fetchText =
      (calls: string[] = []) =>
      async (url: string) => {
        calls.push(url);
        return new URL(url).hostname === "nodejs.org" ? SHASUMS : JSON.stringify(RELEASE);
      };
    // Never the real script: a run that gets as far as writing must not touch it.
    const quiet = {
      log: () => {},
      logError: () => {},
      writeScript: () => {
        throw new Error("this test must not write the script");
      },
    };

    it("fetches the listing for the required major only, and rewrites a stale script", async () => {
      const calls: string[] = [];
      const written: string[] = [];
      const logs: string[] = [];
      const code = await run({
        engines: ">=26",
        fetchText: fetchText(calls),
        readScript: () => script,
        writeScript: (t) => written.push(t),
        log: (m) => logs.push(m),
        logError: () => {},
      });
      expect(code).toBe(0);
      expect(calls[0]).toBe("https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt");
      expect(calls[1]).toBe("https://api.github.com/repos/git-for-windows/git/releases/latest");
      expect(written).toHaveLength(1);
      expect(written[0]).toContain(`$PinNodeSha256 = '${hash("c")}'`);
      expect(logs[0]).toMatch(/^updated the pins: Node 26\.12\.1, Git 2\.56\.0\.4$/);
    });

    it("writes nothing when the pins are already current", async () => {
      let updated = "";
      await run({
        ...quiet,
        engines: ">=26",
        fetchText: fetchText(),
        readScript: () => script,
        writeScript: (t) => (updated = t),
      });
      const written: string[] = [];
      const code = await run({
        ...quiet,
        engines: ">=26",
        fetchText: fetchText(),
        readScript: () => updated,
        writeScript: (t) => written.push(t),
      });
      expect(code).toBe(0);
      expect(written).toEqual([]);
    });

    it("--check reports stale pins with status 1 and writes nothing", async () => {
      const written: string[] = [];
      const errors: string[] = [];
      const code = await run({
        check: true,
        engines: ">=26",
        fetchText: fetchText(),
        readScript: () => script,
        writeScript: (t) => written.push(t),
        log: () => {},
        logError: (m) => errors.push(m),
      });
      expect(code).toBe(1);
      expect(written).toEqual([]);
      expect(errors[0]).toMatch(/are stale/);
    });

    it("refuses an engines value it cannot read a major from, before any request", async () => {
      const calls: string[] = [];
      await expect(
        run({ engines: "latest", fetchText: fetchText(calls), readScript: () => script, ...quiet }),
      ).rejects.toThrow(/cannot read a Node major/);
      expect(calls).toEqual([]);
    });
  });
});
