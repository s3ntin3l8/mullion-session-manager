import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The per-session token a pty-host master (src/pty-host/) requires before it
 * serves a client — issue #1728.
 *
 * Kept in a file in the sessions dir rather than in memory: the backend that
 * attaches to a session may be a later process than the one that started it
 * (a session outlives the backend — that is the point), and it has to be able
 * to present the token again. The sessions dir is per-install, per-user
 * storage (the same place the hook token's per-session config lives), which
 * is what makes the file the right place to keep a secret: on Windows it
 * sits under the user's profile, whose inherited ACL keeps other users out,
 * and the file is written 0600 where mode bits mean something.
 */
export function ptyHostTokenPath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.pty-token`);
}

/** Stores `token` as session `id`'s token, replacing any old one. */
export function writePtyHostToken(sessionsDir: string, id: string, token: string): void {
  writeFileSync(ptyHostTokenPath(sessionsDir, id), token, { mode: 0o600 });
}

/** Creates (replacing any old one) and returns a fresh token for session `id`. */
export function createPtyHostToken(sessionsDir: string, id: string): string {
  const token = randomBytes(32).toString("hex");
  writePtyHostToken(sessionsDir, id, token);
  return token;
}

/**
 * The token for session `id`, or "" when there is none — which a master
 * rejects, so an attach without one fails like an attach to a missing
 * session rather than throwing.
 */
export function readPtyHostToken(sessionsDir: string, id: string): string {
  try {
    return readFileSync(ptyHostTokenPath(sessionsDir, id), "utf8").trim();
  } catch {
    return "";
  }
}

/** Removes session `id`'s token, once its master is gone. */
export function removePtyHostToken(sessionsDir: string, id: string): void {
  rmSync(ptyHostTokenPath(sessionsDir, id), { force: true });
}
