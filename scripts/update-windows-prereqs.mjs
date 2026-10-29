#!/usr/bin/env node
// Refreshes the pinned Node and PortableGit downloads (version, URL, SHA-256)
// in deploy/windows/mullion-install.ps1 -- the bootstrap downloads those only
// when a suitable one is not already installed, and refuses a download whose
// hash differs from the pin, so a pin has to track what the vendors publish.
//
//   node scripts/update-windows-prereqs.mjs            rewrite the pins in place
//   node scripts/update-windows-prereqs.mjs --check    exit 1 if they are stale
//
// The hashes come from the vendors' own listings, over TLS: nodejs.org's
// SHASUMS256.txt for the newest release of the Node major the repo requires,
// and the `digest` GitHub records for Git for Windows' PortableGit asset. The
// pins are a transport-integrity check against a corrupted or swapped
// download, not a defence against a compromised vendor -- the same posture as
// deploy/mullion-install.sh's tarball checksum.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../deploy/windows/mullion-install.ps1", import.meta.url));
const BEGIN = "# BEGIN PINS (refreshed by scripts/update-windows-prereqs.mjs)";

// rcedit (sets the Mullion name and icon on the agent's copy of Node) is a
// fixed pin, not a "latest": the release is from 2023 and the tool is only ever
// run on a file we just made. Moving it is a deliberate edit, here.
const RCEDIT = {
  rceditVersion: "2.0.0",
  rceditUrl: "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe",
  rceditSha256: "3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a", // pragma: allowlist secret
};
const END = "# END PINS";

/**
 * The win-x64 zip of the newest release listed in a SHASUMS256.txt.
 *
 * @param {string} text the file's contents
 * @param {string} major the Node major (the directory is latest-v<major>.x)
 */
export function parseNodeShasums(text, major) {
  const pattern = /^([0-9a-f]{64})\s+node-v(\d+\.\d+\.\d+)-win-x64\.zip$/m;
  const match = pattern.exec(text);
  if (!match) throw new Error("no win-x64 zip in the Node SHASUMS256.txt");
  const [, sha256, version] = match;
  if (version.split(".")[0] !== major) {
    throw new Error(`expected a Node ${major}.x release, the listing has ${version}`);
  }
  return {
    nodeVersion: version,
    nodeUrl: `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`,
    nodeSha256: sha256,
  };
}

/**
 * The 64-bit PortableGit asset of a GitHub release object (the API's JSON).
 *
 * @param {{ assets: Array<{ name: string, digest?: string, browser_download_url: string }> }} release
 */
export function pickPortableGit(release) {
  const asset = release.assets.find((a) => /^PortableGit-[\d.]+-64-bit\.7z\.exe$/.test(a.name));
  if (!asset) throw new Error("the Git for Windows release has no 64-bit PortableGit asset");
  const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "");
  if (!digest) throw new Error(`${asset.name} has no sha256 digest on GitHub`);
  const version = /^PortableGit-([\d.]+)-64-bit/.exec(asset.name)[1];
  return {
    gitVersion: version,
    gitUrl: asset.browser_download_url,
    gitSha256: digest[1],
  };
}

/** The pins block, as it appears in the script. */
export function renderPins(pins) {
  const p = { ...RCEDIT, ...pins };
  return [
    BEGIN,
    `$PinNodeVersion = '${p.nodeVersion}'`,
    `$PinNodeUrl = '${p.nodeUrl}'`,
    `$PinNodeSha256 = '${p.nodeSha256}' # pragma: allowlist secret`,
    `$PinGitVersion = '${p.gitVersion}'`,
    `$PinGitUrl = '${p.gitUrl}'`,
    `$PinGitSha256 = '${p.gitSha256}' # pragma: allowlist secret`,
    `$PinRceditVersion = '${p.rceditVersion}'`,
    `$PinRceditUrl = '${p.rceditUrl}'`,
    `$PinRceditSha256 = '${p.rceditSha256}' # pragma: allowlist secret`,
    END,
  ].join("\n");
}

/** Replaces the pins block in the script's text. */
export function applyPins(scriptText, pins) {
  const crlf = scriptText.includes("\r\n");
  const text = scriptText.replace(/\r\n/g, "\n");
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END, start);
  if (start === -1 || end === -1) throw new Error("the pins markers are missing from the script");
  const next = text.slice(0, start) + renderPins(pins) + text.slice(end + END.length);
  return crlf ? next.replace(/\n/g, "\r\n") : next;
}

async function getText(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/**
 * Refreshes (or, with `check`, verifies) the pins in the script. Everything it
 * touches is a parameter, so a test can run it without the network or the disk.
 *
 * @param {{
 *   check?: boolean,
 *   engines: string,
 *   fetchText?: (url: string, headers?: Record<string, string>) => Promise<string>,
 *   readScript?: () => string,
 *   writeScript?: (text: string) => void,
 *   log?: (message: string) => void,
 *   logError?: (message: string) => void,
 * }} options
 * @returns {Promise<number>} the exit status
 */
export async function run({
  check = false,
  engines,
  fetchText = getText,
  readScript = () => readFileSync(SCRIPT, "utf8"),
  writeScript = (text) => writeFileSync(SCRIPT, text),
  log = console.log,
  logError = console.error,
}) {
  const major = /(\d+)/.exec(engines)?.[1] ?? "";
  // Only digits go into the URL below: the value comes from a file.
  if (!/^\d{1,3}$/.test(major))
    throw new Error(`cannot read a Node major from engines.node "${engines}"`);

  const node = parseNodeShasums(
    await fetchText(
      `https://nodejs.org/dist/latest-v${encodeURIComponent(major)}.x/SHASUMS256.txt`,
    ),
    major,
  );
  const release = JSON.parse(
    await fetchText("https://api.github.com/repos/git-for-windows/git/releases/latest", {
      accept: "application/vnd.github+json",
      "user-agent": "mullion-update-windows-prereqs",
    }),
  );
  const pins = { ...node, ...pickPortableGit(release) };

  const current = readScript();
  const updated = applyPins(current, pins);
  if (updated === current) {
    log(`pins are current: Node ${pins.nodeVersion}, Git ${pins.gitVersion}`);
    return 0;
  }
  if (check) {
    logError(
      `the pins in deploy/windows/mullion-install.ps1 are stale (latest: Node ${pins.nodeVersion}, Git ${pins.gitVersion}); run node scripts/update-windows-prereqs.mjs`,
    );
    return 1;
  }
  writeScript(updated);
  log(`updated the pins: Node ${pins.nodeVersion}, Git ${pins.gitVersion}`);
  return 0;
}

async function main() {
  const engines = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ).engines.node;
  process.exit(await run({ check: process.argv.includes("--check"), engines }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
