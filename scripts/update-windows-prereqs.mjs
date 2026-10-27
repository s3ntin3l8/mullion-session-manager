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
export function renderPins(p) {
  return [
    BEGIN,
    `$PinNodeVersion = '${p.nodeVersion}'`,
    `$PinNodeUrl = '${p.nodeUrl}'`,
    `$PinNodeSha256 = '${p.nodeSha256}' # pragma: allowlist secret`,
    `$PinGitVersion = '${p.gitVersion}'`,
    `$PinGitUrl = '${p.gitUrl}'`,
    `$PinGitSha256 = '${p.gitSha256}' # pragma: allowlist secret`,
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

async function main() {
  const check = process.argv.includes("--check");
  const engines = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ).engines.node;
  const major = /(\d+)/.exec(engines)?.[1] ?? "";
  // Only digits go into the URL below: the value comes from a file.
  if (!/^\d{1,3}$/.test(major))
    throw new Error(`cannot read a Node major from engines.node "${engines}"`);

  const node = parseNodeShasums(
    await getText(`https://nodejs.org/dist/latest-v${encodeURIComponent(major)}.x/SHASUMS256.txt`),
    major,
  );
  const release = JSON.parse(
    await getText("https://api.github.com/repos/git-for-windows/git/releases/latest", {
      accept: "application/vnd.github+json",
      "user-agent": "mullion-update-windows-prereqs",
    }),
  );
  const pins = { ...node, ...pickPortableGit(release) };

  const current = readFileSync(SCRIPT, "utf8");
  const updated = applyPins(current, pins);
  if (updated === current) {
    console.log(`pins are current: Node ${pins.nodeVersion}, Git ${pins.gitVersion}`);
    return;
  }
  if (check) {
    console.error(
      `the pins in deploy/windows/mullion-install.ps1 are stale (latest: Node ${pins.nodeVersion}, Git ${pins.gitVersion}); run node scripts/update-windows-prereqs.mjs`,
    );
    process.exit(1);
  }
  writeFileSync(SCRIPT, updated);
  console.log(`updated the pins: Node ${pins.nodeVersion}, Git ${pins.gitVersion}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
