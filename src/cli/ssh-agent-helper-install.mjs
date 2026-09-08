// Issue #820 (PR6b) — `mullion helper install`/`uninstall`: generates and
// (de)registers a launchd job (macOS), systemd --user unit (Linux), or a
// per-user autostart entry (Windows) that supervises `mullion helper run`,
// so a laptop user doesn't have to hand-write one from docs/ssh-agent.md's
// manual-tunnel examples.
//
// Windows round 4 (issue #871) — this used to register a Scheduled Task
// (`schtasks /Create`, `LogonTrigger` + `RestartOnFailure`). Live
// verification on a real, non-elevated Administrator account (the default
// account type on a personal Windows machine) found `schtasks /Create`
// unconditionally fails there with "Access is denied": an Administrator
// account running unelevated holds its own `Administrators` SID as
// deny-only (confirmed with `whoami /groups` and a minimal `schtasks
// /Create` with no XML at all — not a bug in the generated XML). This is
// not a permissions gap to patch; it made `helper install` unable to work
// at all for that entire class of user, on the exact
// `PrivilegesRequired=lowest` account the installer (deploy/windows/
// mullion-helper.iss) deliberately never elevates. Windows now instead
// writes a value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
// — no elevation needed for either account type, and the same mechanism
// essentially every comparable Windows tray app uses (Discord, Slack,
// Dropbox, and 1Password itself, the agent this bridge fronts), unlike
// Scheduled Tasks, which are the pattern per-machine ELEVATED installers
// use (Google Update, browser updaters). It's also the mechanism the
// future `mullion-helper` tray app is expected to use regardless (Tauri's
// `tauri-plugin-autostart` is the same Run key underneath) — this is that
// mechanism arriving early, not throwaway work. `installWindows` and
// `uninstallWindows` below best-effort clean up a Scheduled Task/XML file
// left behind by a pre-round-4 install (a true standard user, or someone
// who happened to run install elevated) so nothing launches `helper run`
// twice.
//
// Known, accepted gap versus the mechanism this replaces (mullion-reviewer
// round): the Scheduled Task's `RestartOnFailure`/`ExecutionTimeLimit`
// gave Windows crash-restart supervision equivalent to launchd's
// `KeepAlive`+`ThrottleInterval` and systemd's `Restart=always`+
// `RestartSec`, both of which macOS/Linux still have unchanged. The HKCU
// Run key has no restart-on-crash concept at all — if `mullion-helper.exe`
// itself crashes (not a network drop or a dead credential, both of which
// `runRun`'s own reconnect/renewal loop already self-heals; an actual
// process exit), nothing restarts it until the next logon. Accepted here
// because the alternative (the Scheduled Task) could not register at all
// for the account type this fix targets — no restart supervision beats no
// installed helper — but this is a real, currently-unclosed gap, not a
// non-issue; a future fix needs its own lightweight supervisor (a second,
// minimal watcher process, plausibly the eventual tray app) rather than
// reaching back for Scheduled Tasks.
//
// The builder functions (buildLaunchdPlist/buildSystemdUnit/
// buildWindowsRunCommand) and the path resolvers below are pure — no
// fs/process/child_process access — so they're unit-testable without a
// real launchd, systemd, or registry. runInstall/runUninstall are the thin
// orchestration layer that actually writes files/registry values and
// shells out to launchctl/systemctl/reg.exe; the
// `io.spawnSync`/`io.spawn`/`io.platform`/`io.homedir`/`io.uid`/
// `io.execPath`/`io.scriptPath` overrides exist only so tests can stub
// those without mocking node:child_process/node:os/process globally (same
// "take io as an injected seam" convention core.mjs's other exports
// already use).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync as nodeSpawnSync, spawn as nodeSpawn } from "node:child_process";
import { isSea as nodeIsSea } from "node:sea";
import { extractFlags, CliUsageError } from "./core.mjs";
import {
  stateDir,
  loadCredential,
  credentialPath,
  WINDOWS_DEFAULT_SSH_AUTH_SOCK,
} from "./ssh-agent-helper.mjs";

// One instance total, not one per host — unlike the manual ssh -R tunnel
// (docs/ssh-agent.md), a single bridge connection already serves every
// enrolled agent host, so there's nothing to template per-host here.
export const LAUNCHD_LABEL = "de.s3ntin3l8.mullion-helper";
export const SYSTEMD_UNIT_NAME = "mullion-helper.service";
// Doubles as the Scheduled Task name (legacy, pre-round-4 installs only —
// see this file's own header comment) and the HKCU Run value name (current
// mechanism) — deliberately the same string across both so a human
// inspecting either mechanism recognizes it as the same install.
export const WINDOWS_TASK_NAME = "MullionHelper";
// scripts/build-helper-sea.mjs's own `exeName` for win32 — fixed, not
// derived per-install, so uninstallWindows (which has no execPath to work
// from; unlike installWindows, nothing hands it one) can still find and
// stop a running helper by image name.
export const WINDOWS_HELPER_EXE_NAME = "mullion-helper.exe";
export const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// Round 3 (PR2) — `defaultScriptPath()` lives in its own file, imported
// dynamically and ONLY on the non-SEA path (runInstall below), rather than
// as a plain top-level import here — see that file's own header comment
// for why: its `import.meta.url` usage can't be bundled to CJS at all, and
// this module IS part of the Node SEA's bundle graph (install/uninstall
// must work from mullion-helper.exe too), so a top-level import would drag
// that unbundlable syntax into the SEA build regardless of whether
// isSea ever gates its result. scripts/build-helper-sea.mjs marks this
// specific file `external` so esbuild never even parses it for that build.
//
// This dynamic import's specifier gets rewritten to a relative path by
// esbuild's bundler wherever it's the caller who ends up bundled (a real
// SEA build) — that rewritten specifier is inert, not a live bug: the ONLY
// call site (runInstall below) is behind `isSea ? null : await
// defaultScriptPath()`, and `isSea` is provably true for the entire
// lifetime of an actual SEA process (node:sea's own isSea(), not a guess),
// so this function is never actually invoked inside one. Self-review
// confirmed this by building and running a real SEA binary end-to-end.
async function defaultScriptPath() {
  const { defaultScriptPath: resolve } = await import("./ssh-agent-helper-default-script-path.mjs");
  return resolve();
}

export function launchdPlistPath(io) {
  const home = io.homedir ?? os.homedir();
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdUnitPath(io) {
  const home = io.homedir ?? os.homedir();
  const configHome = io.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME);
}

// Legacy only (round 3 Scheduled Task mechanism, retired in round 4 — see
// this file's own header comment). No longer written by installWindows;
// kept only so install/uninstall can find and remove a leftover file from
// a pre-round-4 install (a true standard user, or someone who elevated).
export function windowsTaskXmlPath(io) {
  return path.join(stateDir(io), "mullion-helper-task.xml");
}

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Only quotes a systemd ExecStart token when it actually needs it (unit
 * files are otherwise more readable unquoted) — systemd's own quoting rules
 * (man systemd.syntax): double-quote, backslash-escape embedded `"`/`\`.
 * `%` is escaped as `%%` unconditionally, quoted or not — systemd expands
 * `%`-specifiers (%h, %u, %n, ...) in ExecStart even inside double quotes,
 * so a literal `%` in a path (execPath, or an unlucky SSH_AUTH_SOCK) would
 * otherwise be silently mangled rather than passed through. */
function systemdQuote(token) {
  const escaped = token.replace(/%/g, "%%");
  if (!/[\s"\\]/.test(escaped)) return escaped;
  return `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** XML forbids a literal `--` inside a comment body (would break
 * launchctl's own plist parse, not just look ugly) — guards
 * EXPIRY_COMMENT_LINES below against ever reintroducing one, rather than
 * relying on prose discipline alone. */
export function xmlCommentSafe(value) {
  return value.replace(/--/g, "—");
}

/** Escapes a value for embedding inside a double-quoted Windows command
 * line, per the CommandLineToArgvW/MSVCRT parsing rules — a different
 * dialect than systemdQuote's above. A lone `\` before a `"` doesn't
 * protect it there: `\"` mid-argument closes the quoted argument early
 * rather than embedding a literal quote (self-review, PR #879). Rule:
 * any run of backslashes immediately preceding a `"` — or preceding the
 * end of the string, since every caller here wraps the result in a
 * closing `"` right after — must be doubled; a run of backslashes NOT
 * followed by a `"` (the common case: a bare UNC/pipe path like
 * `\\.\pipe\name`) passes through untouched. */
function windowsArgEscape(value) {
  let result = "";
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2);
  return result;
}

// Both generators embed the same note. Round 3 (session renewal) — `run`
// now renews its own session on its own schedule (~50% of the bridge
// session's 24h TTL, ssh-agent-helper.mjs's scheduleRenewal, calling
// routes/agent-bridge.ts's POST /api/bridges/renew, which wires up
// rotateBridgeSession — previously unwired, see docs/ssh-agent.md's
// Credential storage section), so under normal conditions this job runs
// indefinitely without a human re-pairing it. It can still genuinely die —
// the bridge revoked from Settings, or the primary unreachable for longer
// than renewal's own retry budget — and when it does, `run` exits 1 rather
// than retrying with a now-permanently-invalid credential, so an
// unconditional Restart=always/KeepAlive would otherwise tight-loop until a
// human re-pairs. Comment says why; RestartSec/ThrottleInterval keep the
// actual respawn cadence calm rather than tight for that (now much rarer)
// case.
const EXPIRY_COMMENT_LINES = [
  "The bridge session 'mullion helper pair' issues is valid for 24h, but",
  "'mullion helper run' renews it automatically at ~50% of that TTL — under",
  "normal conditions this job runs indefinitely with no re-pairing needed.",
  "If the bridge is revoked from Settings, or the primary is unreachable",
  "for an extended stretch, 'run' still exits 1 once its session is",
  "genuinely dead, and this job restarts into the same failure until you",
  "re-pair with a fresh payload from Settings -> Hosts -> SSH agent",
  "bridges. The restart cadence below is deliberately calm, not tight, for",
  "exactly that (now much rarer) case.",
];

export function buildLaunchdPlist({ execPath, scriptPath, sshAuthSock, logPath }) {
  // Round 4 (issue #820, macOS SEA support) — scriptPath-optional, same
  // shape as buildWindowsRunCommand's own argv construction: a SEA's execPath
  // IS the whole program, so there is no separate script to name. Before
  // this, a null scriptPath crashed here (xmlEscape(null).replace is not a
  // function) the moment installLaunchd ever ran under a SEA — which
  // could not previously happen (isSea was refused on every non-win32
  // platform), so this exact call shape was unreachable until now.
  const argv = [
    execPath,
    ...(scriptPath !== null && scriptPath !== undefined ? [scriptPath] : []),
    "helper",
    "run",
    "--ssh-auth-sock",
    sshAuthSock,
  ];
  const programArguments = argv
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const comment = xmlCommentSafe(EXPIRY_COMMENT_LINES.join("\n       "));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <!-- ${comment} -->
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit({ execPath, scriptPath, sshAuthSock }) {
  const execStart = [execPath, scriptPath, "helper", "run", "--ssh-auth-sock", sshAuthSock]
    .map(systemdQuote)
    .join(" ");
  const comment = EXPIRY_COMMENT_LINES.map((line) => `# ${line}`).join("\n");
  return `[Unit]
Description=Mullion SSH agent bridge helper

[Service]
${comment}
ExecStart=${execStart}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
}

// The full command line for the HKCU Run value — everything CreateProcess
// needs in one string, unlike Task Scheduler's XML which split this into a
// separate <Command>/<Arguments> pair. Every token (execPath included, on
// the theory that a future install location could contain a space even
// though today's `%LOCALAPPDATA%\Mullion\mullion-helper.exe` never does)
// is quoted uniformly and passed through windowsArgEscape — the value
// Windows hands to CreateProcess when running an autostart entry is parsed
// by the same CommandLineToArgvW rules as a command typed at a prompt, the
// exact hazard windowsArgEscape exists for (see its own comment). No XML
// escaping layer needed here — a REG_SZ value is a plain string, not XML
// content.
//
// Round 3 (PR2, Windows SEA) — `scriptPath` is optional: a Node SEA binary
// (helper-main.mjs, bundled by scripts/build-helper-sea.mjs) IS `execPath`
// itself and takes no separate script argument at all, unlike the tarball
// route's `node.exe mullion.mjs helper run ...` shape. Passing `null` here
// (never `undefined` — see runInstall's own comment on why the two must
// stay distinct) collapses the argv to `[execPath, "helper", "run",
// --ssh-auth-sock, sshAuthSock]`. This also incidentally avoids the
// path-permanence trap `defaultScriptPath()` had: under a SEA there's no
// sibling file location for the argv to hard-code, so wherever `install`
// copies/finds the exe IS the permanent path — no "extracted the tarball to
// Downloads, cleaned it up later, autostart entry silently breaks" failure
// mode.
export function buildWindowsRunCommand({ execPath, scriptPath, sshAuthSock, insecure }) {
  const argv = [
    execPath,
    ...(scriptPath !== null && scriptPath !== undefined ? [scriptPath] : []),
    "helper",
    "run",
    "--ssh-auth-sock",
    sshAuthSock,
    ...(insecure ? ["--insecure"] : []),
  ];
  return argv.map((value) => `"${windowsArgEscape(value)}"`).join(" ");
}

function resolveSshAuthSock(flags, io, platform) {
  // Windows falls through to the empirically-confirmed default (issue
  // #874) rather than requiring the flag/env every time — macOS/Linux have
  // no equivalent well-known default (a manual ssh-agent's socket path is
  // never fixed), so this default is win32-only, not a general fallback.
  const value =
    flags["ssh-auth-sock"] ||
    io.env.SSH_AUTH_SOCK ||
    (platform === "win32" ? WINDOWS_DEFAULT_SSH_AUTH_SOCK : undefined);
  if (!value) {
    throw new CliUsageError(
      "no SSH_AUTH_SOCK to install with — pass --ssh-auth-sock <path>, or run this from a " +
        "shell where $SSH_AUTH_SOCK is set. Note: the value is captured as a literal path in " +
        "the generated unit at install time, not re-read from the environment later.",
    );
  }
  // Warn-only, not a hard block: a dangling socket is the expected state
  // whenever the actual agent app isn't running yet (same philosophy as
  // the manual tunnel's own "present: false" diagnostic in
  // docs/ssh-agent.md) — the path can be perfectly correct and just not
  // live yet at install time.
  //
  // Skipped entirely on win32: `value` here is a named pipe path
  // (`\\.\pipe\...`), not a regular file, and `fs.statSync` on a Windows
  // named pipe is unreliable/platform-quirky rather than a clean
  // exists-or-not signal the way it is for a unix domain socket file —
  // untestable from this Linux-only dev/CI environment either way, so this
  // stays a documented gap rather than a confident (and possibly wrong)
  // check.
  if (platform !== "win32") {
    const stat = (io.statSync ?? fs.statSync)(value, { throwIfNoEntry: false });
    if (!stat) {
      io.stderr.write(
        `note: ${value} doesn't exist right now — that's fine if the agent app just isn't ` +
          "running yet, but double-check the path if this is unexpected.\n",
      );
    }
  }
  return value;
}

function warnIfNotPaired(io) {
  if (loadCredential(io)) return;
  io.stderr.write(
    "note: not paired yet — the installed job will fail until you run " +
      "'mullion helper pair <payload>' (generate <payload> from Settings -> Hosts -> SSH " +
      "agent bridges on the primary).\n",
  );
}

function runSpawnSync(io, command, args) {
  return (io.spawnSync ?? nodeSpawnSync)(command, args, { encoding: "utf8" });
}

function installLaunchd(io, { execPath, scriptPath, sshAuthSock }) {
  const plistPath = launchdPlistPath(io);
  const logPath = path.join(stateDir(io), "helper-run.log");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(stateDir(io), { recursive: true, mode: 0o700 });
  const uid = io.uid ?? os.userInfo().uid;
  // Best-effort teardown of a previous install first — launchctl bootstrap
  // fails outright over an already-loaded label, so a re-install (new
  // --ssh-auth-sock, moved checkout, ...) needs this to be idempotent.
  const preTeardown = runSpawnSync(io, "launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  fs.writeFileSync(plistPath, buildLaunchdPlist({ execPath, scriptPath, sshAuthSock, logPath }));
  const result = runSpawnSync(io, "launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  if (result.status !== 0) {
    // Roll back the just-written file — but ONLY when we're confident
    // nothing was loaded under this label before we wrote it (preTeardown
    // succeeded, i.e. there was genuinely nothing to tear down). Otherwise
    // uninstall later finds a plist on disk for a job that was NEVER
    // actually loaded, runs bootout against it, gets launchd's "could not
    // find service" non-zero exit, treats that as a genuine teardown
    // failure (see uninstallLaunchd's own reasoning), and refuses to clean
    // up — wedging the user until they `rm` it by hand (Hermes review).
    //
    // If preTeardown itself FAILED, we can't tell "wasn't loaded" apart
    // from "still loaded and something's wrong" — in that ambiguous case,
    // deleting the file risks the inverse problem: an old job left running
    // with no on-disk plist for a later uninstall to find and stop
    // (Hermes review, round 2). Leaving the file lets uninstall's own
    // already-tested bootout-failure handling take it from here instead
    // of duplicating that judgment call here.
    if (preTeardown.status === 0) fs.rmSync(plistPath, { force: true });
    io.stderr.write(
      `launchctl bootstrap failed: ${(result.stderr || result.error?.message || "unknown error").trim()}\n`,
    );
    return 1;
  }
  io.stdout.write(
    `installed and started — ${plistPath}\n` +
      "check status: launchctl list | grep mullion-helper\n" +
      `logs: tail -f ${logPath}\n` +
      "this session renews itself automatically — no need to re-run 'mullion helper pair' " +
      "unless it's revoked from Settings or unreachable long enough to expire outright.\n",
  );
  return 0;
}

function installSystemd(io, { execPath, scriptPath, sshAuthSock }) {
  const unitPath = systemdUnitPath(io);
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  // Same idempotency reasoning as installLaunchd above.
  runSpawnSync(io, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
  fs.writeFileSync(unitPath, buildSystemdUnit({ execPath, scriptPath, sshAuthSock }));
  runSpawnSync(io, "systemctl", ["--user", "daemon-reload"]);
  const result = runSpawnSync(io, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
  if (result.status !== 0) {
    // Same rollback reasoning as installLaunchd's own bootstrap-failure
    // branch — systemd's `disable` is idempotent on a not-enabled unit
    // (unlike launchd's bootout), so this is more of a symmetry/defense-
    // in-depth measure than a confirmed-necessary fix on this platform.
    fs.rmSync(unitPath, { force: true });
    runSpawnSync(io, "systemctl", ["--user", "daemon-reload"]);
    io.stderr.write(
      `systemctl enable failed: ${(result.stderr || result.error?.message || "unknown error").trim()}\n`,
    );
    return 1;
  }
  io.stdout.write(
    `installed and started — ${unitPath}\n` +
      `check status: systemctl --user status ${SYSTEMD_UNIT_NAME}\n` +
      `logs: journalctl --user -u ${SYSTEMD_UNIT_NAME} -f\n` +
      "run 'loginctl enable-linger $(whoami)' so this survives logout.\n" +
      "this session renews itself automatically — no need to re-run 'mullion helper pair' " +
      "unless it's revoked from Settings or unreachable long enough to expire outright.\n",
  );
  return 0;
}

// `spawn()` itself never throws for a failure to actually start the child
// (ENOENT, EACCES, an AV/EDR product transiently locking the just-written
// exe) — that class of failure only ever surfaces asynchronously, as an
// `'error'` event on the returned ChildProcess (self-review, mullion-
// reviewer round: a bare `try { spawn(...) } catch {}` around this call
// cannot catch it, and this file's own immediate `process.exit()` right
// after `runInstall` returns leaves no window for an unlistened-for
// `'error'` to be observed later — worse, EventEmitter's default behavior
// for an 'error' event with NO listener attached is to throw, which could
// crash this process with an unrelated stack trace instead of the success
// message it was about to print). `'spawn'` is the documented counterpart
// — Node guarantees exactly one of the two fires for a real spawn attempt,
// never neither — so awaiting whichever comes first turns an
// unobservable async failure into a synchronously reportable one, at the
// cost of a spawn() round trip's worth of async time before `install`
// returns. `unref()` only once spawn is confirmed successful — unref'ing
// a child that's about to fail doesn't change anything, but doing it
// before we know keeps the intent ("we manage this process's own runtime
// lifetime, not our exit") tied to the branch where it actually applies.
function spawnDetachedHelper(io, execPath, argv, logFd) {
  return new Promise((resolve) => {
    // A real Node spawn() call itself is not expected to throw
    // synchronously for a runtime failure (see the function's own header
    // comment) — but this catch keeps a genuinely unexpected synchronous
    // throw (a malformed argv, for instance) degrading to the same
    // "warning, not a failed install" outcome as the documented async
    // 'error' path below, rather than escaping uncaught.
    let child;
    try {
      child = runDetachedSpawn(io, execPath, argv, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (err) {
      resolve({ ok: false, error: err });
      return;
    }
    // Round 4 diagnostic follow-up (issue #871) — whichever of these two
    // fires first, remove the OTHER one too: `.once()` only self-removes
    // the listener that actually fired, so the loser stayed registered on
    // this `child` indefinitely after this Promise already settled. If
    // that leftover listener's event (most plausibly a late `'error'`
    // after a successful `'spawn'`, e.g. the detached child later failing
    // to write to its inherited log fd) ever fired, there was nothing left
    // to catch it — an unhandled exception inside an event listener
    // becomes an `unhandledRejection`-equivalent crash of the *parent*
    // process, well after `installWindows` had already returned 0 and
    // `helper-main.mjs` may already be mid-exit.
    let settled = false;
    const onError = (err) => {
      if (settled) return;
      settled = true;
      child.removeListener("spawn", onSpawn);
      resolve({ ok: false, error: err });
    };
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      child.removeListener("error", onError);
      child.unref();
      resolve({ ok: true });
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

function runDetachedSpawn(io, command, args, options) {
  return (io.spawn ?? nodeSpawn)(command, args, options);
}

// Best-effort teardown of a pre-round-4 install (a true standard user, or
// someone who ran `helper install` elevated, could have successfully
// registered the old Scheduled Task) — shared by installWindows (so a
// re-install never ends up with BOTH mechanisms launching `helper run`)
// and uninstallWindows. `/End`/`/Delete`/`/F` failing here is the expected,
// silent case for the vast majority of installs (no such task was ever
// registered, so this is just Access-denied again, or "task not found") —
// not worth surfacing as an error on top of whatever this function's own
// caller is already reporting.
function cleanUpLegacyScheduledTask(io) {
  runSpawnSync(io, "schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
  runSpawnSync(io, "schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  const xmlPath = windowsTaskXmlPath(io);
  if (fs.existsSync(xmlPath)) fs.rmSync(xmlPath, { force: true });
}

// Root cause of issue #871's test-windows silent exit-1 (found via
// temporary stdout checkpoints added, then removed, while diagnosing this):
// `helper install`/`helper uninstall` ARE THEMSELVES a running mullion-helper.exe
// process — `taskkill /IM mullion-helper.exe /F` matches by image name,
// with no notion of "not this one", so the very first real run of either
// verb killed its own CLI invocation mid-execution. Windows reports a
// forcibly-terminated process's exit code as 1 — indistinguishable from a
// normal failure — and nothing after the kill ever runs, which is why
// zero diagnostic output ever reached the CI log no matter what this file
// or helper-main.mjs's exit/flush handling did: there was no exception to
// catch or message to flush, the process was gone. `/FI "PID ne <self>"`
// excludes the current process from the match while still catching every
// OTHER mullion-helper.exe (a stale detached `helper run`, or another
// concurrent install/uninstall) by image name, same as before.
function killOtherHelperProcesses(io) {
  const pid = io.pid ?? process.pid;
  runSpawnSync(io, "taskkill", ["/F", "/FI", `PID ne ${pid}`, "/IM", WINDOWS_HELPER_EXE_NAME]);
}

// Round 4 (issue #871) — HKCU Run key, not a Scheduled Task; see this
// file's own header comment for why. `reg add ... /f` is unconditionally
// idempotent the same way `schtasks /Create /F` was, so a re-install still
// needs no separate pre-teardown step and no XML-style rollback dance: a
// REG_SZ value either replaces the previous one atomically or the add
// fails outright with nothing written, unlike a multi-step file write.
async function installWindows(io, { execPath, scriptPath, sshAuthSock, insecure }) {
  fs.mkdirSync(stateDir(io), { recursive: true, mode: 0o700 });
  cleanUpLegacyScheduledTask(io);

  const command = buildWindowsRunCommand({ execPath, scriptPath, sshAuthSock, insecure });
  const result = runSpawnSync(io, "reg", [
    "add",
    WINDOWS_RUN_KEY,
    "/v",
    WINDOWS_TASK_NAME,
    "/t",
    "REG_SZ",
    "/d",
    command,
    "/f",
  ]);
  if (result.status !== 0) {
    io.stderr.write(
      `reg add failed: ${(result.stderr || result.error?.message || "unknown error").trim()}\n`,
    );
    return 1;
  }

  // Self-review (mullion-reviewer round) — the `reg add` above only ever
  // replaces the AUTOSTART REGISTRATION atomically; it says nothing about
  // a helper process spawned by a PRIOR install (a `--ssh-auth-sock`
  // change, most plausibly) that's still running right now, bound to the
  // old value. Without this, "re-running the command later cleanly
  // replaces the previous install" (docs/ssh-agent.md) would be true only
  // of the registry entry, while a stale process kept running against the
  // old socket, racing the new one on the same credential file's renewal
  // writes. Deliberately placed AFTER `reg add` succeeds, not before: a
  // failed registration must not leave the user with the old (working)
  // process killed and nothing running in its place. Best-effort and
  // unconditional, same as uninstallWindows's own taskkill — "no matching
  // process" is the common, expected outcome on a genuinely first-ever
  // install. Must exclude THIS process's own PID (killOtherHelperProcesses)
  // — see that function's own comment for why: this CLI invocation is
  // itself a running mullion-helper.exe.
  killOtherHelperProcesses(io);

  // `reg add` only *registers* the autostart entry; Windows launches it at
  // the NEXT logon, same gap `/Run` used to close for the Scheduled Task
  // (Hermes review, PR #879, on the mechanism this replaces — the
  // invariant carries over unchanged). Start it now too, so `install`
  // means the same thing ("running now, and persists across
  // reboots/logout") on every platform. A failed spawn doesn't undo the
  // successful registration — same "warning, not a failed install"
  // posture the old `/Run` failure had.
  const logPath = path.join(stateDir(io), "helper-run.log");
  const runArgv = [
    ...(scriptPath !== null && scriptPath !== undefined ? [scriptPath] : []),
    "helper",
    "run",
    "--ssh-auth-sock",
    sshAuthSock,
    ...(insecure ? ["--insecure"] : []),
  ];
  const degradeToWarning = (reason) => {
    io.stderr.write(
      `installed — ${WINDOWS_RUN_KEY}\\${WINDOWS_TASK_NAME}\n` +
        `note: could not start it immediately (${reason}) — ` +
        "it will start at your next logon instead. Start it now with " +
        // This function only runs from installWindows below, so the target
        // is always PowerShell (Windows 11's default terminal) — a bare
        // quoted path there is inert without the `&` call operator prefix,
        // the same reasoning as PairBridgeModal.tsx's own commandFor() and
        // the .iss installer's dialogs.
        `'& "${execPath}" ${runArgv.map((v) => `"${v}"`).join(" ")}'.\n`,
    );
    return 0;
  };
  let logFd;
  try {
    logFd = fs.openSync(logPath, "a");
  } catch (err) {
    return degradeToWarning(err.message);
  }
  const spawnResult = await spawnDetachedHelper(io, execPath, runArgv, logFd);
  if (!spawnResult.ok) {
    return degradeToWarning(spawnResult.error.message);
  }
  io.stdout.write(
    `installed and started — ${WINDOWS_RUN_KEY}\\${WINDOWS_TASK_NAME}\n` +
      `logs: ${logPath}\n` +
      "this session renews itself automatically — no need to re-run 'mullion helper pair' " +
      "unless it's revoked from Settings or unreachable long enough to expire outright.\n",
  );
  return 0;
}

export async function runInstall(args, io) {
  const platform = io.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    io.stderr.write(`mullion helper install isn't supported on '${platform}'.\n`);
    return 1;
  }
  const { flags } = extractFlags(args, { "ssh-auth-sock": "string", insecure: "boolean" });
  const sshAuthSock = resolveSshAuthSock(flags, io, platform);
  const insecure = flags.insecure === true;
  const execPath = io.execPath ?? process.execPath;
  // Round 3 (PR2) — `io.isSea` is the same injected-seam convention as
  // `io.platform`/`io.homedir` above, letting tests exercise the SEA
  // branch from Linux without an actual SEA binary. `node:sea`'s own
  // `isSea()` returns `false` (never throws) outside a SEA, so this is
  // safe to call unconditionally on every platform.
  const isSea = io.isSea !== undefined ? io.isSea : nodeIsSea();
  // Round 2/3 shipped Windows; round 4 (issue #820) adds macOS —
  // `buildLaunchdPlist` now has the same scriptPath-optional handling
  // `buildWindowsRunCommand` already has. Linux stays refused: no SEA is
  // ever built for Linux (scripts/build-helper-sea.mjs targets win32/darwin
  // only), so `helper install` on Linux is always the Node-from-source
  // path, and `buildSystemdUnit` has never needed (and still doesn't have)
  // null-scriptPath handling. Refusing cleanly here is far better than the
  // alternative already confirmed by self-review: `defaultScriptPath()`'s
  // dynamic import of its own split-out sibling file (see that file's own
  // comment) fails at runtime inside a real SEA with an opaque "No such
  // built-in module" error, since a single-file executable has no real
  // on-disk module-resolution context to satisfy an externalized relative
  // import against.
  if (isSea && platform === "linux") {
    io.stderr.write(
      `mullion helper install: this build is a Node SEA, which is not supported on '${platform}'.\n`,
    );
    return 1;
  }
  // Issue #1147 — the non-SEA (tarball/checkout) path on Windows is not the
  // supported install path. The SEA installer is the only tested and
  // documented way to install on Windows; the non-SEA path has untested
  // edge cases (e.g. the `node.exe` process image vs `mullion-helper.exe`
  // in taskkill). Refusing cleanly here is far better than letting a user
  // hit a subtle failure later.
  if (!isSea && platform === "win32") {
    io.stderr.write(
      "mullion helper install: the non-SEA (tarball/checkout) path is not supported on Windows. " +
        "Use the SEA installer (mullion-helper-setup.exe) instead.\n",
    );
    return 1;
  }
  // `isSea` implies win32 or darwin here — the guard above already
  // rejected linux — so `null` (not `defaultScriptPath()`) is safe on
  // both: `buildWindowsRunCommand` and `buildLaunchdPlist` both have a
  // scriptPath-optional mode now (`buildSystemdUnit` doesn't, but isSea
  // can no longer reach it).
  //
  // Deliberately `!== undefined`, not `??`, for `io.scriptPath` itself: a
  // caller passing `scriptPath: null` explicitly must stay `null` all the
  // way to buildWindowsRunCommand — `??` would treat `null` the same as
  // `undefined` and fall through to `defaultScriptPath()` instead.
  const scriptPath =
    io.scriptPath !== undefined ? io.scriptPath : isSea ? null : await defaultScriptPath();
  warnIfNotPaired(io);

  const opts = { execPath, scriptPath, sshAuthSock, insecure };
  if (platform === "darwin") return installLaunchd(io, opts);
  if (platform === "win32") return installWindows(io, opts);
  return installSystemd(io, opts);
}

// Both uninstallers check the on-disk file FIRST, before ever shelling out:
// if we never wrote one (or a previous uninstall already removed it),
// there's nothing to tear down and no reason to treat a "not loaded"-style
// bootout/disable exit as an error. But once we know a unit genuinely
// exists, a non-zero teardown result is treated as a real failure — NOT
// swallowed — because silently deleting the file and reporting success
// would leave a still-running `mullion helper run` process unmanageable
// via launchctl/systemctl (its unit definition would already be gone).
function uninstallLaunchd(io) {
  const plistPath = launchdPlistPath(io);
  if (!fs.existsSync(plistPath)) {
    io.stdout.write("nothing installed.\n");
    return 0;
  }
  const uid = io.uid ?? os.userInfo().uid;
  const result = runSpawnSync(io, "launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  if (result.status !== 0) {
    io.stderr.write(
      `launchctl bootout failed: ${(result.stderr || result.error?.message || "unknown error").trim()} — ` +
        "leaving the job file in place; 'mullion helper run' may still be active. Investigate with " +
        "'launchctl list | grep mullion-helper' before retrying.\n",
    );
    return 1;
  }
  fs.rmSync(plistPath, { force: true });
  io.stdout.write(`removed ${plistPath}\n`);
  return 0;
}

function uninstallSystemd(io) {
  const unitPath = systemdUnitPath(io);
  if (!fs.existsSync(unitPath)) {
    io.stdout.write("nothing installed.\n");
    return 0;
  }
  const result = runSpawnSync(io, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
  if (result.status !== 0) {
    io.stderr.write(
      `systemctl disable failed: ${(result.stderr || result.error?.message || "unknown error").trim()} — ` +
        "leaving the unit file in place; 'mullion helper run' may still be active. Investigate with " +
        `'systemctl --user status ${SYSTEMD_UNIT_NAME}' before retrying.\n`,
    );
    return 1;
  }
  fs.rmSync(unitPath, { force: true });
  runSpawnSync(io, "systemctl", ["--user", "daemon-reload"]);
  io.stdout.write(`removed ${unitPath}\n`);
  return 0;
}

// Same "check first, then treat a genuine teardown failure as real, not
// swallowed" shape as uninstallLaunchd/uninstallSystemd above — but two
// artifacts to check now, not one: the current Run-key mechanism and a
// possible leftover from a pre-round-4 (Scheduled Task) install.
function uninstallWindows(io) {
  const legacyXmlPath = windowsTaskXmlPath(io);
  const hadLegacyXml = fs.existsSync(legacyXmlPath);
  // Known, narrow gap (self-review, mullion-reviewer round): `status !==
  // 0` is treated as "no such value" below, but it's also what a genuinely
  // broken `reg.exe` invocation (a locked hive, a failed spawn of reg.exe
  // itself) would produce — the same status:null-vs-clean-rejection
  // ambiguity Step 0 of this fix's own investigation ran into with
  // `schtasks`. Not resolved the same way that investigation resolved it
  // (parsing reg.exe's own locale-dependent "not found" text), matching
  // this file's existing posture elsewhere of not parsing that kind of
  // text for logic decisions — accepted because, unlike `schtasks` (found
  // via PATH, which a GUI-launched child isn't guaranteed to have), `reg`
  // is a core, always-present System32 binary with no equivalent PATH
  // risk, so this failure mode is far less likely in practice. Worst case:
  // a real, still-running Run entry gets reported as "nothing installed"
  // and left behind — recoverable by re-running uninstall once whatever
  // broke `reg.exe` is fixed.
  const queryResult = runSpawnSync(io, "reg", ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_TASK_NAME]);
  const hadRunValue = queryResult.status === 0;

  if (!hadRunValue && !hadLegacyXml) {
    // Still worth a best-effort legacy schtasks cleanup even when neither
    // artifact this function itself checked for is present — a laptop that
    // only ever got a hand-run `schtasks /Create` (never install's own XML
    // under stateDir(io)) would otherwise survive uninstall silently.
    // cleanUpLegacyScheduledTask's own calls are silent no-ops when there's
    // genuinely nothing to remove.
    cleanUpLegacyScheduledTask(io);
    io.stdout.write("nothing installed.\n");
    return 0;
  }

  // Unlike uninstallLaunchd's `bootout` and uninstallSystemd's `--now`,
  // which both stop the running job as part of unregistering it, deleting
  // the Run value only removes the AUTOSTART registration — a currently-
  // running instance of mullion-helper.exe (the steady state on a real,
  // already-paired laptop: installWindows starts it immediately) keeps
  // running and keeps the exe file open. Left alone, that file lock makes
  // the installer's own [Files] removal (which runs after [UninstallRun])
  // fail or defer on a real machine — the exact hazard Hermes review (PR
  // #905) caught against the Scheduled Task mechanism this replaces; it's
  // unchanged here. By image name, not a tracked PID: nothing records one
  // (installWindows's own spawn is detached and unref()'d, deliberately
  // untracked), and killing every OTHER mullion-helper.exe is also the
  // right behavior if more than one somehow ended up running. Best-effort
  // — "no matching process" is the common, expected outcome when nothing
  // is running right now, not a failure worth surfacing. Excluding THIS
  // process's own PID is not optional, though — see
  // killOtherHelperProcesses's own comment: `helper uninstall` is itself a
  // running mullion-helper.exe, so an unfiltered `/IM` match self-kills
  // the CLI invocation before it reaches the `reg delete` below (issue
  // #871's actual root cause, found via test-windows).
  //
  // Known gap, not fixed here: a laptop running the non-SEA (tarball/
  // checkout) path on win32 — `node.exe mullion.mjs helper run ...`,
  // reachable since `runInstall` only refuses `isSea && linux`, not every
  // non-SEA combination — has its real process image named `node.exe`,
  // which this misses entirely. docs/ssh-agent.md steers every Windows
  // user at the SEA installer/exe exclusively (the tarball/checkout
  // instructions are scoped to "macOS (without the installer) or Linux"),
  // so this is a narrow, undocumented corner case, not the supported path
  // — worth knowing about, not worth a PID-tracking mechanism to close.
  killOtherHelperProcesses(io);
  cleanUpLegacyScheduledTask(io);

  if (hadRunValue) {
    const result = runSpawnSync(io, "reg", [
      "delete",
      WINDOWS_RUN_KEY,
      "/v",
      WINDOWS_TASK_NAME,
      "/f",
    ]);
    if (result.status !== 0) {
      io.stderr.write(
        `reg delete failed: ${(result.stderr || result.error?.message || "unknown error").trim()} — ` +
          "leaving the autostart entry in place; 'mullion helper run' may still be active. Investigate with " +
          `'reg query "${WINDOWS_RUN_KEY}" /v ${WINDOWS_TASK_NAME}' before retrying.\n`,
      );
      return 1;
    }
    // Only when a Run value genuinely existed and was just deleted — self-
    // review, mullion-reviewer round: this message used to print
    // unconditionally, including on a laptop whose ONLY artifact was a
    // pre-round-4 Scheduled Task (hadLegacyXml true, hadRunValue false),
    // falsely implying a registry value had been removed when none ever
    // existed for this install.
    io.stdout.write(`removed ${WINDOWS_RUN_KEY}\\${WINDOWS_TASK_NAME}\n`);
  }
  return 0;
}

// Issue #904 — deletes the local pairing credential (and any stray
// write-to-temp-then-rename sibling saveCredential's own comment describes,
// ssh-agent-helper.mjs: a process killed mid-write can leave
// `ssh-agent-bridge.json.<pid>.tmp` behind holding the same session_id —
// the same bearer credential under a different name, so it needs the same
// treatment). This is the ONE thing common to all three platforms, so it
// lives here once rather than being triplicated into
// uninstallWindows/uninstallLaunchd/uninstallSystemd: doing it inside those
// functions would miss a laptop that ran `helper pair` but never `helper
// install` (or whose supervisor artifact is already gone some other way) —
// all three of those return 0 from their own "nothing installed" gate
// before touching anything, and a paired-but-never-installed credential
// still needs to go.
//
// Best-effort per file, like saveCredential's own cleanup (same module,
// helper.mjs): {app} on Windows IS stateDir() (PR3's own DisableDirPage
// comment), and this runs from the installer's own [UninstallRun] — a
// transient AV/indexer lock (EPERM/EBUSY) on a just-renamed JSON file there
// is an ordinary occurrence, not exotic, and `{ force: true }` alone only
// suppresses ENOENT. A failed delete is reported, not thrown — it must not
// turn an already-successful supervisor teardown into a hard crash. Only
// paths that actually get removed are reported, not the canonical filename
// unconditionally — a run that only finds a stray .tmp sibling (the main
// file never existed) must not claim it removed a file that was never
// there. (Hermes/self-review, PR #911.)
function removeCredential(io) {
  const file = credentialPath(io);
  const dir = stateDir(io);
  const base = path.basename(file);
  const removed = [];

  if (fs.existsSync(file)) {
    try {
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch (err) {
      io.stderr.write(
        `warning: could not remove pairing credential ${file}: ${err.message} — remove it by hand if you want it fully forgotten.\n`,
      );
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.startsWith(`${base}.`) && entry.endsWith(".tmp")) {
      const tmpPath = path.join(dir, entry);
      try {
        fs.rmSync(tmpPath, { force: true });
        removed.push(tmpPath);
      } catch (err) {
        io.stderr.write(
          `warning: could not remove stale credential file ${tmpPath}: ${err.message}\n`,
        );
      }
    }
  }

  for (const removedPath of removed) io.stdout.write(`removed ${removedPath}\n`);
}

export async function runUninstall(_args, io) {
  const platform = io.platform ?? process.platform;
  let code;
  if (platform === "darwin") code = uninstallLaunchd(io);
  else if (platform === "linux") code = uninstallSystemd(io);
  else if (platform === "win32") code = uninstallWindows(io);
  else {
    io.stderr.write(`mullion helper uninstall isn't supported on '${platform}'.\n`);
    return 1;
  }
  // Only on a SUCCESSFUL teardown: a genuine teardown failure (reg delete,
  // systemctl disable, launchctl bootout all returning nonzero) means the
  // platform function's own stderr message already warns "'mullion helper
  // run' may still be active" — deleting the credential out from under a
  // still-running, still-supervised process would leave it unable to
  // reconnect on its next restart. That failure path returns early above
  // (uninstallWindows etc. `return 1`), so `code === 0` here means the
  // supervisor's OWN registration is genuinely gone.
  //
  // Windows-only residual gap, not fully closed by that: uninstallWindows's
  // own `taskkill /IM` (round 4 — replaced `schtasks /End`, see this file's
  // header comment) is best-effort and its result isn't checked at all —
  // "no matching process" is the common, benign case, and distinguishing it
  // from a genuine termination failure would mean parsing taskkill's own
  // locale-dependent error text. So `code === 0` on win32 does NOT
  // guarantee the actual mullion-helper.exe process has exited, only that
  // its autostart registration has. If it's still alive and renewing when
  // this runs, the narrow way it could notice is removeCredential's own
  // tmp-sibling sweep below racing that SAME process's own in-flight
  // saveCredential call (ssh-agent-helper.mjs) — deleting its just-written
  // `<pid>.tmp` out from under it before its own renameSync runs. That
  // renameSync's ENOENT lands in renewSession's generic catch, which treats
  // ANY save failure as transient and retries on its own backoff — not a
  // crash, not a stranded session, just one missed renewal cycle before
  // either a later renewal succeeds or the process eventually exits on
  // "credential file missing". Not worth chasing further given that
  // self-healing (self-review, PR #911).
  if (code === 0) removeCredential(io);
  return code;
}
