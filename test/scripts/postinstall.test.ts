// Issue #1069 — the macOS .pkg postinstall script had zero automated
// coverage before this. PR #1065 rewrote it substantially without adding
// any, so this is the first suite that exercises the real script end-to-end.
//
// Mirrors scripts/self-update.test.ts's "real bash + shimmed externals on
// PATH" pattern: the script itself is execFile'd with an isolated PATH that
// only has shimmed versions of launchctl/dscl/dscacheutil/getent/sudo plus
// the host's real stat/id/mktemp/awk, so every branch is testable in CI on
// Linux without a macOS runner. The macOS-specific bits (launchctl asuser,
// macOS-specific dscl syntax) are exactly the parts we WANT to mock away
// here — they're what the script invokes, not what it implements.
//
// Linux-only: macOS-only test target. The deploy/macos/scripts/postinstall
// script is itself macOS-specific (it's a .pkg postinstall), and its
// behavior under real launchctl/dscl/sudo is what the real test-macos job
// in .github/workflows/ci-cd.yml covers. This suite covers what CAN be
// covered off-Mac: ordering of the auto-detection branches, the
// sudo-needs-password skip path, the non-standard-home fallback, and the
// shell-level contract that the existing CI grep depends on
// ("mullion-helper: resolved console user" still appears when the
// console user IS resolvable).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const POSTINSTALL_SCRIPT = fileURLToPath(
  new URL("../../deploy/macos/scripts/postinstall", import.meta.url),
);

const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

function writeShim(binDir: string, name: string, script: string) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
  return p;
}

// Wire up an isolated PATH that has the supplied shims first, followed by
// symlinks to every other binary on the host's real PATH (id/stat/awk/mktemp
// run for real — only macOS-specific commands are shimmed).
function setupIsolatedPath(binDir: string, shims: Record<string, string>) {
  for (const [name, script] of Object.entries(shims)) {
    writeShim(binDir, name, script);
  }
  // Always provide a fake `mullion-helper` — even when the script doesn't
  // reach the install step, an early `EXE` check at the top of the script
  // requires the binary to exist at $MULLION_HELPER_BIN. This shim records
  // every invocation so tests can assert what argv the script ultimately
  // built.
  //
  // Uses $(dirname "$0") to locate the log file relative to the staged
  // binary's actual location — env vars don't survive the launchctl /
  // sudo -u hop in real sudo, and we'd like the test fixture to be as
  // close to the real command shape as possible.
  const argvLog = path.join(binDir, "captured-argv.log");
  writeShim(
    binDir,
    "mullion-helper",
    `#!/bin/bash
echo "FAKE_EXE_CALLED: $*" >> "$(dirname "$0")/captured-argv.log"
exit 0
`,
  );
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const target = path.join(dir, entry);
      const link = path.join(binDir, entry);
      if (fs.existsSync(link)) continue;
      try {
        fs.symlinkSync(target, link);
      } catch {
        // ignore — directories, permissions, etc.
      }
    }
  }
  return argvLog;
}

describeOnLinux("deploy/macos/scripts/postinstall", () => {
  let binDir: string;
  let fakeHome: string;
  let argvLog: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-shims-"));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "postinstall-home-"));
    // The script's $MULLION_HELPER_BIN override (set below) is also where the
    // fake binary lives — this matches what `/usr/local/bin/mullion-helper`
    // would look like on a real install.
  });

  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  async function runScript(
    shims: Record<string, string>,
    extraEnv: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    argvLog = setupIsolatedPath(binDir, shims);
    // The script's $MULLION_HELPER_BIN override (a test-only override, defaults
    // to /usr/local/bin/mullion-helper in production). We point it at a
    // staged copy of the fake binary so the script's own binary-existence
    // check at the top passes.
    const stagedExe = path.join(binDir, "mullion-helper-installed");
    fs.copyFileSync(path.join(binDir, "mullion-helper"), stagedExe);
    fs.chmodSync(stagedExe, 0o755);
    return new Promise((resolve) => {
      execFile(
        "bash",
        [POSTINSTALL_SCRIPT],
        {
          env: (() => {
            // Explicitly strip SSH_AUTH_SOCK (and a few other vars whose
            // accidental presence in the test runner's env would leak
            // through and break the CI-parity assumption that the
            // ambient-detection probe returns empty). The script's
            // ambient probe runs inside a `bash -c` invocation that's
            // NOT going through real sudo (test fixture), so it would
            // otherwise inherit this process's env — which on a developer
            // laptop almost always has SSH_AUTH_SOCK set.
            const env = { ...process.env };
            delete env.SSH_AUTH_SOCK;
            return {
              ...env,
              PATH: binDir,
              HOME: fakeHome,
              MULLION_HELPER_BIN: stagedExe,
              ...extraEnv,
            };
          })(),
        },
        (err, stdout, stderr) => {
          if (err) {
            // The process exited non-zero, or was killed by a signal.
            // Node populates `code` (number) on a clean exit; `signal`
            // (string) on a kill. Treat both as "the script exited" and
            // surface what we got.
            const e = err as NodeJS.ErrnoException & {
              code?: number | string;
              signal?: string;
            };
            const exitCode = typeof e.code === "number" ? e.code : e.signal ? null : null;
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        },
      );
      // execFile's promisified form silently throws away the exit code;
      // using the callback form preserves both `code` and `signal`.
    });
  }

  // The shim set used by every test below: every macOS-only command the
  // script invokes is shimmed, with a default behavior. Tests override the
  // individual shims they care about.
  const DEFAULT_SHIMS: Record<string, string> = {
    stat: `#!/bin/bash
# stat -f '%Su' /dev/console  →  console user
if [ "$1" = "-f" ] && [ "$2" = "%Su" ] && [ "$3" = "/dev/console" ]; then
  echo "ci-runner"
  exit 0
fi
exec /usr/bin/env stat "$@"
`,
    id: `#!/bin/bash
# id -u <user>
if [ "$1" = "-u" ]; then
  echo "501"
  exit 0
fi
exec /usr/bin/env id "$@"
`,
    dscl: `#!/bin/bash
# dscl . -read /Users/<user> NFSHomeDirectory  →  empty (test fallback path)
echo ""
exit 0
`,
    dscacheutil: `#!/bin/bash
# dscacheutil -q user -name <user>  →  empty (test fallback path)
echo ""
exit 0
`,
    getent: `#!/bin/bash
# getent passwd <user>  →  empty (test fallback path)
echo ""
exit 0
`,
    launchctl: `#!/bin/bash
# Default CI-parity launchctl: simulate an empty ambient SSH_AUTH_SOCK
# (the macOS-runner shell has no agent exporting one), and pass-through
# any other invocation (sudo -n probe, helper install) so the test can
# observe what argv the script ultimately built.
#
# launchctl asuser <uid> <command...> — strip "asuser <uid>" (the only
# subcommand the script uses; this fixture isn't load/print/budget-aware)
# and exec the trailing command. For the ambient-detection probe
# (trailing "bash -c '<echo>'"), print empty instead.
echo "LC_INVOKED $#" >> /tmp/postinstall-test-launchctl.log
if [ "$1" = "asuser" ]; then
  shift
  shift
fi
# Look at the last 3 args by copying positional params into a fresh
# array, then reading by index. (Bash array length / indexed access
# forms are written out fully below to keep the outer JS template
# literal from parsing the dollar-brace forms as JS expressions.)
#
# Detect "bash -c <script>" — argv[argc-3] is "bash" and argv[argc-2]
# is "-c". The last arg is the script string itself, which varies by
# test. Robust to different <user> names because we read by position.
arr_copy=("$@")
argc=\${#arr_copy[@]}
echo "LC_AFTER_STRIP argc=$argc" >> /tmp/postinstall-test-launchctl.log
if [ "$argc" -ge 3 ]; then
  last=\${arr_copy[$((argc - 1))]}
  prev=\${arr_copy[$((argc - 2))]}
  third_from_end=\${arr_copy[$((argc - 3))]}
  echo "LC_PEEK third=$third_from_end prev=$prev last=$last" >> /tmp/postinstall-test-launchctl.log
  if [ "$third_from_end" = "bash" ] && [ "$prev" = "-c" ]; then
    echo "LC_AMBIENT_DETECTED" >> /tmp/postinstall-test-launchctl.log
    printf "%s" ""
    exit 0
  fi
fi
echo "LC_PASSTHROUGH" >> /tmp/postinstall-test-launchctl.log
exec "$@"
`,
    sudo: `#!/bin/bash
# Default CI-parity sudo: passwordless AND runs the trailing command for
# real when one is given. The password-required test overrides this shim
# with one that fails sudo -n -u <user> true specifically.
#
# Heuristic: -n is the non-interactive probe, which always passes in CI
# parity mode (sudoers on a macos-latest runner never requires a password
# for an interactive GUI user; the script's own probe is exactly to catch
# the rare case where it DOES, but the test fixture assumes the common
# case).
#
# For everything else (the actual install invocation: sudo -u USER -H
# <real-exe> helper install ...), strip sudo's flags AND their arguments
# (-u takes a value, -H does not), then exec the trailing executable —
# otherwise the test sees "installed successfully" without the FAKE_EXE
# actually being invoked, and the captured-argv log stays empty.
if [ "$1" = "-n" ]; then
  exit 0
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n) shift ;;
    -u) shift 2 ;;  # -u <user>: drop both the flag and its argument
    -H | -i | -E | -s | -S) shift ;;
    -*) shift ;;  # any other flag we don't care about, drop it
    *) break ;;
  esac
done
exec "$@"
`,
  };

  it("falls back to the 1Password path when ambient SSH_AUTH_SOCK is unset (CI parity)", async () => {
    const result = await runScript(DEFAULT_SHIMS);
    expect(
      result.exitCode,
      `postinstall exit code\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    ).toBe(0);
    // CI grep target: this exact prefix MUST appear when console user is
    // resolvable (issue #1065 self-review note; restoring after round 1
    // had accidentally dropped it broke test-macos).
    expect(result.stdout).toContain("mullion-helper: resolved console user");
    // The 1Password default path was used (relative to /Users/<console_user>).
    expect(result.stdout).toContain(
      "/Users/ci-runner/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
    );
    // The fake helper was called exactly once with --ssh-auth-sock <path>.
    const argv = fs.readFileSync(argvLog, "utf8");
    expect(argv).toMatch(
      /FAKE_EXE_CALLED: helper install --ssh-auth-sock \/Users\/ci-runner\/Library\/Group Containers\/2BUA8C4S2C\.com\.1password\/t\/agent\.sock/,
    );
  });

  it("uses the ambient SSH_AUTH_SOCK when set, never the 1Password default", async () => {
    // The launchctl shim here simulates a user with an active agent:
    // the ambient-detection probe returns a real path, while the other
    // invocations (sudo -n probe, helper install) pass through to their
    // respective shims.
    const result = await runScript({
      ...DEFAULT_SHIMS,
      launchctl: `#!/bin/bash
# Simulate an ambient agent exporting SSH_AUTH_SOCK on the bash -c probe.
# Detect by argv[argc-3]="bash" and argv[argc-2]="-c". We pass through to
# sudo shim for the install/sudo -n calls.
echo "LC_AMB_INVOKED $#" >> /tmp/postinstall-test-launchctl.log
if [ "$1" = "asuser" ]; then shift; shift; fi
arr_copy=("$@")
argc=\${#arr_copy[@]}
if [ "$argc" -ge 3 ]; then
  last=\${arr_copy[$((argc - 1))]}
  prev=\${arr_copy[$((argc - 2))]}
  third_from_end=\${arr_copy[$((argc - 3))]}
  echo "LC_AMB_PEEK third=$third_from_end prev=$prev last=$last" >> /tmp/postinstall-test-launchctl.log
  if [ "$third_from_end" = "bash" ] && [ "$prev" = "-c" ]; then
    echo "LC_AMB_DETECTED" >> /tmp/postinstall-test-launchctl.log
    echo "/tmp/gpg-agent.sock"
    exit 0
  fi
fi
echo "LC_AMB_PASSTHROUGH" >> /tmp/postinstall-test-launchctl.log
exec "$@"`,
    });
    expect(
      result.exitCode,
      `postinstall exit code\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    ).toBe(0);
    // The ambient path won.
    expect(result.stdout).toContain("/tmp/gpg-agent.sock");
    // The 1Password default path is NOT in the success output.
    expect(result.stdout).not.toContain(
      "/Users/ci-runner/Library/Group Containers/2BUA8C4S2C.com.1password",
    );
    // The fake helper got the ambient path explicitly.
    expect(fs.readFileSync(argvLog, "utf8")).toMatch(
      /FAKE_EXE_CALLED: helper install --ssh-auth-sock \/tmp\/gpg-agent\.sock/,
    );
  });

  it("resolves a non-standard home directory via the dscacheutil/getent fallback chain", async () => {
    const result = await runScript({
      ...DEFAULT_SHIMS,
      stat: `#!/bin/bash
if [ "$1" = "-f" ] && [ "$2" = "%Su" ] && [ "$3" = "/dev/console" ]; then
  echo "aduser"
  exit 0
fi
exec /usr/bin/env stat "$@"`,
      id: `#!/bin/bash
if [ "$1" = "-u" ]; then
  echo "1234"
  exit 0
fi
exec /usr/bin/env id "$@"`,
      // dscl fails (LDAP/network home), dscacheutil succeeds with the
      // network home directory.
      dscacheutil: `#!/bin/bash
echo "dir: /network/home/aduser"
exit 0
`,
    });
    expect(
      result.exitCode,
      `postinstall exit code\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain(
      "/network/home/aduser/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
    );
    // And NOT the /Users/aduser default.
    expect(result.stdout).not.toContain("/Users/aduser/Library/Group Containers");
  });

  it("skips with a printed retry command when sudo -u would prompt for a password", async () => {
    const result = await runScript({
      ...DEFAULT_SHIMS,
      // sudo -n -u <user> true — exit non-zero to simulate a
      // password-required sudoers.
      sudo: `#!/bin/bash
if [ "$1" = "-n" ] && [ "$3" = "true" ]; then
  echo "sudo: a password is required" >&2
  exit 1
fi
exit 1
`,
    });
    // A clean skip (exit 0) is the success mode here — a hang is what the
    // change is supposed to prevent, per issue #1069.
    expect(
      result.exitCode,
      `postinstall exit code\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    ).toBe(0);
    // The user gets a clear message about WHY it skipped.
    expect(result.stdout).toMatch(/password|skip|cannot proceed/i);
    // And a manual retry command they can run themselves.
    expect(result.stdout).toContain("helper install --ssh-auth-sock");
    // The fake helper was NOT called — we never got past the sudo -n gate.
    const argv = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";
    expect(argv).toBe("");
  });

  // Regression guard for the load-bearing bash line-continuation + inline
  // comment bug that this whole test file was originally written to catch.
  //
  // The ambient-detection probe runs `launchctl asuser ... sudo -u ... -H
  // bash -c '<script>'` as a single `$(...)` substitution. If a future
  // maintainer "tidies" that one long line by inserting `\<newline># some
  // comment` after a backslash, bash treats the `# comment` as terminating
  // the line-continuation chain — leaving the trailing `bash -c '...'` as
  // a SEPARATE statement that hangs on empty stdin (a .pkg script stdin
  // is /dev/null). The "uses the ambient SSH_AUTH_SOCK when set" test
  // above catches this only as a side-effect of the probe returning empty;
  // a dedicated static check fails fast at the source level regardless of
  // how the shimmed launchctl happens to behave.
  //
  // What we assert:
  //   1. The full `$(launchctl asuser ...)` body lives on a single
  //      physical line in the source file (no line-continuation at all).
  //   2. A load-bearing comment near the assignment still warns about the
  //      trap, so the next maintainer sees it.
  it("keeps the launchctl asuser ambient probe on a single physical line", () => {
    const source = fs.readFileSync(POSTINSTALL_SCRIPT, "utf8");
    const lines = source.split("\n");

    // Find the assignment line — the ambient probe's marker is unique to
    // the script. The full body of the `$(...)` substitution must be on
    // THIS line and no other.
    const probeLineIdx = lines.findIndex((l) =>
      l.includes('SSH_AUTH_SOCK_AMBIENT="$(launchctl asuser'),
    );
    expect(
      probeLineIdx,
      `could not find a single-line SSH_AUTH_SOCK_AMBIENT assignment in ${POSTINSTALL_SCRIPT}`,
    ).toBeGreaterThanOrEqual(0);

    const probeLine = lines[probeLineIdx] ?? "";
    expect(
      probeLine,
      `SSH_AUTH_SOCK_AMBIENT must not end with a line-continuation backslash (would let a future comment silently terminate the chain). Offending line:\n${probeLine}`,
    ).not.toMatch(/\\\s*$/);

    // The `$(...)` substitution must not span multiple physical lines.
    // Count opening and closing parens on the line — for the actual
    // ambient probe there is exactly one of each.
    const opens = (probeLine.match(/\(/g) ?? []).length;
    const closes = (probeLine.match(/\)/g) ?? []).length;
    expect(
      { opens, closes, probeLine },
      "ambient probe `$(launchctl asuser ...)` must open and close on the same physical line",
    ).toEqual({ opens: 1, closes: 1, probeLine });

    // The load-bearing comment warning future maintainers must still be
    // present (a few lines above the assignment). The exact phrasing
    // doesn't matter — we look for the key terms that signal "don't
    // reformat this": "single physical line" (the load-bearing
    // invariant), and a pointer to the line-continuation / inline-comment
    // trap. Whitespace-normalize the joined comment so the check survives
    // cosmetic rewraps that put "single" and "physical line" on different
    // physical lines of the comment itself.
    const windowStart = Math.max(0, probeLineIdx - 20);
    const precedingComment = lines.slice(windowStart, probeLineIdx).join(" ").replace(/\s+/g, " ");
    expect(precedingComment).toMatch(/single.*physical line/i);
    expect(precedingComment).toMatch(/inline.*comment/i);
    expect(precedingComment).toMatch(/terminates.*line continuation/i);
  });
});
