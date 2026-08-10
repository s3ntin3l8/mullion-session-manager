import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { browserCookies } from "../db/schema.js";
import {
  readBrowserCookies,
  readBrowserCookiesFromBuffer,
  type ImportedCookie,
} from "./browser-cookie-import.js";

// Phase 3, issue #184 — the DB-facing half of cookie import (browser-cookie-
// import.ts does the actual host-file reading/decrypting). Cookies are
// encrypted at rest via app.encryption, same convention as
// host-registry.ts's authTokenEnc — see schema.ts's browserCookies table
// comment for the full rationale.

export interface CookieProfileSummary {
  id: number;
  projectId: number;
  label: string;
  browser: "chrome" | "firefox";
  cookieCount: number;
  importedAt: Date;
}

function toSummary(row: typeof browserCookies.$inferSelect): CookieProfileSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    browser: row.browser,
    cookieCount: row.cookieCount,
    importedAt: row.importedAt,
  };
}

/** Reads cookies from the given host profile path and stores them
 * encrypted, upserted by (projectId, label) — re-importing the same label
 * refreshes it in place ("re-import on demand," #184) rather than
 * accumulating duplicate rows. Never returns the cookie values themselves,
 * only a summary — see listCookieProfiles's own comment on why. */
export function importCookieProfile(
  app: FastifyInstance,
  projectId: number,
  input: { browser: "chrome" | "firefox"; profilePath: string; label: string },
): CookieProfileSummary {
  const cookies = readBrowserCookies(input.browser, input.profilePath);
  const cookiesEnc = app.encryption.encryptJson(cookies);
  const now = new Date();

  const [row] = app.db
    .insert(browserCookies)
    .values({
      projectId,
      label: input.label,
      browser: input.browser,
      cookiesEnc,
      cookieCount: cookies.length,
      importedAt: now,
    })
    .onConflictDoUpdate({
      target: [browserCookies.projectId, browserCookies.label],
      set: { browser: input.browser, cookiesEnc, cookieCount: cookies.length, importedAt: now },
    })
    .returning()
    .all();
  return toSummary(row);
}

export function importCookieProfileFromBuffer(
  app: FastifyInstance,
  projectId: number,
  input: { browser: "chrome" | "firefox"; fileBase64: string; label: string },
): CookieProfileSummary {
  const buffer = Buffer.from(input.fileBase64, "base64");
  const cookies = readBrowserCookiesFromBuffer(input.browser, buffer);
  const cookiesEnc = app.encryption.encryptJson(cookies);
  const now = new Date();

  const [row] = app.db
    .insert(browserCookies)
    .values({
      projectId,
      label: input.label,
      browser: input.browser,
      cookiesEnc,
      cookieCount: cookies.length,
      importedAt: now,
    })
    .onConflictDoUpdate({
      target: [browserCookies.projectId, browserCookies.label],
      set: { browser: input.browser, cookiesEnc, cookieCount: cookies.length, importedAt: now },
    })
    .returning()
    .all();
  return toSummary(row);
}

/** Lists stored cookie profiles for a project — summaries only (label,
 * browser, count, timestamp). Deliberately never surfaces decrypted cookie
 * values over the API; only browser-manager.ts's launch path (in-process)
 * ever calls loadStoredCookiesForProject below. */
export function listCookieProfiles(
  app: FastifyInstance,
  projectId: number,
): CookieProfileSummary[] {
  return app.db
    .select()
    .from(browserCookies)
    .where(eq(browserCookies.projectId, projectId))
    .all()
    .map(toSummary);
}

export function deleteCookieProfile(app: FastifyInstance, projectId: number, id: number): boolean {
  const deleted = app.db
    .delete(browserCookies)
    .where(and(eq(browserCookies.id, id), eq(browserCookies.projectId, projectId)))
    .returning()
    .all();
  return deleted.length > 0;
}

/** BrowserManager's launch-time hook (src/plugins/browser.ts wires this in)
 * — applies the most recently imported profile for a project, if any.
 * "Support multiple profiles" (#184) means more than one can be *stored*;
 * only one applies to a given launch, since a project's pooled browser is a
 * single logged-in identity at a time — re-importing/choosing a different
 * label is how an operator switches which one applies on the next launch. */
export function loadStoredCookiesForProject(
  app: FastifyInstance,
  projectId: number,
): ImportedCookie[] {
  const rows = app.db
    .select()
    .from(browserCookies)
    .where(eq(browserCookies.projectId, projectId))
    .all();
  if (rows.length === 0) return [];

  // `importedAt`'s column mode ("timestamp") stores second-granularity
  // Unix time, not milliseconds — two imports within the same second tie
  // there, so `id` (monotonically increasing) is the deciding tiebreaker
  // for "most recent."
  const mostRecent = rows.reduce((latest, row) => {
    if (row.importedAt.getTime() !== latest.importedAt.getTime()) {
      return row.importedAt.getTime() > latest.importedAt.getTime() ? row : latest;
    }
    return row.id > latest.id ? row : latest;
  });
  try {
    const decrypted = app.encryption.decryptJson(mostRecent.cookiesEnc);
    // Finding AS14: decryptJson now returns `null` (not `{}`) when
    // decryption succeeded but the plaintext wasn't valid JSON — e.g. a
    // stale row left over from a key change. Treated the same as the
    // decrypt-itself-failed case just below: nothing usable came back, so
    // log and fall back to "no stored cookies" rather than casting `null`
    // into an `ImportedCookie[]` a caller would then iterate.
    if (decrypted === null) {
      app.log.warn(
        { projectId, profileId: mostRecent.id },
        "stored browser cookies decrypted but were not valid JSON",
      );
      return [];
    }
    return decrypted as ImportedCookie[];
  } catch (err) {
    app.log.warn(
      { err, projectId, profileId: mostRecent.id },
      "failed to decrypt stored browser cookies",
    );
    return [];
  }
}
