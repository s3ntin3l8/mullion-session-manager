; Round 3 (PR3) — the Windows installer for the SSH-agent bridge helper
; (docs/ssh-agent.md). Wraps scripts/build-helper-sea.mjs's own
; mullion-helper.exe (built by CI BEFORE this compiles — see this file's own
; CI invocation in .github/workflows/ci-cd.yml's test-windows job and
; release-please.yml's build-helper-exe job) with the one piece a laptop
; user genuinely cannot get from a bare downloaded exe: registering the
; Windows Scheduled Task and collecting the one-paste pairing payload,
; without ever opening a terminal.
;
; Per-user (PrivilegesRequired=lowest), deliberately NOT a per-machine/
; elevated install: src/cli/ssh-agent-helper-install.mjs's own
; buildWindowsTaskXml already registers the Scheduled Task against
; InteractiveToken/LeastPrivilege (the CURRENT interactive user, no
; privilege escalation) — an elevated installer run as a different
; principal (a UAC-prompted admin account) would both register the task
; under the WRONG user and resolve {localappdata} to the ELEVATING user's
; profile, not the person who's actually going to run this — splitting the
; installed exe's location from src/cli/ssh-agent-helper.mjs's own
; stateDir() (also %LOCALAPPDATA%\Mullion, unconditionally, since PR2).
; Keeping the install non-elevated keeps both of those anchored to the
; same real user throughout.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif

[Setup]
; Fixed, never regenerate — Windows uses this (not AppName) to recognize
; "this is the same product" across versions for upgrade/uninstall.
AppId={{4BBA489A-6B68-4E95-8F1A-9BBAC8E83225}
AppName=Mullion Helper
AppVersion={#AppVersion}
AppPublisher=s3ntin3l8
AppPublisherURL=https://github.com/s3ntin3l8/mullion-session-manager
AppSupportURL=https://github.com/s3ntin3l8/mullion-session-manager/issues
; {localappdata}, never {pf}/{commonpf} — see the header comment above.
; This is also EXACTLY src/cli/ssh-agent-helper.mjs's own stateDir() win32
; resolution (%LOCALAPPDATA%\Mullion) — the exe and its own credential
; file/task XML deliberately share one folder, not two. DisableDirPage
; below is what actually ENFORCES that (self-review: without it, an
; interactive install can freely relocate {app} via the standard Select
; Destination page, and nothing here would notice the two locations had
; split) — there's no real reason an end user of this reference installer
; would want a different location anyway.
DefaultDirName={localappdata}\Mullion
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\build\installer
OutputBaseFilename=mullion-helper-setup-{#AppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\mullion-helper.exe
; Unsigned — a known, stated limitation (docs/ssh-agent.md), not an
; oversight. SmartScreen will warn on first run; a code-signing certificate
; is Phase 4 (the separate mullion-helper tray repo) work, tracked
; separately, not something to silently work around here.

[Files]
Source: "..\..\build\helper-sea\mullion-helper.exe"; DestDir: "{app}"; Flags: ignoreversion

[UninstallRun]
; Runs at usUninstall, BEFORE [Files] removal (Inno Setup's own documented
; ordering) — the Scheduled Task must be torn down while mullion-helper.exe
; still exists on disk for `helper uninstall` to invoke schtasks against
; itself; the reverse order would delete the exe out from under a still-
; registered task with nothing left to clean it up.
Filename: "{app}\mullion-helper.exe"; Parameters: "helper uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "MullionHelperUninstall"

[Code]
var
  PairingPage: TInputQueryWizardPage;

// Always logged (Log() is a harmless no-op unless /LOG was passed — this is
// what makes a scripted `/VERYSILENT /LOG=...` CI run diagnosable without
// needing a screenshot), but only shown as a dialog for an interactive
// install: `/VERYSILENT`'s own `/SUPPRESSMSGBOXES` flag auto-answers a
// MsgBox with its default button rather than truly suppressing it, which
// would otherwise still cost a real (if brief) blocking wait — WizardSilent()
// skips that outright, and matters more for a genuinely unattended
// enterprise-provisioning install than for CI: nothing should ever pop up
// asking a deployment script to click OK.
procedure ShowMsg(const Msg: String; MsgType: TMsgBoxType);
begin
  Log(Msg);
  if not WizardSilent() then
    MsgBox(Msg, MsgType, MB_OK);
end;

procedure InitializeWizard;
begin
  // Placed right after the install-directory page, before files are even
  // copied — asking up front means the 10-minute pairing-code TTL
  // (bridge-registry.ts's PAIRING_CODE_TTL_MS) only has to survive the
  // (fast) file-copy step, not any time the user might spend reading the
  // rest of the wizard.
  PairingPage := CreateInputQueryPage(wpSelectDir,
    'Pair with Mullion',
    'Connect this laptop to your Mullion primary',
    'Paste the pairing payload from Settings -> Hosts -> SSH agent bridges ' +
    'on your Mullion primary. It is valid for 10 minutes.' + #13#10 + #13#10 +
    'You can leave this blank and pair later by running:' + #13#10 +
    '"%LOCALAPPDATA%\Mullion\mullion-helper.exe" helper pair <payload>');
  PairingPage.Add('Pairing payload:', False);
end;

// encodePairingPayload's (src/services/bridge-registry.ts) own output
// alphabet is base64url (RFC 4648 sec. 5): [A-Za-z0-9_-], no padding. This
// field is a GUI text box a human pastes into, not a value this code
// generated itself, so — unlike a value this codebase already controls
// end-to-end — it's worth validating BEFORE it's wrapped in quotes and
// handed to Exec (which calls CreateProcess directly, not cmd.exe, so
// there's no shell-injection risk here, only the CommandLineToArgvW quote-
// splitting hazard windowsArgEscape() in ssh-agent-helper-install.mjs
// exists to guard against elsewhere in this same PR series): a stray
// pasted quote character would otherwise silently split into extra argv
// tokens `helper pair` never expects, rather than failing with a clear
// message.
function IsValidPairingPayload(const S: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := S <> '';
  if not Result then Exit;
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if not (((C >= 'A') and (C <= 'Z')) or ((C >= 'a') and (C <= 'z')) or
            ((C >= '0') and (C <= '9')) or (C = '-') or (C = '_')) then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

// Pairs BEFORE installing/starting the Scheduled Task, not after:
// installWindows() (ssh-agent-helper-install.mjs) ends its own `install`
// verb by running `schtasks /Run` — the task starts immediately, not just
// registers. Installing first would mean the very first `mullion helper
// run` launch finds no credential yet, exits 1, and sits in
// RestartOnFailure's PT1M interval (buildWindowsTaskXml) before the retry
// picks up the credential this same wizard page just collected — a real,
// avoidable ~1-minute dead period for anyone who filled in the payload.
// Pairing first means install's own /Run launches into an
// already-paired helper on the first try.
//
// Both mullion-helper.exe calls below are otherwise fire-and-forget from
// the installer's own perspective: a failure at either step still leaves a
// USABLE install (the exe is on disk either way) — never worth rolling
// back or failing the whole setup over, matching installWindows()'s own
// posture ("a failed /Run degrades to a warning, not a failed install").
// Each failure mode gets its own clear message with the exact retry
// command instead.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ExePath: String;
  Payload: String;
  Paired: Boolean;
begin
  if CurStep = ssPostInstall then
  begin
    ExePath := ExpandConstant('{app}\mullion-helper.exe');
    Paired := False;

    Payload := Trim(PairingPage.Values[0]);
    if Payload = '' then
    begin
      ShowMsg(
        'Mullion Helper will be installed but not yet paired.' + #13#10 + #13#10 +
        'When you are ready, generate a payload from Settings -> Hosts -> SSH agent bridges on your Mullion primary, then run:' + #13#10 + #13#10 +
        '"' + ExePath + '" helper pair <payload>',
        mbInformation);
    end
    else if not IsValidPairingPayload(Payload) then
    begin
      ShowMsg(
        'That doesn''t look like a real pairing payload (it should be a single unbroken block of letters, digits, "-", and "_", nothing else) — skipping pairing rather than risk sending something wrong. Copy it fresh from Settings -> Hosts -> SSH agent bridges and run:' + #13#10 + #13#10 +
        '"' + ExePath + '" helper pair <payload>',
        mbError);
    end
    else if not (Exec(ExePath, 'helper pair "' + Payload + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0)) then
    begin
      ShowMsg(
        'Pairing did not succeed (exit code ' + IntToStr(ResultCode) + ') — the payload may have expired (it is only valid for 10 minutes) or been mistyped.' + #13#10 + #13#10 +
        'Generate a fresh payload from Settings -> Hosts -> SSH agent bridges on your Mullion primary, then run:' + #13#10 + #13#10 +
        '"' + ExePath + '" helper pair <payload>',
        mbError);
    end
    else
      Paired := True;

    // No --ssh-auth-sock passed — resolveSshAuthSock (ssh-agent-helper-
    // install.mjs) already defaults to \\.\pipe\openssh-ssh-agent on win32
    // (issue #874's empirically-confirmed default, round 3 PR2), so there
    // is nothing installer-specific to override here. Runs regardless of
    // whether pairing above succeeded — install/register/start is still
    // the right outcome even for an unpaired helper (it'll just sit
    // waiting, same as running `mullion helper install` by hand always
    // has).
    if not (Exec(ExePath, 'helper install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0)) then
    begin
      ShowMsg(
        'mullion-helper.exe helper install did not finish cleanly (exit code ' + IntToStr(ResultCode) + ').' + #13#10 + #13#10 +
        'The helper is still installed at ' + ExePath + ' — you can retry the Scheduled Task registration yourself by running:' + #13#10 + #13#10 +
        '"' + ExePath + '" helper install',
        mbError);
    end
    else if Paired then
      ShowMsg('Mullion Helper is installed, paired, and running.', mbInformation);
  end;
end;
