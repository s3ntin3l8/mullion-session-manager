import { spawn as spawnChild } from "node:child_process";
import path from "node:path";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.js";

// Commit history for the right sidebar's Git view: a paged `git log` (the
// data behind the lane graph), one commit's file list, and one file's diff
// within a commit. Same conventions as the sibling git-* helpers (argv-array
// spawn, never a shell string; stdout captured on 'close'; best-effort —
// a non-repo cwd or a failed git call resolves null, never throws).
// Arguments that come from a request (sha, file path) are validated here,
// not trusted from the route.

const GIT_TIMEOUT_MS = 10_000;
const KILL_ESCALATION_MS = 2_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;
export const MAX_LOG_PAGE = 200;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const FIELD = "\x1f";
const RECORD = "\x1e";

export interface CommitLogEntry {
  sha: string;
  parents: string[];
  author: string;
  /** Author date, seconds since the epoch. */
  time: number;
  subject: string;
  /** Decorations: "HEAD", local branches, "origin/x", "tag: v1". */
  refs: string[];
}

export interface CommitFileChange {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface CommitDetail {
  sha: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  message: string;
  files: CommitFileChange[];
}

function isSafeAbsolutePath(cwd: string): boolean {
  return path.isAbsolute(cwd) && !path.normalize(cwd).split(path.sep).includes("..");
}

/** Runs `git -C <cwd> <args>`; resolves null on non-zero exit, error, timeout or oversize output. */
function runGit(cwd: string, args: string[], maxBytes = MAX_BUFFER_BYTES): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let bytes = 0;
    let settled = false;
    // `log.showSignature=false`: a user's gitconfig can make log/show prepend a
    // `gpg:` verification block to every record, which would break parsing.
    const child = spawnChild(
      "git",
      [...GIT_NO_AUTO_GC, "-C", cwd, "-c", "log.showSignature=false", ...args],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      },
    );
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve(value);
    };
    const kill = () => {
      child.kill();
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_ESCALATION_MS);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        kill();
        finish(null);
        return;
      }
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onData);
    const timer = setTimeout(() => {
      kill();
      finish(null);
    }, GIT_TIMEOUT_MS);
    child.on("error", () => {
      if (killTimer) clearTimeout(killTimer);
      finish(null);
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      finish(code === 0 ? stdout : null);
    });
  });
}

/**
 * True when `cwd` is itself a git repo root or linked worktree (not merely a
 * subdirectory of one): `--show-prefix` is empty exactly at the top level.
 * Asking git avoids a filesystem probe of a caller-influenced path.
 */
async function isRepo(cwd: string): Promise<boolean> {
  if (!isSafeAbsolutePath(cwd)) return false;
  const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"], 4096);
  return prefix !== null && prefix.trim() === "";
}

export function isValidSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

export async function getCommitLog(
  cwd: string,
  opts: { limit?: number; skip?: number; all?: boolean; branch?: string } = {},
): Promise<CommitLogEntry[] | null> {
  if (!(await isRepo(cwd))) return null;
  // `branch` scopes the walk to one local branch's history. The caller has
  // already vetted the name (isPlainBranchName); the refs/heads/ prefix keeps
  // it a ref, never a flag or a revision expression.
  const revs = opts.branch !== undefined ? [`refs/heads/${opts.branch}`] : [];
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), MAX_LOG_PAGE);
  const skip = Math.max(Math.trunc(opts.skip ?? 0), 0);
  const out = await runGit(cwd, [
    "log",
    "--topo-order",
    ...(opts.branch !== undefined || opts.all === false ? [] : ["--all"]),
    `--max-count=${limit}`,
    `--skip=${skip}`,
    `--format=%H${FIELD}%P${FIELD}%an${FIELD}%at${FIELD}%s${FIELD}%D${RECORD}`,
    ...revs,
  ]);
  if (out === null) return null;
  const entries: CommitLogEntry[] = [];
  for (const record of out.split(RECORD)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed) continue;
    const [sha, parents, author, time, subject, refs] = trimmed.split(FIELD);
    if (!sha || !isValidSha(sha)) continue;
    entries.push({
      sha,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      author: author ?? "",
      time: Number(time) || 0,
      subject: subject ?? "",
      refs: refs
        ? refs
            .split(", ")
            .map((r) => r.trim())
            .filter(Boolean)
        : [],
    });
  }
  return entries;
}

export async function getCommitDetail(cwd: string, sha: string): Promise<CommitDetail | null> {
  if (!isValidSha(sha) || !(await isRepo(cwd))) return null;
  const [meta, stat] = await Promise.all([
    runGit(cwd, [
      "show",
      "-s",
      `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%B`,
      sha,
      "--",
    ]),
    runGit(cwd, ["show", "--numstat", "-z", "--format=", "-M", sha, "--"]),
  ]);
  if (meta === null) return null;
  const [full, parents, author, email, time, ...messageParts] = meta.split(FIELD);
  if (!full || !isValidSha(full)) return null;
  const files: CommitFileChange[] = [];
  // `-z` output is NUL-separated and unquoted: "adds\tdels\tpath\0", and for a
  // rename "adds\tdels\t\0old\0new\0" (the plain form prints "{old => new}",
  // which is not a path git accepts back).
  const tokens = (stat ?? "").split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].replace(/^\n+/, "").match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let filePath = m[3];
    if (filePath === "") {
      filePath = tokens[i + 2] ?? "";
      i += 2;
    }
    if (!filePath) continue;
    files.push({
      path: filePath,
      additions: m[1] === "-" ? null : Number(m[1]),
      deletions: m[2] === "-" ? null : Number(m[2]),
    });
  }
  return {
    sha: full,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    author: author ?? "",
    email: email ?? "",
    time: Number(time) || 0,
    message: messageParts.join(FIELD).trim(),
    files,
  };
}

/** A repo-relative path safe to hand to git after `--`. */
export function isSafeRepoPath(file: string): boolean {
  return (
    file.length > 0 &&
    file.length < 4096 &&
    !file.includes("\0") &&
    !path.isAbsolute(file) &&
    !path.normalize(file).split(path.sep).includes("..")
  );
}

export async function getCommitFileDiff(
  cwd: string,
  sha: string,
  file: string,
): Promise<string | null> {
  if (!isValidSha(sha) || !isSafeRepoPath(file) || !(await isRepo(cwd))) return null;
  return runGit(cwd, ["show", "--format=", "-M", sha, "--", file], MAX_DIFF_BYTES);
}
