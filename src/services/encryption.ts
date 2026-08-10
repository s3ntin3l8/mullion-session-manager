import crypto from "node:crypto";

const AES_PREFIX = "enc:";

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

export class EncryptionService {
  private key: Buffer | null;
  private _isEnabled: boolean;

  constructor(opts: { key: string }) {
    if (opts.key) {
      const decoded = Buffer.from(opts.key, "base64url");
      // Security audit finding AS3: the old `.subarray(0, 32)` here
      // silently truncated/accepted anything, with two concrete failure
      // modes. (a) Silent no-op key rotation: a "new" key that happens to
      // share its first 32 decoded bytes with the old one (or is just the
      // old key with extra bytes appended) would decrypt every
      // already-encrypted value identically to before — an operator
      // rotating away from a compromised key would believe it retired while
      // it kept working. (b) Silent weakening: a plain passphrase like
      // "my-secret-passphrase!!" isn't valid base64url, so `Buffer.from`
      // drops the invalid characters and yields a short (e.g. ~15-byte)
      // buffer — `createCipheriv("aes-256-gcm", <15 bytes>, iv)` then
      // throws "Invalid key length" on the *first* encrypt (a runtime 500),
      // not at boot. Requiring exactly 32 decoded bytes here — src/app.ts's
      // boot-invariant block performs the same check before this
      // constructor ever runs, so a bad key fails fast with a clear message
      // instead — closes both.
      if (decoded.length !== 32) {
        throw new Error(
          `DB_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${decoded.length})`,
        );
      }
      this.key = decoded;
      this._isEnabled = true;
    } else {
      this.key = null;
      this._isEnabled = false;
    }
  }

  get isEnabled(): boolean {
    return this._isEnabled;
  }

  encryptString(plaintext: string): string {
    if (!this.key) return plaintext;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${AES_PREFIX}${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString("base64url")}`;
  }

  decryptString(ciphertext: string): string {
    if (!this.key) return ciphertext;

    if (!ciphertext.startsWith(AES_PREFIX)) {
      return ciphertext;
    }

    try {
      const parts = ciphertext.slice(AES_PREFIX.length).split(":");
      if (parts.length !== 3) {
        throw new DecryptionError("Malformed encrypted value");
      }
      const [ivB64, tagB64, dataB64] = parts;
      const iv = Buffer.from(ivB64, "base64url");
      const authTag = Buffer.from(tagB64, "base64url");
      const encrypted = Buffer.from(dataB64, "base64url");

      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(authTag);
      return decipher.update(encrypted) + decipher.final("utf8");
    } catch (err) {
      if (err instanceof DecryptionError) throw err;
      throw new DecryptionError(
        `Decryption failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  encryptJson(data: unknown): string {
    return this.encryptString(JSON.stringify(data));
  }

  // Finding AS14: this used to swallow every JSON.parse failure into `{}` —
  // after a key change (decryptString above still "succeeds" in the
  // no-key/pass-through case, or with a wrong-but-still-32-byte key that
  // decrypts to garbage bytes that happen to fail auth-tag verification
  // differently... see decryptString's own DecryptionError path for that
  // case) or on a legacy non-JSON row, a caller received an empty object
  // indistinguishable from "genuinely empty" — any consumer reading a
  // boolean/allowlist out of it got the falsy default with no error signal.
  // `null` makes "decryption produced bytes that aren't valid JSON" its own
  // distinguishable outcome, the same way decryptString's own
  // DecryptionError already makes "decryption itself failed" distinguishable
  // — every call site must treat this the same way it already has to treat
  // a caught DecryptionError.
  decryptJson(ciphertext: string): unknown {
    const plaintext = this.decryptString(ciphertext);
    try {
      return JSON.parse(plaintext);
    } catch {
      return null;
    }
  }
}
