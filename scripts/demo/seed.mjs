import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gitEnv } from "../git-env.mjs";

/**
 * The demo dataset: scratch git repos, synthetic agent-transcript scripts,
 * projects, live sessions and Task Master tasks, all created through the
 * running backend's REST API (nothing written to its database directly).
 * Shared by `make demo` and the screenshot pipeline.
 */

const execFileAsync = promisify(execFile);

// Identity comes from the env, not `git config`: nothing is written to any
// config file, so a leaked GIT_DIR/GIT_CONFIG can't make this pollute a real
// checkout (issue #1649).
const DEMO_IDENTITY = {
  GIT_AUTHOR_NAME: "Demo",
  GIT_AUTHOR_EMAIL: "demo@example.com",
  GIT_COMMITTER_NAME: "Demo",
  GIT_COMMITTER_EMAIL: "demo@example.com",
};

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, env: { ...gitEnv(), ...DEMO_IDENTITY } });
}

async function seedGitRepo(dir, { readme, files, commitMessages }) {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "README.md"), readme);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", commitMessages[0]);
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await writeFile(path.join(dir, relPath), content);
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", commitMessages[1]);
  // Leave one tracked file modified and one new file untracked, so the Git
  // panel's Changes section has real content instead of "Working tree
  // clean".
  const [firstFile] = Object.keys(files);
  await writeFile(path.join(dir, firstFile), files[firstFile] + "\nconsole.log('debug');\n");
  await writeFile(path.join(dir, "src", "scratch.ts"), "// TODO: wire up the API client\n");
}

// A plausible-looking agent transcript, entirely synthetic — printed with
// small delays so it looks live rather than dumped instantly. `startDelay`
// (seconds) is critical for the mobile shot: dtach starts this script
// running the instant the session is created, before any client has
// attached — a client's terminal-fit resize only affects output printed
// *after* it lands, xterm doesn't reflow already-printed scrollback. A
// long enough pre-print pause lets the mobile client attach and resize the
// PTY before any of these lines exist, so what's on screen isn't clipped
// mid-word to a stale (desktop-sized) column count.
// Single-quoted, not JSON.stringify'd (double-quoted): several transcript
// lines below contain literal `$`/backtick characters (e.g. template-literal
// snippets in the fake diffs), and bash still expands `$…`/`` ` `` inside
// double quotes — a JSON-stringified `echo "..."` line reads those as real
// parameter expansions ("bad substitution") instead of printing them
// verbatim. Single quotes disable all of that; only a literal `'` needs
// escaping, via the standard close-quote/escaped-quote/reopen-quote trick.
function shellSingleQuote(s) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Once the transcript is out, the script keeps the session "working" the way
// a real agent's spinner does, by writing an SGR reset (an invisible no-op)
// every KEEPALIVE_INTERVAL_S. Without it the session falls silent after a
// sustained streak and the backend's silence watchdog (pty-manager.ts's
// SUSTAINED_SILENCE_MS, 10 s) raises a "Gone quiet — <last line>" attention
// badge, which then sits in the sidebar and the kanban's ad-hoc list of
// every later shot and through the landing loop. The interval stays under
// the backend's IDLE_THRESHOLD_MS (2 s) so the row keeps reading "Working".
export const KEEPALIVE_INTERVAL_S = 1;

// `releaseFile`, when given, holds the transcript until that file exists, for
// the same reason as `startDelay` but without guessing a duration: the
// screenshot pipeline creates it once its client has the session open and
// sized, so every line prints into the real terminal (a transcript printed in
// full before any client attached comes back without its first line).
export function agentTranscriptScript({ startDelay, lines, releaseFile }) {
  const hold = releaseFile
    ? `while [ ! -e ${shellSingleQuote(releaseFile)} ]; do sleep 0.1; done\n`
    : "";
  const body = lines
    .map((l) => (l === "" ? "echo" : `echo ${shellSingleQuote(l)}`))
    .join("\nsleep 0.25\n");
  const keepalive = `while :; do printf '\\033[0m'; sleep ${KEEPALIVE_INTERVAL_S}; done`;
  return `#!/usr/bin/env bash\nset -u\nclear\n${hold}sleep ${startDelay}\n${body}\n${keepalive}\n`;
}

/** The last non-blank line of a transcript: once it's in the scrollback, the whole transcript is. */
export function lastTranscriptLine(lines) {
  const last = lines.findLast((l) => l.trim() !== "");
  if (last === undefined) throw new Error("transcript has no non-blank line");
  return last;
}

export const AUTH_TRANSCRIPT = [
  "Claude Code v2.1.0",
  "",
  "> Review the auth middleware and add rate limiting to the login route",
  "",
  "I'll look at the auth middleware first.",
  "",
  "  Read src/middleware/auth.ts",
  "  Read src/routes/login.ts",
  "",
  "Found it — the login route has no rate limiting. Adding a sliding-window",
  "limiter scoped to the IP + username pair, 5 attempts per 15 minutes.",
  "",
  "  Edit src/middleware/rate-limit.ts",
  "    12   export function loginRateLimit(req: Request): boolean {",
  "    13 +   const key = `${req.ip}:${req.body.username}`;",
  "    14 +   return slidingWindow.check(key, 5, 15 * 60_000);",
  "    15   }",
  "",
  "  Edit src/routes/login.ts",
  '     8   router.post("/login", async (req, res) => {',
  "     9 +   if (!loginRateLimit(req)) {",
  '    10 +     return res.status(429).json({ error: "too many attempts" });',
  "    11 +   }",
  "    12     const user = await authenticate(req.body);",
  "",
  "Running the auth test suite...",
  "  ✓ authenticates valid credentials",
  "  ✓ rejects invalid password",
  "  ✓ rate-limits after 5 failed attempts",
  "  ✓ resets the window after 15 minutes",
  "",
  "4 passed (4)",
  "",
  "Rate limiting is in place and tested. Want me to open a PR?",
  "",
];

// Deliberately short lines (well under the ~20-25 visible columns a 375px
// phone screen fits) — unlike the two transcripts above, which are fine at
// desktop width. Long lines here would run off-screen regardless of
// whether the terminal's own reflow is working correctly for a
// freshly-attached mobile client, and this script has no reliable way to
// assert that from the outside; keeping every line short sidesteps the
// question entirely rather than risking a misleading screenshot.
export const MOBILE_TRANSCRIPT = [
  "Claude Code v2.1.0",
  "",
  "> fix the flaky login test",
  "",
  "Looking at the test file.",
  "",
  "  Read auth.test.ts",
  "",
  "Found it — a race on the",
  "mock clock. Awaiting the",
  "timer flush now.",
  "",
  "  Edit auth.test.ts",
  "    12 + await flush();",
  "",
  "Running the suite...",
  "  ✓ 12 passed",
  "",
  "Fixed and green. Want a",
  "PR opened?",
  "",
];

export const ORDERS_TRANSCRIPT = [
  "Codex CLI",
  "",
  "> Add an index on orders.customer_id, queries are slow",
  "",
  "Checking the current schema...",
  "  Read db/schema.sql",
  "",
  "  Edit db/migrations/0012_add_customer_id_index.sql",
  "     1 + CREATE INDEX idx_orders_customer_id ON orders (customer_id);",
  "",
  "Migration written. Running it against the dev database...",
  "Applying migration 0012_add_customer_id_index... done (38ms)",
  "",
];

/**
 * Seeds the demo through `api` (a fetch wrapper bound to the backend) with all
 * files under `root`. The sessions it starts keep running (dtach under systemd
 * scopes) until the demo instance is torn down.
 */
/**
 * `holdTranscripts`: the aurora-web agent (fake-agent.sh) waits for
 * `authReleaseFile` (returned) before printing; see agentTranscriptScript.
 * Off for `make demo`, where nothing would ever release it.
 */
export async function seedDemo({ api, root, holdTranscripts = false }) {
  const scratchRoot = root;
  const scriptsDir = path.join(scratchRoot, "scripts");
  await mkdir(scriptsDir, { recursive: true });

  // --- Seed data ---------------------------------------------------------
  await seedGitRepo(path.join(scratchRoot, "aurora-web"), {
    readme: "# Aurora Web\n\nA demo project used only to generate PWA install screenshots.\n",
    files: { "src/index.ts": 'export function hello() {\n  return "hello";\n}\n' },
    commitMessages: ["Initial commit", "Add version export"],
  });
  await seedGitRepo(path.join(scratchRoot, "orbit-api"), {
    readme: "# Orbit API\n\nA demo project used only to generate PWA install screenshots.\n",
    files: { "src/index.ts": 'export const version = "1.0.0";\n' },
    commitMessages: ["Initial commit", "Bump version"],
  });
  // A third repo, deliberately never registered as a project below — the
  // sidebar's project-discovery panel (Sidebar.tsx's "Configure search
  // roots" empty state) needs at least one genuinely undiscovered
  // candidate under projectRoots to show real "add this project" content
  // instead of an empty/unconfigured state.
  await seedGitRepo(path.join(scratchRoot, "beacon-cli"), {
    readme: "# Beacon CLI\n\nA demo project used only to generate PWA install screenshots.\n",
    files: { "src/index.ts": 'export const name = "beacon";\n' },
    commitMessages: ["Initial commit", "Add CLI entrypoint"],
  });

  // A real install always has at least one workspace; without one the
  // dashboard has nowhere to persist (or count) its tiled layout. GET seeds
  // "Default" itself on an empty table (issue #1618) — POSTing one here
  // would add a second if the browser's own first load won the race.
  await api("/api/workspaces");

  await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ projectRoots: [scratchRoot] }),
  });

  const auroraProject = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "aurora-web", cwd: path.join(scratchRoot, "aurora-web") }),
  });
  const orbitProject = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "orbit-api", cwd: path.join(scratchRoot, "orbit-api") }),
  });

  const authScriptPath = path.join(scriptsDir, "fake-agent.sh");
  const authReleaseFile = path.join(scriptsDir, "fake-agent.release");
  const ordersScriptPath = path.join(scriptsDir, "fake-agent2.sh");
  await writeFile(
    authScriptPath,
    agentTranscriptScript({
      startDelay: 0,
      lines: AUTH_TRANSCRIPT,
      releaseFile: holdTranscripts ? authReleaseFile : undefined,
    }),
    { mode: 0o755 },
  );
  await writeFile(
    ordersScriptPath,
    agentTranscriptScript({ startDelay: 0, lines: ORDERS_TRANSCRIPT }),
    { mode: 0o755 },
  );
  await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: auroraProject.id,
      command: authScriptPath,
      name: "Add login rate limiting",
    }),
  });
  await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: orbitProject.id,
      command: ordersScriptPath,
      name: "Speed up orders query",
    }),
  });

  // Task Master board — deliberately backlog/ready only. Every other
  // status (claimed/in_progress/reviewing/done) is a real lifecycle
  // transition that spins up an actual worker session/worktree; faking
  // that state without the automation behind it would mean this script
  // either runs a real agent CLI (slow, needs credentials, not
  // reproducible in CI) or writes the database directly (silently false
  // to what "regenerate with this script" promises). Staying inside the
  // plain creatable set keeps the whole board honestly reproducible from
  // this file alone, at the cost of a less visually varied column spread.
  const backlogTasks = [
    "Add dark mode toggle to Settings",
    "Fix flaky session-reconciler test",
    "Document the webhook retry policy",
    "Migrate PR badge polling to WS push",
    "Investigate slow cold-start on Preview panel",
    "Add keyboard shortcut for Command Palette history",
  ];
  for (const title of backlogTasks) {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId: auroraProject.id, title, status: "backlog" }),
    });
  }
  const readyTasks = [
    "Speed up orders query with an index",
    "Add rate limiting to the login route",
  ];
  for (const title of readyTasks) {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId: orbitProject.id, title, status: "ready" }),
    });
  }

  return { scratchRoot, scriptsDir, auroraProject, orbitProject, authReleaseFile };
}
