// Issue #820 (PR6b) — `mullion helper install`/`uninstall`: generates and
// (de)registers a launchd job (macOS), systemd --user unit (Linux), or
// Windows Scheduled Task (issue #873 Phase 3) that supervises
// `mullion helper run`, so a laptop user doesn't have to hand-write one
// from docs/ssh-agent.md's manual-tunnel examples. The Windows generator
// has no local verification path either (no way to run `schtasks.exe` from
// this Linux-only CI/dev environment) — same caveat the macOS/Linux
// generators already carried before their own first real-machine test; see
// docs/ssh-agent.md for status and the tracking issue.
//
// The builder functions (buildLaunchdPlist/buildSystemdUnit) and the path
// resolvers below are pure — no fs/process/child_process access — so
// they're unit-testable without a real launchd or systemd. runInstall/
// runUninstall are the thin orchestration layer that actually writes files
// and shells out to launchctl/systemctl; the `io.spawnSync`/`io.platform`/
// `io.homedir`/`io.uid`/`io.execPath`/`io.scriptPath` overrides exist only
// so tests can stub those without mocking node:child_process/node:os/
// process globally (same "take io as an injected seam" convention
// core.mjs's other exports already use).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractFlags, CliUsageError } from "./core.mjs";
import { stateDir, loadCredential } from "./ssh-agent-helper.mjs";

// One instance total, not one per host — unlike the manual ssh -R tunnel
// (docs/ssh-agent.md), a single bridge connection already serves every
// enrolled agent host, so there's nothing to template per-host here.
export const LAUNCHD_LABEL = "de.s3ntin3l8.mullion-helper";
export const SYSTEMD_UNIT_NAME = "mullion-helper.service";
export const WINDOWS_TASK_NAME = "MullionHelper";

function defaultScriptPath() {
  // Sibling of this file — mullion.mjs, byte-identical in dist/cli/ per
  // package.json's build step (see mullion.mjs's own header comment).
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "mullion.mjs");
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

// `schtasks /Create /XML <path>` reads the task definition from a file on
// disk (there's no stdin form), so — unlike launchd/systemd, which register
// directly against a well-known filesystem location the OS itself expects —
// this file's location is Mullion's own choice. Same directory convention
// as launchd's log file (installLaunchd's own `logPath`): stateDir(io),
// this platform's equivalent of `~/Library/Application Support` /
// `$XDG_STATE_HOME`. Kept on disk (not a temp file deleted after
// registration) so uninstallWindows can use the same "check the file first"
// pattern uninstallLaunchd/uninstallSystemd already use, without needing to
// shell out to `schtasks /Query` just to find out whether anything's
// installed.
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

// Both generators embed the same warning: the bridge session `pair` issues
// is a fixed 24h deadline from the moment of pairing (bridge-registry.ts's
// SESSION_TTL_MS), never extended by reconnecting — rotateBridgeSession
// exists but has zero call sites (see docs/ssh-agent.md's Credential
// storage section). Once it expires, `run` exits 1 rather than retrying,
// so an unconditional Restart=always/KeepAlive would otherwise tight-loop
// once a day until a human re-pairs. Comment says why; RestartSec/
// ThrottleInterval keep the actual respawn cadence calm rather than tight.
const EXPIRY_COMMENT_LINES = [
  "The bridge session 'mullion helper pair' issues is valid for 24h from",
  "pairing and is never renewed by reconnecting (docs/ssh-agent.md) — once",
  "it expires, 'run' exits 1 and this job restarts into the same failure",
  "until you re-pair with a fresh payload from Settings -> Hosts -> SSH",
  "agent bridges. The restart cadence below is deliberately calm, not",
  "tight, for exactly that expected daily failure.",
];

export function buildLaunchdPlist({ execPath, scriptPath, sshAuthSock, logPath }) {
  const programArguments = [execPath, scriptPath, "helper", "run", "--ssh-auth-sock", sshAuthSock]
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

// Task Scheduler XML (schema: http://schemas.microsoft.com/windows/2004/02/mit/task)
// rather than a long `schtasks /Create` flag list — same reasoning as the
// launchd/systemd generators above: a file on disk a user (or a future
// uninstaller) can actually read, not an opaque one-liner. Element-by-
// element mapping to the other two platforms' equivalents:
//   - LogonTrigger                    <-> launchd RunAtLoad / systemd WantedBy=default.target
//   - RestartOnFailure (PT1M, x999)   <-> launchd KeepAlive+ThrottleInterval / systemd Restart=always+RestartSec
//     — 1-minute floor is Task Scheduler's own minimum granularity for this
//     element (Microsoft's schema docs), which happens to land in the same
//     "calm, not tight" territory EXPIRY_COMMENT_LINES above explains the
//     other two platforms' own interval choices with. Count capped at 999,
//     not an arbitrarily larger number: two independent reviews (self-
//     review and Hermes, PR #879) flagged that Task Scheduler's own
//     RestartCount element is documented with a 999 upper bound elsewhere
//     in Microsoft's schema docs, and this environment can't confirm the
//     exact figure against a real `schtasks /Create` — 999 restarts at a
//     1-minute floor is already ~16.6 hours of retrying, comfortably more
//     than enough headroom for the 24h credential-expiry cycle
//     EXPIRY_COMMENT_LINES describes, so staying at or under any plausible
//     cap costs nothing here.
//   - ExecutionTimeLimit PT0S (unlimited) — the default is PT72H (3 days),
//     which would silently kill this long-running foreground process out
//     from under itself; every other platform's job here runs indefinitely
//     by default, so this is a correctness fix, not a preference.
//   - LogonType InteractiveToken + RunLevel LeastPrivilege <-> launchd/
//     systemd both run as the inviting user with no privilege escalation.
export function buildWindowsTaskXml({ execPath, scriptPath, sshAuthSock }) {
  // Every token quoted uniformly (scriptPath included — a very plausible
  // "C:\Program Files\..." space, unlike execPath which Windows itself
  // never puts a space in for a bare `node.exe`), matching <Arguments>'s
  // own documented shell-like tokenizing (Microsoft's Task Scheduler docs:
  // this string is parsed the same way a command line typed at a prompt
  // would be — i.e. CommandLineToArgvW rules, not just "valid XML"). Two
  // escaping layers, applied in this order and not the reverse:
  //   1. windowsArgEscape — makes the raw value safe as CommandLineToArgvW-
  //      quoted argv text (backslash-escapes an embedded `"` so it doesn't
  //      prematurely close the quoted argument). Self-review (mullion-
  //      reviewer) caught that XML-escaping alone doesn't provide this: an
  //      embedded `"` decoded from a bare `&quot;` would still be parsed by
  //      Windows as closing the argument early, silently truncating/
  //      corrupting the value rather than embedding it.
  //   2. xmlEscape — makes THAT text safe as XML element content. Must run
  //      second: windowsArgEscape's own output can itself contain literal
  //      `"` characters (from its `\"` escaping) that still need `&quot;`.
  const args = [scriptPath, "helper", "run", "--ssh-auth-sock", sshAuthSock]
    .map((value) => `"${xmlEscape(windowsArgEscape(value))}"`)
    .join(" ");
  const comment = xmlEscape(EXPIRY_COMMENT_LINES.join(" "));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Mullion SSH agent bridge helper. ${comment}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(execPath)}</Command>
      <Arguments>${args}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function resolveSshAuthSock(flags, io, platform) {
  const value = flags["ssh-auth-sock"] || io.env.SSH_AUTH_SOCK;
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
      "the paired session is valid for 24h — re-run 'mullion helper pair <payload>' at least " +
      "once a day for uninterrupted coverage.\n",
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
      "the paired session is valid for 24h — re-run 'mullion helper pair <payload>' at least " +
      "once a day for uninterrupted coverage.\n",
  );
  return 0;
}

// Unlike launchd/systemd, `schtasks /Create /F` is unconditionally
// idempotent — it silently overwrites an existing task with the same name
// rather than erroring, so there's no separate pre-teardown step, and none
// of the "was preTeardown itself ambiguous" rollback judgment call
// installLaunchd's own comment works through. But a create failure is
// still not unconditionally safe to roll back the same way regardless of
// prior state (self-review, PR #879): a FIRST-ever install failing leaves
// nothing to restore, so deleting the just-written file is correct — but a
// RE-install failing must NOT delete it. `schtasks /Create` either
// replaces the previously-registered task atomically or leaves it running
// untouched; either way that old task survives a failed `/Create`, so
// deleting the XML would make uninstallWindows's own "check the file
// first" gate silently report "nothing installed" forever, with no way for
// this tool to find and stop the still-running task again. Capture and
// restore the prior content instead, mirroring what a real rollback would
// need to do.
function installWindows(io, { execPath, scriptPath, sshAuthSock }) {
  const xmlPath = windowsTaskXmlPath(io);
  fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
  const previousXml = fs.existsSync(xmlPath) ? fs.readFileSync(xmlPath) : null;
  // Task Scheduler XML declares `encoding="UTF-16"` and XML 1.0 §4.3.3
  // requires a UTF-16 entity to begin with a byte-order mark — Node's own
  // `utf16le` encoding never emits one (confirmed: writeFileSync with this
  // encoding starts directly with the first character's bytes), so without
  // the explicit \uFEFF prefix this file would be non-conforming for the
  // encoding it declares (self-review, PR #879). Written as an escape
  // sequence, not a literal invisible character, so it can't be silently
  // stripped or mangled by an editor/git.
  fs.writeFileSync(xmlPath, "\uFEFF" + buildWindowsTaskXml({ execPath, scriptPath, sshAuthSock }), {
    encoding: "utf16le",
  });
  const result = runSpawnSync(io, "schtasks", [
    "/Create",
    "/TN",
    WINDOWS_TASK_NAME,
    "/XML",
    xmlPath,
    "/F",
  ]);
  if (result.status !== 0) {
    if (previousXml === null) fs.rmSync(xmlPath, { force: true });
    else fs.writeFileSync(xmlPath, previousXml);
    io.stderr.write(
      `schtasks /Create failed: ${(result.stderr || result.error?.message || "unknown error").trim()}\n`,
    );
    return 1;
  }
  // Hermes review, PR #879 — `/Create` only *registers* the task; its
  // `LogonTrigger` won't fire the process until the next interactive
  // logon, unlike launchd `bootstrap`/systemd `enable --now`, which both
  // start their job immediately. Explicitly start it too, so `install`
  // means the same thing ("running now, and persists across
  // reboots/logout") on every platform. A failed `/Run` doesn't undo the
  // successful registration — the task is still correctly installed and
  // will start at the next logon regardless — so this degrades to a
  // warning, not a failed install.
  const runResult = runSpawnSync(io, "schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
  if (runResult.status !== 0) {
    io.stderr.write(
      `installed — ${xmlPath}\n` +
        `note: could not start it immediately (${(runResult.stderr || runResult.error?.message || "unknown error").trim()}) — ` +
        "it will start at the next logon instead. Start it now with " +
        `'schtasks /Run /TN ${WINDOWS_TASK_NAME}'.\n`,
    );
  } else {
    io.stdout.write(`installed and started — ${xmlPath}\n`);
  }
  io.stdout.write(
    `check status: schtasks /Query /TN ${WINDOWS_TASK_NAME} /V\n` +
      "the paired session is valid for 24h — re-run 'mullion helper pair <payload>' at least " +
      "once a day for uninterrupted coverage.\n",
  );
  return 0;
}

export async function runInstall(args, io) {
  const platform = io.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    io.stderr.write(`mullion helper install isn't supported on '${platform}'.\n`);
    return 1;
  }
  const { flags } = extractFlags(args, { "ssh-auth-sock": "string" });
  const sshAuthSock = resolveSshAuthSock(flags, io, platform);
  const execPath = io.execPath ?? process.execPath;
  const scriptPath = io.scriptPath ?? defaultScriptPath();
  warnIfNotPaired(io);

  const opts = { execPath, scriptPath, sshAuthSock };
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

// Same "check the file first, then treat a genuine teardown failure as
// real, not swallowed" shape as uninstallLaunchd/uninstallSystemd above.
function uninstallWindows(io) {
  const xmlPath = windowsTaskXmlPath(io);
  if (!fs.existsSync(xmlPath)) {
    io.stdout.write("nothing installed.\n");
    return 0;
  }
  const result = runSpawnSync(io, "schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
  if (result.status !== 0) {
    io.stderr.write(
      `schtasks /Delete failed: ${(result.stderr || result.error?.message || "unknown error").trim()} — ` +
        "leaving the task file in place; 'mullion helper run' may still be active. Investigate with " +
        `'schtasks /Query /TN ${WINDOWS_TASK_NAME}' before retrying.\n`,
    );
    return 1;
  }
  fs.rmSync(xmlPath, { force: true });
  io.stdout.write(`removed ${xmlPath}\n`);
  return 0;
}

export async function runUninstall(_args, io) {
  const platform = io.platform ?? process.platform;
  if (platform === "darwin") return uninstallLaunchd(io);
  if (platform === "linux") return uninstallSystemd(io);
  if (platform === "win32") return uninstallWindows(io);
  io.stderr.write(`mullion helper uninstall isn't supported on '${platform}'.\n`);
  return 1;
}
