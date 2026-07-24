import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Phase 3, issue #184 — reads cookies straight out of the operator's real
// Chrome/Firefox profile *on this same host* (the roadmap's own framing:
// "import cookies from the user's real browser"). Both browsers keep their
// cookie DB open with an exclusive-ish lock while running, so every reader
// here copies the file to a scratch temp path first rather than opening the
// live path directly — the same reasoning deploy/install.sh's own copy-then-
// verify steps use for a different file, just applied to a locked SQLite
// file instead of a downloaded tarball.

export interface ImportedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix time in seconds, or undefined for a session cookie — matches
   * Playwright's BrowserContext.addCookies() shape exactly so the caller
   * (browser-manager.ts) can pass this straight through. */
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
}

// profilePath ultimately comes from an operator-supplied API request body —
// resolved and checked against a known-browser-profile-directory allowlist
// below (readFirefoxCookies/readChromeCookies) before it ever reaches these
// fs calls, so an operator can only point this at their own browser
// profiles, not an arbitrary host path (CodeQL js/path-injection).
function copyToScratchFile(sourcePath: string): string {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Cookie database not found: ${sourcePath}`);
  }
  const scratchPath = path.join(
    os.tmpdir(),
    `mullion-cookie-import-${crypto.randomBytes(8).toString("hex")}.sqlite`,
  );
  fs.copyFileSync(sourcePath, scratchPath);
  return scratchPath;
}

// Restricts an operator-supplied profile path to the well-known directories
// each browser actually stores profiles in (including Snap/Flatpak
// variants, common on the minimal/headless Linux hosts this deploys to —
// see this file's header comment). Computed per-call (not module-level)
// so it reflects the current $HOME, including in tests that stub it.
function chromeAllowedRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".config/google-chrome"),
    path.join(home, ".config/google-chrome-beta"),
    path.join(home, ".config/google-chrome-unstable"),
    path.join(home, ".config/chromium"),
    path.join(home, "snap/chromium/common/chromium"),
    path.join(home, ".var/app/com.google.Chrome/config/google-chrome"),
    path.join(home, ".var/app/org.chromium.Chromium/config/chromium"),
  ];
}

function firefoxAllowedRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".mozilla/firefox"),
    path.join(home, "snap/firefox/common/.mozilla/firefox"),
    path.join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox"),
  ];
}

/** Resolves `rawPath` and rejects it unless it falls inside one of
 * `allowedRoots` — the barrier that keeps an operator-supplied path scoped
 * to real browser profile directories rather than an arbitrary host path. */
function resolveWithinAllowedRoots(rawPath: string, allowedRoots: string[]): string {
  const resolved = path.resolve(rawPath);
  const withinAllowedRoot = allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
  if (!withinAllowedRoot) {
    throw new Error(
      `Cookie database path must be inside a known browser profile directory, got: ${resolved}`,
    );
  }
  return resolved;
}

function withScratchCopy<T>(sourcePath: string, fn: (db: Database.Database) => T): T {
  const scratchPath = copyToScratchFile(sourcePath);
  const db = new Database(scratchPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(scratchPath, { force: true });
  }
}

// moz_cookies columns are stable across Firefox versions for the ones read
// here (name/value/host/path/expiry/isSecure/isHttpOnly) — cookies.sqlite
// stores values in plaintext, unlike Chrome's OS-keychain-encrypted store,
// so no decryption step is needed at all.
export function readFirefoxCookies(profileCookiesPath: string): ImportedCookie[] {
  const resolvedPath = resolveWithinAllowedRoots(profileCookiesPath, firefoxAllowedRoots());
  return withScratchCopy(resolvedPath, (db) => {
    const rows = db
      .prepare(`SELECT name, value, host, path, expiry, isSecure, isHttpOnly FROM moz_cookies`)
      .all() as Array<{
      name: string;
      value: string;
      host: string;
      path: string;
      expiry: number;
      isSecure: number;
      isHttpOnly: number;
    }>;
    return rows.map((row) => ({
      name: row.name,
      value: row.value,
      domain: row.host,
      path: row.path,
      // moz_cookies.expiry is already Unix seconds; 0 means session cookie.
      expires: row.expiry > 0 ? row.expiry : undefined,
      httpOnly: row.isHttpOnly === 1,
      secure: row.isSecure === 1,
    }));
  });
}

// Chrome's "Basic" (no OS keyring daemon) encryption scheme for "v10"-
// prefixed encrypted_value blobs on Linux: AES-128-CBC, key derived via
// PBKDF2("peanuts", "saltysalt", 1 iteration, sha1), a fixed 16-space IV.
// This is the well-documented fallback Chromium itself uses when no GNOME
// Keyring/KWallet secret-service is available — genuinely common on a
// minimal/headless Linux host, which is exactly the kind of host this app
// deploys to (see deploy/README.md). When the real OS keyring backend was
// used instead (a desktop session with GNOME Keyring/KWallet running),
// this key won't decrypt the ciphertext — handled per-cookie below by
// skipping any cookie that fails to decrypt rather than storing garbage or
// crashing the whole import. Integrating the real secret-service D-Bus
// protocol is out of scope here (a new native dependency, and this project
// has none today) — see the Settings UI copy for this documented limit.
const CHROME_LINUX_BASIC_KEY = crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
const CHROME_LINUX_BASIC_IV = Buffer.from(" ".repeat(16), "utf8");

function decryptChromeValue(encrypted: Buffer): string | null {
  if (encrypted.length === 0) return "";
  const prefix = encrypted.subarray(0, 3).toString("utf8");
  if (prefix !== "v10" && prefix !== "v11") {
    // Pre-encryption-era Chrome (older, rare) stores the plaintext value in
    // the `value` column instead — handled by the caller falling back to
    // it, not here.
    return null;
  }
  const ciphertext = encrypted.subarray(3);
  try {
    const decipher = crypto.createDecipheriv(
      "aes-128-cbc",
      CHROME_LINUX_BASIC_KEY,
      CHROME_LINUX_BASIC_IV,
    );
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null; // OS-keyring-backed encryption in use — can't decrypt without it.
  }
}

// Chrome's `expires_utc`/`creation_utc` are microseconds since 1601-01-01
// (Windows FILETIME epoch), not Unix epoch — 11644473600 is the number of
// seconds between the two epochs.
const CHROME_EPOCH_OFFSET_SECONDS = 11644473600;

function chromeTimeToUnixSeconds(chromeMicroseconds: number): number | undefined {
  if (!chromeMicroseconds) return undefined; // 0 => session cookie
  return Math.round(chromeMicroseconds / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS);
}

export function readChromeCookies(profileCookiesPath: string): ImportedCookie[] {
  const resolvedPath = resolveWithinAllowedRoots(profileCookiesPath, chromeAllowedRoots());
  return withScratchCopy(resolvedPath, (db) => {
    const rows = db
      .prepare(
        `SELECT name, value, encrypted_value, host_key, path, expires_utc, is_secure, is_httponly FROM cookies`,
      )
      .all() as Array<{
      name: string;
      value: string;
      encrypted_value: Buffer;
      host_key: string;
      path: string;
      expires_utc: number;
      is_secure: number;
      is_httponly: number;
    }>;

    const cookies: ImportedCookie[] = [];
    for (const row of rows) {
      const decrypted =
        row.encrypted_value && row.encrypted_value.length > 0
          ? decryptChromeValue(row.encrypted_value)
          : row.value;
      if (decrypted === null) continue; // couldn't decrypt (OS-keyring-backed) — skip, don't guess

      cookies.push({
        name: row.name,
        value: decrypted,
        domain: row.host_key,
        path: row.path,
        expires: chromeTimeToUnixSeconds(row.expires_utc),
        httpOnly: row.is_httponly === 1,
        secure: row.is_secure === 1,
      });
    }
    return cookies;
  });
}

export function readBrowserCookies(
  browser: "chrome" | "firefox",
  profilePath: string,
): ImportedCookie[] {
  return browser === "firefox" ? readFirefoxCookies(profilePath) : readChromeCookies(profilePath);
}
