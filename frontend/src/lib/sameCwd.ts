/**
 * Whether two working directories are the same directory — the comparison
 * behind "is this session in a worktree?" (Sidebar.tsx, PaneTab.tsx).
 *
 * POSIX paths compare exactly, as they always have. Two WINDOWS paths
 * (`C:\...`) compare the way Windows does — case-insensitively, either
 * separator, ignoring a trailing one — because a session's live cwd and the
 * project's stored cwd can legitimately differ in nothing but spelling (a
 * drive letter in lower case, Git Bash's forward slashes; issue #1728), and
 * a raw string comparison would then call every Windows session "in a
 * worktree".
 */
export function sameCwd(a: string | undefined | null, b: string | undefined | null): boolean {
  if (a == null || b == null) return a === b;
  if (a === b) return true;
  if (!isWindowsPath(a) || !isWindowsPath(b)) return false;
  return normaliseWindowsPath(a) === normaliseWindowsPath(b);
}

function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:([\\/]|$)/.test(p);
}

function normaliseWindowsPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
