; Round 3 (PR3) — the Windows installer for the SSH-agent bridge helper
; (docs/ssh-agent.md). Wraps scripts/build-helper-sea.mjs's own
; mullion-helper.exe (built by CI BEFORE this compiles — see this file's own
; CI invocation in .github/workflows/ci-cd.yml's test-windows job and
; release-please.yml's build-helper-exe job) with the one piece a laptop
; user genuinely cannot get from a bare downloaded exe: registering the
; autostart entry and collecting the one-paste pairing payload, without
; ever opening a terminal.
;
; Per-user (PrivilegesRequired=lowest), deliberately NOT a per-machine/
; elevated install: src/cli/ssh-agent-helper-install.mjs's own
; installWindows registers a per-user autostart entry under
; HKCU\Software\Microsoft\Windows\CurrentVersion\Run (round 4, issue #871
; — see that file's own header comment for why: `schtasks /Create`
; unconditionally fails "Access is denied" for a real, non-elevated
; Administrator account, confirmed on real hardware) for the CURRENT
; interactive user, no privilege escalation. An elevated installer run as
; a different principal (a UAC-prompted admin account) would both
; register the autostart entry under the WRONG user and resolve
; {localappdata} to the ELEVATING user's profile, not the person who's
; actually going to run this — splitting the installed exe's location
; from src/cli/ssh-agent-helper.mjs's own stateDir() (also
; %LOCALAPPDATA%\Mullion, unconditionally, since PR2). Keeping the install
; non-elevated keeps both of those anchored to the same real user
; throughout.

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
; file deliberately share one folder, not two. DisableDirPage below is
; what actually ENFORCES that (self-review: without it, an interactive
; install can freely relocate {app} via the standard Select Destination
; page, and nothing here would notice the two locations had split) —
; there's no real reason an end user of this reference installer would
; want a different location anyway.
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
; ordering) — the autostart entry must be torn down (and the running
; process stopped) while mullion-helper.exe still exists on disk for
; `helper uninstall` to invoke reg.exe/taskkill against itself; the reverse
; order would delete the exe out from under a still-running process with
; nothing left to clean it up.
Filename: "{app}\mullion-helper.exe"; Parameters: "helper uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "MullionHelperUninstall"

[Code]
var
  PairingPage: TInputQueryWizardPage;
  InsecurePage: TNewCheckBox;

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
  //
  // `& "..."` below, not a bare quoted path — PowerShell (Windows 11's
  // default terminal) puts a leading quoted string in expression mode and
  // refuses to run it as a command; only Command Prompt accepts a bare
  // quoted path directly. `&` is the PowerShell call operator and works
  // identically in Command Prompt too (it's just a no-op token there), so
  // this one form is correct in both shells rather than needing to name
  // which one to use.
  PairingPage := CreateInputQueryPage(wpSelectDir,
    'Pair with Mullion',
    'Connect this laptop to your Mullion primary',
    'Paste the pairing payload from Settings -> Hosts -> SSH agent bridges ' +
    'on your Mullion primary. It is valid for 10 minutes.' + #13#10 + #13#10 +
    'You can leave this blank and pair later by running:' + #13#10 +
    '& "%LOCALAPPDATA%\Mullion\mullion-helper.exe" helper pair <payload>');
  PairingPage.Add('Pairing payload:', False);

  // Issue #1147 — --insecure lets the helper talk to a Mullion primary over
  // plain HTTP instead of requiring a valid TLS certificate. For development
  // servers or self-signed setups. Parented to PairingPage's surface (not
  // WizardForm.InnerPage, which is the common parent of ALL pages and would
  // make the checkbox appear on every wizard page).
  InsecurePage := TNewCheckBox.Create(WizardForm);
  InsecurePage.Parent := PairingPage.Surface;
  InsecurePage.Left := ScaleX(16);
  InsecurePage.Top := PairingPage.SurfaceHeight - ScaleY(24);
  InsecurePage.Width := PairingPage.SurfaceWidth - ScaleX(32);
  InsecurePage.Caption := '&Allow insecure (HTTP) connection to primary';
  InsecurePage.Checked := False;
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
// message. MAX_PAIRING_PAYLOAD_LEN guards against a pathological paste (a
// whole file dropped into the box by mistake) reaching Exec at all — a real
// payload (base64url of {baseUrl, code} JSON) is nowhere close to this;
// Windows' own CreateProcess command-line limit is ~32767 characters, so
// this is a generous ceiling, not a realistic one (Hermes review, PR #905).
const
  MAX_PAIRING_PAYLOAD_LEN = 4096;

function IsValidPairingPayload(const S: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := (S <> '') and (Length(S) <= MAX_PAIRING_PAYLOAD_LEN);
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

// Round 4 (issue #871, Hermes review round on the original silent-failure
// bug) — every ExecAndCaptureOutput call below appends here, regardless of
// success or failure, so a scripted install is diagnosable without
// needing to reproduce the failure interactively. Per-user (under {app},
// = stateDir() on Windows), not {tmp}, so it outlives the run the same way
// the credential file does.
//
// Deliberately takes a fixed VERB LITERAL ("pair"/"install" — never the
// actual argv passed to Exec) and the captured OUTPUT STREAMS only, never
// the command line itself: for `helper pair`, that command line contains
// the pairing payload, a live single-use bearer credential
// (ssh-agent-helper.mjs's own saveCredential comment calls the persisted
// form of this exact value a "signing-oracle bearer token"). This log file
// gets default ACLs, sitting in the same folder as the 0600-permissioned
// credential file that value becomes — logging the invocation would leak
// it. The captured stdout/stderr streams are safe to log verbatim: neither
// `helper pair` nor `helper install`'s own error paths ever echo the
// payload back (confirmed by reading ssh-agent-helper.mjs and
// ssh-agent-bridge-pairing.mjs before relying on that here — a
// CliUsageError says only "paste it exactly as shown", and a handshake
// failure names just the target URL).
procedure AppendDiagnostics(const Verb: String; ResultCode: Integer; Output: TExecOutput);
var
  LogPath, Text: String;
  I: Integer;
begin
  LogPath := ExpandConstant('{app}\install-diagnostics.log');
  Text := GetDateTimeString('yyyy/mm/dd hh:nn:ss', #0, #0) +
    '  helper ' + Verb + '  exit=' + IntToStr(ResultCode) + #13#10;
  for I := 0 to GetArrayLength(Output.StdOut) - 1 do
    Text := Text + '    stdout: ' + Output.StdOut[I] + #13#10;
  for I := 0 to GetArrayLength(Output.StdErr) - 1 do
    Text := Text + '    stderr: ' + Output.StdErr[I] + #13#10;
  SaveStringToFile(LogPath, Text, True);
end;

// Joins captured stderr lines for embedding directly in a failure dialog —
// "exit code 1" alone, with nothing pointing at the real reason, is what
// made the original bug this responds to unreproducible from a bug report
// alone.
function JoinStdErr(Output: TExecOutput): String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to GetArrayLength(Output.StdErr) - 1 do
  begin
    if I > 0 then Result := Result + #13#10;
    Result := Result + Output.StdErr[I];
  end;
end;

function FormatReason(const StdErrText: String): String;
begin
  if StdErrText <> '' then
    Result := 'Reason: ' + StdErrText + #13#10 + #13#10
  else
    Result := '';
end;

// Pairs BEFORE installing/starting the autostart entry, not after:
// installWindows() (ssh-agent-helper-install.mjs) ends its own `install`
// verb by starting the helper immediately, detached — not just
// registering it. Installing first would mean the very first `mullion
// helper run` launch finds no credential yet and exits 1, sitting idle
// until the next logon (or a manual restart) before a later pairing would
// even be picked up — a real, avoidable dead period for anyone who filled
// in the payload. Pairing first means install's own immediate start
// launches into an already-paired helper on the first try.
//
// Both mullion-helper.exe calls below are otherwise fire-and-forget from
// the installer's own perspective: a failure at either step still leaves a
// USABLE install (the exe is on disk either way) — never worth rolling
// back or failing the whole setup over, matching installWindows()'s own
// posture ("a failed immediate start degrades to a warning, not a failed
// install"). Each failure mode gets its own clear message with the exact
// retry command, the real reason from stderr, and a pointer to the full
// diagnostics log instead.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ExePath, CredentialPath, Payload, StdErrText: String;
  Paired, HadCredentialBefore: Boolean;
  Output: TExecOutput;
begin
  if CurStep = ssPostInstall then
  begin
    ExePath := ExpandConstant('{app}\mullion-helper.exe');
    CredentialPath := ExpandConstant('{app}\ssh-agent-bridge.json');
    Paired := False;

    Payload := Trim(PairingPage.Values[0]);
    if (Payload = '') and FileExists(CredentialPath) then
      // Re-running the installer (an upgrade, or a repair) over an
      // already-paired laptop, with the pairing field deliberately left
      // blank — the expected shape for that case, since the user has no
      // new payload to give. Without this check, the branch below would
      // tell them to pair anyway; following that instruction would
      // register a SECOND bridge session on the primary while the
      // original stays live and unrevoked, and the "installed and
      // paired" success message further down would never fire for a run
      // that in fact left this laptop correctly paired throughout.
      Paired := True
    else if Payload = '' then
    begin
      if InsecurePage.Checked then
        ShowMsg(
          'Mullion Helper will be installed but not yet paired.' + #13#10 + #13#10 +
          'When you are ready, generate a payload from Settings -> Hosts -> SSH agent bridges on your Mullion primary, then run:' + #13#10 + #13#10 +
          '& "' + ExePath + '" helper pair <payload> --insecure',
          mbInformation)
      else
        ShowMsg(
          'Mullion Helper will be installed but not yet paired.' + #13#10 + #13#10 +
          'When you are ready, generate a payload from Settings -> Hosts -> SSH agent bridges on your Mullion primary, then run:' + #13#10 + #13#10 +
          '& "' + ExePath + '" helper pair <payload>',
          mbInformation);
    end
    else if not IsValidPairingPayload(Payload) then
    begin
      if InsecurePage.Checked then
        ShowMsg(
          'That doesn''t look like a real pairing payload (it should be a single unbroken block of letters, digits, "-", and "_", nothing else) — skipping pairing rather than risk sending something wrong. Copy it fresh from Settings -> Hosts -> SSH agent bridges and run:' + #13#10 + #13#10 +
          '& "' + ExePath + '" helper pair <payload> --insecure',
          mbError)
      else
        ShowMsg(
          'That doesn''t look like a real pairing payload (it should be a single unbroken block of letters, digits, "-", and "_", nothing else) — skipping pairing rather than risk sending something wrong. Copy it fresh from Settings -> Hosts -> SSH agent bridges and run:' + #13#10 + #13#10 +
          '& "' + ExePath + '" helper pair <payload>',
          mbError);
    end
    else
    begin
      // Captured BEFORE this attempt runs, not just checked after — see
      // the fallback branch below for why the distinction matters on a
      // reinstall over an ALREADY-paired laptop.
      HadCredentialBefore := FileExists(CredentialPath);
      if InsecurePage.Checked then
        ExecAndCaptureOutput(ExePath, 'helper pair "' + Payload + '" --insecure', '', SW_HIDE, ewWaitUntilTerminated, ResultCode, Output)
      else
        ExecAndCaptureOutput(ExePath, 'helper pair "' + Payload + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode, Output);
      AppendDiagnostics('pair', ResultCode, Output);
      if ResultCode = 0 then
        Paired := True
      // runPair (ssh-agent-helper.mjs) persists the credential BEFORE its
      // own final stdout write — a failure in that last write alone still
      // reports this same non-zero exit code even though pairing genuinely
      // succeeded. Trust the credential file over the exit code rather
      // than sending someone to re-pair a bridge that's already paired.
      //
      // Gated on `not HadCredentialBefore` (self-review, mullion-reviewer
      // round): without it, this would also fire on a reinstall over a
      // laptop that was ALREADY paired from a genuinely earlier, unrelated
      // install — the stale credential file predates THIS attempt and
      // proves nothing about whether it succeeded, so a truly failed
      // reinstall (an expired or already-used fresh payload) would be
      // misreported as "installed and paired," hiding the real failure.
      // Narrowed to exactly the race the comment above describes: a
      // credential that did not exist before this attempt and does now.
      else if (not HadCredentialBefore) and FileExists(CredentialPath) then
        Paired := True
      else
      begin
        // Hermes review — the 1/2 split below is an implicit contract with
        // ssh-agent-helper.mjs's own runHelper, not derived from anything
        // this file can check itself: `decodePairingPayload` failing (a
        // payload that passed THIS file's own looser IsValidPairingPayload
        // regex but doesn't decode to well-formed JSON) throws
        // CliUsageError, which runHelper's catch maps to exit 2; every
        // OTHER failure inside runPair (HandshakeRejectedError for an
        // expired/already-used/rejected code, a connect timeout, a
        // malformed handshake reply, a saveCredential write failure) is a
        // plain Error, mapped to exit 1. If runHelper's own exit-code
        // mapping ever changes, this dialog's text goes stale silently —
        // AppendDiagnostics's own captured stderr (surfaced right below)
        // is the real safety net if that ever happens, not this sentence.
        StdErrText := JoinStdErr(Output);
        if InsecurePage.Checked then
          ShowMsg(
            'Pairing did not succeed (exit code ' + IntToStr(ResultCode) + ').' + #13#10 + #13#10 +
            'Exit code 2 means the payload itself was invalid. Exit code 1 means it was valid but the primary rejected it — it may have expired (valid for 10 minutes) or already been used — or could not be reached.' + #13#10 + #13#10 +
            FormatReason(StdErrText) +
            'Generate a fresh payload from Settings -> Hosts -> SSH agent bridges on your Mullion primary, then run:' + #13#10 + #13#10 +
            '& "' + ExePath + '" helper pair <payload> --insecure' + #13#10 + #13#10 +
            'Full diagnostics: ' + ExpandConstant('{app}\install-diagnostics.log'),
            mbError)
        else
          ShowMsg(
            'Pairing did not succeed (exit code ' + IntToStr(ResultCode) + ').' + #13#10 + #13#10 +
            'Exit code 2 means the payload itself was invalid. Exit code 1 means it was valid but the primary rejected it — it may have expired (valid for 10 minutes) or already been used — or could not be reached.' + #13#10 + #13#10 +
            FormatReason(StdErrText) +
            'Generate a fresh payload from Settings -> Hosts -> SSH agent bridges on your Mullion primary, then run:' + #13#10 + #13#10 +
            '& "' + ExePath + '" helper pair <payload>' + #13#10 + #13#10 +
            'Full diagnostics: ' + ExpandConstant('{app}\install-diagnostics.log'),
            mbError);
      end;
    end;

    // No --ssh-auth-sock passed — resolveSshAuthSock (ssh-agent-helper-
    // install.mjs) already defaults to \\.\pipe\openssh-ssh-agent on win32
    // (issue #874's empirically-confirmed default, round 3 PR2), so there
    // is nothing installer-specific to override here. Runs regardless of
    // whether pairing above succeeded — install/register/start is still
    // the right outcome even for an unpaired helper (it'll just sit
    // waiting, same as running `mullion helper install` by hand always
    // has).
    if InsecurePage.Checked then
      ExecAndCaptureOutput(ExePath, 'helper install --insecure', '', SW_HIDE, ewWaitUntilTerminated, ResultCode, Output)
    else
      ExecAndCaptureOutput(ExePath, 'helper install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode, Output);
    AppendDiagnostics('install', ResultCode, Output);
    if ResultCode <> 0 then
    begin
      StdErrText := JoinStdErr(Output);
      if InsecurePage.Checked then
        ShowMsg(
          'mullion-helper.exe helper install did not finish cleanly (exit code ' + IntToStr(ResultCode) + ').' + #13#10 + #13#10 +
          FormatReason(StdErrText) +
          'The helper is still installed at ' + ExePath + ' — you can retry the autostart registration yourself by running:' + #13#10 + #13#10 +
          '& "' + ExePath + '" helper install --insecure' + #13#10 + #13#10 +
          'Full diagnostics: ' + ExpandConstant('{app}\install-diagnostics.log'),
          mbError)
      else
        ShowMsg(
          'mullion-helper.exe helper install did not finish cleanly (exit code ' + IntToStr(ResultCode) + ').' + #13#10 + #13#10 +
          FormatReason(StdErrText) +
          'The helper is still installed at ' + ExePath + ' — you can retry the autostart registration yourself by running:' + #13#10 + #13#10 +
          '& "' + ExePath + '" helper install' + #13#10 + #13#10 +
          'Full diagnostics: ' + ExpandConstant('{app}\install-diagnostics.log'),
          mbError);
    end
    else if Paired then
      // "installed and paired", not "...and running": helper install's own
      // immediate start is best-effort (installWindows treats a failed
      // start as a non-fatal warning, not an install failure), so this
      // exit code 0 doesn't guarantee the helper actually started —
      // Hermes review, PR #905, on the mechanism this carries forward.
      ShowMsg('Mullion Helper is installed and paired.', mbInformation);
  end;
end;
