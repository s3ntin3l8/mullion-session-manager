import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Best-effort owner/repo derivation from a checkout's `origin` remote
// (issue #27) — same "read-only, never throw, missing file is the normal
// case" philosophy as project-config.ts. This is the ONE place in the repo
// that reads .git/config; deliberately a narrow, hand-rolled parse of just
// the `[remote "origin"] url = ...` line rather than a general INI parser
// or a `git remote get-url origin` child_process call — this repo has
// neither a gitconfig-parsing dependency nor any existing git-CLI shell-out
// (project-config.ts's only git awareness is an `existsSync(.git)` check).

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

// GitHub's own naming rules — an owner is alphanumeric/hyphen (never a
// leading/trailing/double hyphen in practice, not worth encoding exactly);
// a repo adds dot/underscore. Capturing exactly this charset (rather than
// `[^/]+`) both rejects a malformed/non-GitHub value up front and gives the
// values a validated shape before they flow into github.ts's API URL and
// this repo's own htmlUrl construction — CodeQL flagged the untightened
// version as file-derived data reaching an outbound request; a strict
// allowlist capture is the standard fix (Hermes review, PR #39).
const GH_OWNER = "[A-Za-z0-9-]+";
// Lazy (`+?`), not greedy — a literal ".git" suffix is itself a valid
// sequence of repo-name characters, so a greedy `+` would swallow it
// whole and leave nothing for the `(?:\.git)?` group below to strip.
const GH_REPO = "[A-Za-z0-9._-]+?";

// SSH form: git@github.com:owner/repo(.git). HTTPS form: (optionally
// user@-prefixed, e.g. a PAT-in-URL remote) https://github.com/owner/repo(.git)(/).
// Neither matches a GitHub Enterprise host, GitLab, Bitbucket, etc. — those
// fall through to null, same as a missing remote (the widget just doesn't
// render; see routes/projects.ts's GET .../github).
const SSH_REMOTE = new RegExp(`^git@github\\.com:(${GH_OWNER})/(${GH_REPO})(?:\\.git)?/?$`);
const HTTPS_REMOTE = new RegExp(
  `^https?://(?:[^@/]+@)?github\\.com/(${GH_OWNER})/(${GH_REPO})(?:\\.git)?/?$`,
);

export function parseRemoteUrl(url: string): GitHubRepoRef | null {
  const ssh = url.match(SSH_REMOTE);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = url.match(HTTPS_REMOTE);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

/**
 * Reads `<cwd>/.git/config` and extracts `[remote "origin"]`'s `url`,
 * returning `{ owner, repo }` for a github.com remote or `null` for
 * anything else — a missing .git/config, no `origin` remote, or a
 * non-github.com host. Never throws: a malformed config is exactly as
 * "no GitHub repo here" as a missing one.
 */
export function parseGitRemote(cwd: string): GitHubRepoRef | null {
  const url = readOriginUrl(cwd);
  return url === null ? null : parseRemoteUrl(url);
}

/**
 * Reads `<cwd>/.git/config` and returns `[remote "origin"]`'s raw `url`, or
 * `null` for a missing config, no `origin` remote, or an unreadable file.
 * Never throws. Unlike parseGitRemote this keeps ANY host (GitLab, GHE, ssh://,
 * a self-hosted forge) — issue #2090 matches a project's checkout on another
 * host by comparing normalised origins. A worktree or submodule (`.git` is a
 * FILE) has no `.git/config` here and reads as null.
 */
export function readOriginUrl(cwd: string): string | null {
  // `cwd` here is always meant to be an already-resolved absolute directory
  // (a project's own `cwd` column, or an agent-side value already passed
  // through resolveWithinRoots — see routes/projects.ts and
  // routes/internal.ts). Reject a relative one outright rather than
  // resolving it against this process's own cwd (whose value at call time
  // isn't something a caller should be able to lean on) — the meaningful
  // half of this guard. The `path.normalize` + `".."`-segment check is
  // effectively a no-op for an already-absolute path specifically (Node
  // collapses `..` during normalize before this ever runs), but is kept as
  // the standard, CodeQL-recognized js/path-injection sanitizer shape.
  if (!path.isAbsolute(cwd) || path.normalize(cwd).split(path.sep).includes("..")) {
    return null;
  }
  const configPath = path.join(cwd, ".git", "config");
  if (!existsSync(configPath)) return null;

  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  // Scoped to exactly this one section/key rather than a full INI parse —
  // matches to the next `[section]` header or end of file.
  const sectionMatch = content.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/);
  if (!sectionMatch) return null;
  const urlMatch = sectionMatch[1].match(/^\s*url\s*=\s*(.+)$/m);
  if (!urlMatch) return null;
  const url = urlMatch[1].trim();
  return url === "" ? null : url;
}

// scp-like `[user@]host:path` (not `host://…`), as `git@github.com:o/r.git`.
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;

/**
 * Normalises a git remote URL to `host/path` so the SAME repository compares
 * equal however it is spelled: `git@github.com:o/r.git`,
 * `https://user@GitHub.com/o/r`, `ssh://git@github.com:22/o/r.git/` all
 * become `github.com/o/r`. Host and path are lower-cased (a forge that treats
 * two repos differing only by case as distinct is not worth the false
 * negatives), userinfo, port, a trailing `.git` and slashes are dropped.
 * Returns null for anything that is not a network remote with an `owner/repo`
 * style path — a local path, `file://`, an empty or unparseable value — since
 * those cannot identify the same repository on another host.
 */
export function normalizeGitRemote(raw: string): string | null {
  const parsed = parseRemoteParts(raw);
  return parsed === null ? null : `${parsed.host}/${parsed.path}`;
}

/** Scheme defaults a remote's port is dropped for (it names the same service). */
const DEFAULT_PORTS: Record<string, string> = { "ssh:": "22", "git:": "9418" };

/**
 * Like `normalizeGitRemote`, but the port is part of the key. The matcher above
 * drops it on purpose (right for suggestions: `git@h:o/r` and `https://h/o/r`
 * are one repo), which is wrong as a HARD gate: `gitea.local:2222/team/app` and
 * `gitea.local:2223/team/app` are different self-hosted repos. A scheme's
 * default port (ssh 22, https 443, ...) is dropped, so the same repo spelled
 * with and without it still compares equal; a non-default port is kept. The
 * cost of keeping it is a missed duplicate across transports on a custom port,
 * which only means no 409 — never a wrong refusal.
 */
export function gitRemoteGateKey(raw: string): string | null {
  const parsed = parseRemoteParts(raw);
  if (parsed === null) return null;
  const port =
    parsed.port !== "" && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? parsed.port : "";
  return `${parsed.host}${port === "" ? "" : `:${port}`}/${parsed.path}`;
}

function parseRemoteParts(
  raw: string,
): { host: string; port: string; protocol: string; path: string } | null {
  const url = raw.trim();
  if (url === "") return null;

  let host: string;
  let port = "";
  let protocol = "";
  let pathPart: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:") return null;
    host = parsed.hostname;
    port = parsed.port;
    protocol = parsed.protocol;
    // Not percent-decoded: decoding can throw on a malformed escape and would
    // make `o%2Fr` equal `o/r`; both spellings of one repo are compared raw.
    pathPart = parsed.pathname;
  } else {
    const scp = url.match(SCP_REMOTE);
    // A one-letter "host" is a Windows drive (`C:\repo`), not a remote.
    if (!scp || scp[1].length < 2) return null;
    host = scp[1];
    pathPart = scp[2];
  }

  const cleaned = pathPart
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "");
  if (host === "" || cleaned === "") return null;
  return { host: host.toLowerCase(), port, protocol, path: cleaned.toLowerCase() };
}
