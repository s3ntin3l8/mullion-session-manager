import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_NO_AUTO_GC, gitEnv, type GitIdentity } from "./git-env.js";

const execFileAsync = promisify(execFile);

/** Longest name/email accepted — the same bound the remote spawn schema uses. */
export const GIT_IDENTITY_FIELD_MAX = 256;

/** A stored settings field as a bounded string; anything else reads as unset. */
export function clampGitIdentityField(value: unknown): string {
  return typeof value === "string" ? value.slice(0, GIT_IDENTITY_FIELD_MAX) : "";
}

/**
 * A `{ name, email }` pair as a usable identity, or `undefined`. Both fields
 * must be non-blank: git refuses to commit with half an identity, and an
 * empty pair is how the settings UI says "unset". Control characters (a
 * newline would end the `-c user.name=…` value early in some tooling) make
 * the whole pair unusable rather than being silently stripped.
 */
export function normalizeGitIdentity(input: unknown): GitIdentity | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { name, email } = input as Record<string, unknown>;
  if (typeof name !== "string" || typeof email !== "string") return undefined;
  const n = name.trim();
  const e = email.trim();
  if (n === "" || e === "") return undefined;
  if (n.length > GIT_IDENTITY_FIELD_MAX || e.length > GIT_IDENTITY_FIELD_MAX) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n) || /[\u0000-\u001f\u007f]/.test(e)) return undefined;
  return { name: n, email: e };
}

/**
 * `projects.git_identity` (a JSON text column), parsed. Absent, malformed or
 * incomplete reads as "no override" so the global identity applies.
 */
export function parseProjectGitIdentity(raw: string | null | undefined): GitIdentity | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  try {
    return normalizeGitIdentity(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** The column value for an API body: `null` (or an unusable pair) clears it. */
export function serializeProjectGitIdentity(input: unknown): string | null {
  const identity = normalizeGitIdentity(input);
  return identity ? JSON.stringify(identity) : null;
}

/**
 * The identity a project's sessions and Mullion's own commits use: the
 * project's override when it has one, else the global setting. `undefined`
 * means nothing is injected and the host's own git config applies.
 */
export function resolveGitIdentity(
  projectRaw: string | null | undefined,
  globalIdentity: unknown,
): GitIdentity | undefined {
  return parseProjectGitIdentity(projectRaw) ?? normalizeGitIdentity(globalIdentity);
}

async function readGlobalGitConfig(key: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [...GIT_NO_AUTO_GC, "config", "--global", "--get", key],
      { env: gitEnv(), timeout: 5000 },
    );
    return stdout.trim();
  } catch {
    // Exit 1 = key unset; a missing git binary reads the same way here.
    return "";
  }
}

/** The primary's `git config --global user.name` / `user.email`, to prefill the setting. */
export async function readPrimaryGitIdentity(): Promise<{ name: string; email: string }> {
  const [name, email] = await Promise.all([
    readGlobalGitConfig("user.name"),
    readGlobalGitConfig("user.email"),
  ]);
  return { name, email };
}
