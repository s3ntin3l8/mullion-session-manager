import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFirefoxCookies, readChromeCookies } from "../../src/services/browser-cookie-import.js";

// Real SQLite fixture files built with the exact same column shapes
// Firefox's cookies.sqlite and Chrome's Cookies file use — see browser-
// cookie-import.ts's own comments on why these specific columns are read.
// This exercises the real better-sqlite3 read path (copy-to-scratch, query,
// cleanup), not a mocked one — the only thing that's fake is the source
// browser profile itself.

const CHROME_LINUX_BASIC_KEY = crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
const CHROME_LINUX_BASIC_IV = Buffer.from(" ".repeat(16), "utf8");

function encryptChromeValue(plaintext: string): Buffer {
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    CHROME_LINUX_BASIC_KEY,
    CHROME_LINUX_BASIC_IV,
  );
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "utf8"), encrypted]);
}

const tmpFiles: string[] = [];

function tmpDbPath(): string {
  const p = path.join(
    os.tmpdir(),
    `cookie-import-fixture-${crypto.randomBytes(6).toString("hex")}.sqlite`,
  );
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

describe("readFirefoxCookies", () => {
  function buildFirefoxFixture(
    rows: Array<{
      name: string;
      value: string;
      host: string;
      path: string;
      expiry: number;
      isSecure: number;
      isHttpOnly: number;
    }>,
  ): string {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE moz_cookies (
        id INTEGER PRIMARY KEY,
        name TEXT, value TEXT, host TEXT, path TEXT,
        expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER
      );
    `);
    const insert = db.prepare(
      `INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(r.name, r.value, r.host, r.path, r.expiry, r.isSecure, r.isHttpOnly);
    }
    db.close();
    return dbPath;
  }

  it("reads plaintext cookies with expiry converted correctly", () => {
    const dbPath = buildFirefoxFixture([
      {
        name: "sid",
        value: "abc123",
        host: ".example.com",
        path: "/",
        expiry: 2000000000,
        isSecure: 1,
        isHttpOnly: 1,
      },
    ]);

    const cookies = readFirefoxCookies(dbPath);

    expect(cookies).toEqual([
      {
        name: "sid",
        value: "abc123",
        domain: ".example.com",
        path: "/",
        expires: 2000000000,
        httpOnly: true,
        secure: true,
      },
    ]);
  });

  it("treats expiry 0 as a session cookie (no expires field)", () => {
    const dbPath = buildFirefoxFixture([
      {
        name: "session",
        value: "x",
        host: "example.com",
        path: "/",
        expiry: 0,
        isSecure: 0,
        isHttpOnly: 0,
      },
    ]);

    const cookies = readFirefoxCookies(dbPath);

    expect(cookies[0].expires).toBeUndefined();
    expect(cookies[0].secure).toBe(false);
    expect(cookies[0].httpOnly).toBe(false);
  });

  it("throws a clear error when the profile path doesn't exist", () => {
    expect(() => readFirefoxCookies("/no/such/cookies.sqlite")).toThrow(/not found/i);
  });
});

describe("readChromeCookies", () => {
  function buildChromeFixture(
    rows: Array<{
      name: string;
      value: string;
      encrypted_value: Buffer;
      host_key: string;
      path: string;
      expires_utc: number;
      is_secure: number;
      is_httponly: number;
    }>,
  ): string {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE cookies (
        name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT, path TEXT,
        expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER
      );
    `);
    const insert = db.prepare(
      `INSERT INTO cookies (name, value, encrypted_value, host_key, path, expires_utc, is_secure, is_httponly) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(
        r.name,
        r.value,
        r.encrypted_value,
        r.host_key,
        r.path,
        r.expires_utc,
        r.is_secure,
        r.is_httponly,
      );
    }
    db.close();
    return dbPath;
  }

  it("decrypts a v10-encrypted cookie value using the Linux 'Basic' scheme", () => {
    const dbPath = buildChromeFixture([
      {
        name: "auth",
        value: "",
        encrypted_value: encryptChromeValue("secret-token-xyz"),
        host_key: ".example.com",
        path: "/",
        // 2026-01-01 00:00:00 UTC in Chrome's microseconds-since-1601 epoch.
        expires_utc:
          (Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000) + 11644473600) * 1_000_000,
        is_secure: 1,
        is_httponly: 1,
      },
    ]);

    const cookies = readChromeCookies(dbPath);

    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({
      name: "auth",
      value: "secret-token-xyz",
      domain: ".example.com",
      path: "/",
      httpOnly: true,
      secure: true,
    });
    expect(cookies[0].expires).toBe(Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000));
  });

  it("falls back to the plaintext value column when encrypted_value is empty", () => {
    const dbPath = buildChromeFixture([
      {
        name: "legacy",
        value: "plain-value",
        encrypted_value: Buffer.alloc(0),
        host_key: "example.com",
        path: "/",
        expires_utc: 0,
        is_secure: 0,
        is_httponly: 0,
      },
    ]);

    const cookies = readChromeCookies(dbPath);

    expect(cookies).toEqual([
      {
        name: "legacy",
        value: "plain-value",
        domain: "example.com",
        path: "/",
        expires: undefined,
        httpOnly: false,
        secure: false,
      },
    ]);
  });

  it("skips a cookie that fails to decrypt (e.g. OS-keyring-backed encryption) rather than storing garbage", () => {
    // Real v10 prefix but ciphertext that isn't valid AES-128-CBC output
    // under the well-known static key — simulates the GNOME Keyring/KWallet
    // case this reader deliberately can't handle.
    const bogusEncrypted = Buffer.concat([Buffer.from("v10", "utf8"), crypto.randomBytes(32)]);
    const dbPath = buildChromeFixture([
      {
        name: "undecryptable",
        value: "",
        encrypted_value: bogusEncrypted,
        host_key: "example.com",
        path: "/",
        expires_utc: 0,
        is_secure: 0,
        is_httponly: 0,
      },
      {
        name: "readable",
        value: "",
        encrypted_value: encryptChromeValue("still-works"),
        host_key: "example.com",
        path: "/",
        expires_utc: 0,
        is_secure: 0,
        is_httponly: 0,
      },
    ]);

    const cookies = readChromeCookies(dbPath);

    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe("readable");
    expect(cookies[0].value).toBe("still-works");
  });

  it("session cookie (expires_utc 0) has no expires field", () => {
    const dbPath = buildChromeFixture([
      {
        name: "session",
        value: "",
        encrypted_value: encryptChromeValue("v"),
        host_key: "example.com",
        path: "/",
        expires_utc: 0,
        is_secure: 0,
        is_httponly: 0,
      },
    ]);

    const cookies = readChromeCookies(dbPath);
    expect(cookies[0].expires).toBeUndefined();
  });

  it("throws a clear error when the profile path doesn't exist", () => {
    expect(() => readChromeCookies("/no/such/Cookies")).toThrow(/not found/i);
  });
});
