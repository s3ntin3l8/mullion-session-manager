// Issue #820 (PR6b) — `mullion helper install`/`uninstall`: generates and
// (de)registers a launchd job (macOS) or systemd --user unit (Linux) that
// supervises `mullion helper run`, so a laptop user doesn't have to
// hand-write one from docs/ssh-agent.md's manual-tunnel examples. Windows
// isn't supported yet (no way to test a Windows Scheduled Task generator
// from this Linux-only CI/dev environment) — `runInstall`/`runUninstall`
// return a clear, testable error there instead of shipping an unverified
// `schtasks.exe` invocation. Tracked separately; see docs/ssh-agent.md.
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
 * (man systemd.syntax): double-quote, backslash-escape embedded `"`/`\`. */
function systemdQuote(token) {
  if (!/[\s"\\]/.test(token)) return token;
  return `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** XML forbids a literal `--` inside a comment body (would break
 * launchctl's own plist parse, not just look ugly) — guards
 * EXPIRY_COMMENT_LINES below against ever reintroducing one, rather than
 * relying on prose discipline alone. */
export function xmlCommentSafe(value) {
  return value.replace(/--/g, "—");
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

function resolveSshAuthSock(flags, io) {
  const value = flags["ssh-auth-sock"] || io.env.SSH_AUTH_SOCK;
  if (!value) {
    throw new CliUsageError(
      "no SSH_AUTH_SOCK to install with — pass --ssh-auth-sock <path>, or run this from a " +
        "shell where $SSH_AUTH_SOCK is set. Note: the value is captured as a literal path in " +
        "the generated unit at install time, not re-read from the environment later.",
    );
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
  runSpawnSync(io, "launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  fs.writeFileSync(plistPath, buildLaunchdPlist({ execPath, scriptPath, sshAuthSock, logPath }));
  const result = runSpawnSync(io, "launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  if (result.status !== 0) {
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

export async function runInstall(args, io) {
  const platform = io.platform ?? process.platform;
  if (platform === "win32") {
    io.stderr.write(
      "mullion helper install isn't supported on Windows yet — run 'mullion helper run' " +
        "under a supervisor (e.g. a Scheduled Task) manually for now; see docs/ssh-agent.md.\n",
    );
    return 1;
  }
  if (platform !== "darwin" && platform !== "linux") {
    io.stderr.write(`mullion helper install isn't supported on '${platform}'.\n`);
    return 1;
  }
  const { flags } = extractFlags(args, { "ssh-auth-sock": "string" });
  const sshAuthSock = resolveSshAuthSock(flags, io);
  const execPath = io.execPath ?? process.execPath;
  const scriptPath = io.scriptPath ?? defaultScriptPath();
  warnIfNotPaired(io);

  const opts = { execPath, scriptPath, sshAuthSock };
  return platform === "darwin" ? installLaunchd(io, opts) : installSystemd(io, opts);
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

export async function runUninstall(_args, io) {
  const platform = io.platform ?? process.platform;
  if (platform === "darwin") return uninstallLaunchd(io);
  if (platform === "linux") return uninstallSystemd(io);
  io.stderr.write(`mullion helper uninstall isn't supported on '${platform}'.\n`);
  return 1;
}
