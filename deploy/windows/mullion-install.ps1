# Mullion bootstrap for Windows: installs (or uninstalls) a Mullion AGENT host
# for the current user, with no administrator rights and nothing installed
# beforehand (issue #2160 follow-up, part of #1728).
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File mullion-install.ps1
#       [-InstallRoot C:\...\Mullion] [-PrimaryUrl https://...] [-AgentName name]
#       [-ProjectsRoots C:/src,D:/work] [-AdvertiseUrl http://...] [-Version 0.3.51]
#       [-TokenFromStdin] [-Json]
#   powershell.exe ... -File mullion-install.ps1 -Uninstall [-Purge] [-Force] [-Json]
#
# Or without saving it first (the usual PowerShell idiom; read it first):
#
#   & ([scriptblock]::Create((irm https://github.com/s3ntin3l8/mullion-session-manager/releases/latest/download/mullion-install.ps1))) -PrimaryUrl https://mullion.example
#
# This is NOT a second installer. It makes sure the two things Mullion needs on
# Windows exist -- Git Bash (sessions run in it) and Node 26 -- downloading
# pinned, checksummed, per-user copies into <InstallRoot>\runtime ONLY when a
# suitable one is not already installed, and then hands the whole install to
# the same deploy/install.sh every platform uses, via mullion-install.sh. The
# release's own installer stays the one place the layout, the .env and the
# scheduled task are defined.
#
# It is written to be driven by a program as well as by a person (the Mullion
# tray app's "Install Mullion" button, a provisioning script):
#
#   - no prompt, ever; every input is a parameter or an environment variable;
#   - the enrollment token is read from MULLION_AGENT_ENROLLMENT_TOKEN, or from
#     the first line of stdin with -TokenFromStdin -- NEVER a parameter, which
#     any process on the machine can read from the process list;
#   - with -Json, stdout is one JSON object per line, nothing else:
#       {"step":"<name>","status":"start|ok|skip|log|fail","detail":"...", ...}
#     steps, in order: platform, git-bash, node, fetch, install, done (an
#     uninstall has "uninstall" in place of the middle ones). The last line is
#     either {"step":"done","status":"ok",...install.json fields...} or a
#     "fail" line carrying "exitCode"; an unexpected error is a "fail" line
#     with step "unexpected";
#   - exit status: 0 success; 1 unexpected failure; 2 unsupported platform or
#     bad arguments; 3 a download or its checksum failed; 4 the release's
#     installer failed; 5 an uninstall was refused because sessions are still
#     running (re-run with -Force to end them);
#   - idempotent: a second run reuses what is there and re-runs the installer.
#
# The pinned versions and hashes below are refreshed by
# scripts/update-windows-prereqs.mjs. A download whose SHA-256 differs is
# deleted and the run fails; there is no "skip verification" switch.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the
# ANSI code page.
param(
  [ValidateSet('agent')][string]$Role = 'agent',
  [string]$InstallRoot,
  [string]$PrimaryUrl,
  [string]$ProjectsRoots,
  [string]$AgentName,
  [string]$AdvertiseUrl,
  [string]$Version,
  [string]$Repo = 's3ntin3l8/mullion-session-manager',
  [switch]$TokenFromStdin,
  [switch]$Json,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$Force,
  # Test and pre-publication seams. A release-shaped location (it holds
  # mullion-install.sh, the tarball and its .sha256); file:// works.
  [string]$ReleaseBaseUrl,
  [string]$NodeZipUrl,
  [string]$NodeZipSha256,
  [string]$GitUrl,
  [string]$GitSha256
)

# BEGIN PINS (refreshed by scripts/update-windows-prereqs.mjs)
$PinNodeVersion = '26.12.1'
$PinNodeUrl = 'https://nodejs.org/dist/v26.12.1/node-v26.12.1-win-x64.zip'
$PinNodeSha256 = 'b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4' # pragma: allowlist secret
$PinGitVersion = '2.56.0.4'
$PinGitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe'
$PinGitSha256 = 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1' # pragma: allowlist secret
# END PINS

$ErrorActionPreference = 'Stop'
$MinNodeMajor = 26

# Windows PowerShell 5.1 negotiates TLS 1.0/1.1 by default, which github.com
# and nodejs.org refuse.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# --- output ------------------------------------------------------------------

function Emit([string]$Step, [string]$Status, [string]$Detail = '', [hashtable]$Extra = @{}) {
  if ($Json) {
    $o = [ordered]@{ step = $Step; status = $Status; detail = $Detail }
    foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 4))
    return
  }
  switch ($Status) {
    'start' { [Console]::Out.WriteLine("==> ${Step}: $Detail") }
    'log' { [Console]::Out.WriteLine("    $Detail") }
    default { if ($Detail) { [Console]::Out.WriteLine("    [$Step $Status] $Detail") } }
  }
}

function Fail([int]$Code, [string]$Step, [string]$Message) {
  if ($Json) {
    Emit $Step 'fail' $Message @{ exitCode = $Code }
  } else {
    [Console]::Error.WriteLine("mullion-install: $Message")
  }
  exit $Code
}

# Every exit emits a final line under -Json: a terminating error anywhere below
# (a held directory, an unreadable install.json) ends up here.
trap {
  Fail 1 'unexpected' ($_.Exception.Message)
}

# --- helpers -----------------------------------------------------------------

function Get-FullPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  # A drive root keeps its separator: "C:" alone means "the current directory
  # on C:", and an uninstall would then enumerate and delete that.
  if ($full -ne [IO.Path]::GetPathRoot($full)) { $full = $full.TrimEnd('\') }
  return $full
}

# The version of a node.exe as a major number, or 0 if it cannot be asked.
function Get-NodeMajor([string]$Exe) {
  # Through System.Diagnostics.Process, not `& $Exe`: PowerShell 5.1 captures a
  # native command's output through the console handles it was started with,
  # and returns nothing at all when a host starts it with none (no console, or
  # a stdin that is not a pipe) -- which would read as "no Node here".
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = '--version'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    [void]$p.StandardError.ReadToEnd()
    if (-not $p.WaitForExit(20000)) { $p.Kill(); return 0 }
    if ($out -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

# Downloads $Url to $Dest and verifies its SHA-256 (fails closed). file:// works
# (WebClient), which is how the tests and a pre-publication run feed it.
function Get-Verified([string]$Url, [string]$Dest, [string]$Sha256, [string]$Step) {
  Emit $Step 'log' "downloading $Url"
  try {
    $wc = New-Object Net.WebClient
    $wc.DownloadFile($Url, $Dest)
  } catch {
    if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue }
    Fail 3 $Step "could not download ${Url}: $($_.Exception.Message)"
  }
  $actual = (Get-FileHash -LiteralPath $Dest -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256.ToLowerInvariant()) {
    Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
    Fail 3 $Step "checksum mismatch for $Url (expected $Sha256, got $actual); the download was deleted"
  }
}

function Test-ProcessesUnder([string]$Root, [string[]]$AlsoRoots = @()) {
  # Processes running from $Root -- a session's pty-host master, the updater,
  # the server. Detached masters survive a task stop, so the task being stopped
  # does not mean nothing is running. A process counts when its image or its
  # command line names a path INSIDE the root (root + a separator): a command
  # line that merely mentions the root itself -- this script's own, or its
  # caller's (-InstallRoot <root>) -- is not a process of the install. This
  # process and its ancestors are never counted.
  $prefixes = @()
  # $AlsoRoots: the root as the caller spelled it. GetFullPath expands 8.3 names
  # in Windows PowerShell 5.1, but a process started through a path that is only
  # partly short (C:\Users\RUNNER~1\...\Mullion home) reports that spelling,
  # which is neither the long nor the all-short form.
  foreach ($r in (@($Root) + $AlsoRoots)) {
    if (-not $r) { continue }
    $candidate = ($r.TrimEnd('\', '/').ToLowerInvariant().Replace('/', '\')) + '\'
    # Never a drive root or a bare drive ("c:\" would match every process on it).
    if ($candidate.Length -le 3) { continue }
    $prefixes += $candidate
  }
  # A process may have been started through the 8.3 short form of the path
  # (C:\Users\RUNNER~1\...) or the long one; WMI reports whichever it was given.
  try {
    $folder = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($Root)
    foreach ($form in @($folder.Path, $folder.ShortPath)) {
      $prefixes += ($form.TrimEnd('\', '/').ToLowerInvariant() + '\')
    }
  } catch { }
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $skip = @{}
  $cursor = $PID
  while ($cursor -and -not $skip.ContainsKey([int]$cursor)) {
    $skip[[int]$cursor] = $true
    $parent = $all | Where-Object { $_.ProcessId -eq $cursor } | Select-Object -First 1
    $cursor = if ($parent) { $parent.ParentProcessId } else { 0 }
  }
  $found = @()
  foreach ($p in $all) {
    if ($skip.ContainsKey([int]$p.ProcessId)) { continue }
    $hay = ((@($p.ExecutablePath, $p.CommandLine) | Where-Object { $_ }) -join ' ').ToLowerInvariant().Replace('/', '\')
    foreach ($prefix in $prefixes) {
      if ($hay.Contains($prefix)) { $found += $p; break }
    }
  }
  return $found
}

# --- platform ----------------------------------------------------------------

Emit 'platform' 'start' 'checking this machine'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  Fail 2 'platform' 'this script is for Windows; use deploy/mullion-install.sh elsewhere'
}
# The OS architecture, not the process's: a 32-bit PowerShell on 64-bit Windows
# reports x86. RuntimeInformation needs .NET 4.7.1 (Windows 10 1709); older
# systems fall back to the environment.
$arch = $null
try { $arch = [string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { }
if (-not $arch) {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
}
if ($arch -ne 'X64' -and $arch -ne 'AMD64') {
  Fail 2 'platform' "Windows on $arch is not supported yet (x64 only); see deploy/README.md"
}
if (-not $InstallRoot) {
  if (-not $env:LOCALAPPDATA) { Fail 2 'platform' 'LOCALAPPDATA is not set; pass -InstallRoot' }
  $InstallRoot = Join-Path $env:LOCALAPPDATA 'Mullion'
}
$InstallRootAsGiven = $InstallRoot
# A full path only: "C:" or a relative spelling would be resolved against a
# current directory (GetFullPath turns "C:" into wherever this process is).
if ($InstallRootAsGiven -notmatch '^([A-Za-z]:[\\/]|\\\\)') {
  Fail 2 'platform' "the install root must be a full path (C:\folder), not '$InstallRootAsGiven'"
}
$InstallRoot = Get-FullPath $InstallRoot
if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot)) {
  Fail 2 'platform' "the install root must be a folder, not the drive root $InstallRoot"
}
$RuntimeDir = Join-Path $InstallRoot 'runtime'
Emit 'platform' 'ok' "x64, install root $InstallRoot"

# --- uninstall ---------------------------------------------------------------

if ($Uninstall) {
  Emit 'uninstall' 'start' "removing Mullion from $InstallRoot"
  if (-not (Test-Path -LiteralPath $InstallRoot)) {
    Emit 'done' 'ok' 'nothing to uninstall'
    exit 0
  }
  $taskName = 'Mullion-agent'
  $info = Join-Path $InstallRoot 'install.json'
  if (Test-Path -LiteralPath $info) {
    try {
      $j = Get-Content -LiteralPath $info -Raw | ConvertFrom-Json
      if ($j.taskName -match '^[A-Za-z0-9._-]+$') { $taskName = $j.taskName }
    } catch { }
  }

  # Stop the supervisor first, so it cannot restart the server while the
  # sessions are being looked at. It is only unregistered once the uninstall is
  # going ahead: a refusal leaves the host as it was (the task is started again).
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }

  # Stopping the task ends the launcher and the server, but not instantly.
  $running = @(Test-ProcessesUnder $InstallRoot @($InstallRootAsGiven))
  for ($i = 0; $running.Count -gt 0 -and $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 500
    $running = @(Test-ProcessesUnder $InstallRoot @($InstallRootAsGiven))
  }
  if ($running.Count -gt 0 -and -not $Force) {
    if ($task) { Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
    Fail 5 'uninstall' ("$($running.Count) process(es) still run from $InstallRoot (sessions survive a stop by design). " +
      'End them from Mullion, or re-run with -Force to end them now.')
  }
  if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Emit 'uninstall' 'ok' "removed the scheduled task $taskName"
  }
  foreach ($p in $running) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($running.Count -gt 0) { Start-Sleep -Milliseconds 800 }

  # The `mullion` command-line wrapper, if it is ours.
  $wrapper = Join-Path $HOME 'bin\mullion'
  if (Test-Path -LiteralPath $wrapper) {
    $text = Get-Content -LiteralPath $wrapper -Raw -ErrorAction SilentlyContinue
    $posixRoot = ($InstallRoot -replace '\\', '/')
    if ($text -and $text.Contains('current/dist/cli/mullion.mjs') -and $text.ToLowerInvariant().Contains($posixRoot.ToLowerInvariant())) {
      Remove-Item -LiteralPath $wrapper -Force
      Emit 'uninstall' 'ok' "removed $wrapper"
    }
  }

  # The `current` junction is removed as a link first; recursing through it
  # would delete the release it points at while a recursive delete walked it.
  $current = Join-Path $InstallRoot 'current'
  if (Test-Path -LiteralPath $current) {
    try { [IO.Directory]::Delete($current) } catch { Fail 1 'uninstall' "could not remove the junction ${current}: $($_.Exception.Message)" }
  }

  # Everything Mullion wrote, except what a person may want back: the data
  # (sessions, database), the .env and the downloaded runtime. -Purge removes
  # those too.
  $keep = @('data', '.env', 'runtime')
  $leftovers = @()
  foreach ($item in (Get-ChildItem -LiteralPath $InstallRoot -Force)) {
    if (-not $Purge -and $keep -contains $item.Name) { $leftovers += $item.Name; continue }
    try { Remove-Item -LiteralPath $item.FullName -Recurse -Force } catch {
      $leftovers += $item.Name
      Emit 'uninstall' 'log' "could not remove $($item.FullName): $($_.Exception.Message)"
    }
  }
  if ($Purge -and (Test-Path -LiteralPath $InstallRoot) -and -not (Get-ChildItem -LiteralPath $InstallRoot -Force)) {
    Remove-Item -LiteralPath $InstallRoot -Force
  }
  $leftovers = @($leftovers | Sort-Object)
  $kept = if ($leftovers.Count -gt 0) { " kept: $($leftovers -join ', ')" } else { '' }
  Emit 'done' 'ok' ('uninstalled.' + $kept) @{ kept = $leftovers }
  exit 0
}

# --- git bash ----------------------------------------------------------------

Emit 'git-bash' 'start' 'looking for Git Bash'
$privateGit = Join-Path $RuntimeDir 'git'
$privateBash = Join-Path $privateGit 'bin\bash.exe'

# The same places src/services/session-shell.ts looks, plus our private copy.
function Find-GitBash {
  $candidates = @($env:CLAUDE_CODE_GIT_BASH_PATH, $privateBash)
  foreach ($root in @($env:ProgramFiles, $env:ProgramW6432, ${env:ProgramFiles(x86)})) {
    if ($root) { $candidates += (Join-Path $root 'Git\bin\bash.exe') }
  }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe') }
  $git = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($git) {
    $dir = Split-Path -Parent $git.Source
    $root = Split-Path -Parent $dir
    if ((Split-Path -Leaf $dir) -eq 'bin' -and (Split-Path -Leaf $root) -eq 'mingw64') { $root = Split-Path -Parent $root }
    $candidates += (Join-Path $root 'bin\bash.exe')
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c) -and ((Split-Path -Leaf $c) -match '^bash(\.exe)?$')) { return $c }
  }
  return $null
}

$bash = Find-GitBash
$bashIsPrivate = $false
if ($bash) {
  $bashIsPrivate = ($bash -ieq $privateBash)
  Emit 'git-bash' 'skip' "using $bash"
} else {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $url = if ($GitUrl) { $GitUrl } else { $PinGitUrl }
  $sha = if ($GitSha256) { $GitSha256 } else { $PinGitSha256 }
  $exe = Join-Path $RuntimeDir 'PortableGit.7z.exe'
  Get-Verified $url $exe $sha 'git-bash'
  Emit 'git-bash' 'log' "extracting Git for Windows $PinGitVersion (portable) into $privateGit"
  if (Test-Path -LiteralPath $privateGit) { Remove-Item -LiteralPath $privateGit -Recurse -Force }
  # The self-extractor is 7-Zip's: -o<dir> (no space) and -y to answer yes.
  $p = Start-Process -FilePath $exe -ArgumentList @("-o`"$privateGit`"", '-y') -Wait -PassThru -WindowStyle Hidden
  Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $privateBash)) {
    Fail 1 'git-bash' "extracting Git for Windows failed (exit $($p.ExitCode)); $privateBash was not created"
  }
  $bash = $privateBash
  $bashIsPrivate = $true
  Emit 'git-bash' 'ok' "installed $bash"
}

# --- node --------------------------------------------------------------------

Emit 'node' 'start' "looking for Node $MinNodeMajor or newer"
$privateNodeDir = Join-Path $RuntimeDir 'node'
$privateNode = Join-Path $privateNodeDir 'node.exe'
$nodeCandidates = @($privateNode)
$onPath = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($onPath) { $nodeCandidates += $onPath.Source }
foreach ($root in @($env:ProgramFiles, $env:ProgramW6432)) {
  if ($root) { $nodeCandidates += (Join-Path $root 'nodejs\node.exe') }
}
if ($env:LOCALAPPDATA) { $nodeCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
$node = $null
foreach ($c in $nodeCandidates) {
  if ($c -and (Test-Path -LiteralPath $c) -and ((Get-NodeMajor $c) -ge $MinNodeMajor)) { $node = $c; break }
}
if ($node) {
  Emit 'node' 'skip' "using $node"
} else {
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $url = if ($NodeZipUrl) { $NodeZipUrl } else { $PinNodeUrl }
  $sha = if ($NodeZipSha256) { $NodeZipSha256 } else { $PinNodeSha256 }
  $zip = Join-Path $RuntimeDir 'node.zip'
  Get-Verified $url $zip $sha 'node'
  Emit 'node' 'log' "extracting Node $PinNodeVersion into $privateNodeDir"
  $stage = Join-Path $RuntimeDir 'node-stage'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $stage)
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  # The archive holds one folder, node-vX-win-x64.
  $inner = Get-ChildItem -LiteralPath $stage -Directory | Select-Object -First 1
  if (-not $inner -or -not (Test-Path -LiteralPath (Join-Path $inner.FullName 'node.exe'))) {
    Fail 1 'node' 'the Node archive did not contain node.exe'
  }
  if (Test-Path -LiteralPath $privateNodeDir) { Remove-Item -LiteralPath $privateNodeDir -Recurse -Force }
  Move-Item -LiteralPath $inner.FullName -Destination $privateNodeDir
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  if ((Get-NodeMajor $privateNode) -lt $MinNodeMajor) {
    Fail 1 'node' "the downloaded Node does not report version $MinNodeMajor or newer"
  }
  $node = $privateNode
  Emit 'node' 'ok' "installed $node"
}

# --- fetch the release's bootstrap ---------------------------------------------

Emit 'fetch' 'start' 'fetching mullion-install.sh'
$tag = ''
if ($Version) { $tag = 'v' + $Version.TrimStart('v') }
if ($ReleaseBaseUrl) {
  $base = $ReleaseBaseUrl.TrimEnd('/')
} elseif ($tag) {
  $base = "https://github.com/$Repo/releases/download/$tag"
} else {
  $base = "https://github.com/$Repo/releases/latest/download"
}
$work = Join-Path ([IO.Path]::GetTempPath()) ('mullion-bootstrap-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$installSh = Join-Path $work 'mullion-install.sh'
try {
  $wc = New-Object Net.WebClient
  $wc.DownloadFile("$base/mullion-install.sh", $installSh)
} catch {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  Fail 3 'fetch' "could not download $base/mullion-install.sh: $($_.Exception.Message)"
}
Emit 'fetch' 'ok' "$base/mullion-install.sh"

# --- install -------------------------------------------------------------------

$token = $env:MULLION_AGENT_ENROLLMENT_TOKEN
if ($TokenFromStdin) { $token = [Console]::In.ReadLine() }

# The installer's environment is this process's: set here, inherited by the
# child. (ProcessStartInfo.EnvironmentVariables is avoided on purpose -- under
# Windows PowerShell 5.1 it has come back null in an unusual environment.)
function Set-ChildEnv([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

Emit 'install' 'start' "running the release installer in $bash"
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $bash
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.CreateNoWindow = $true
# The role, then the positional install root (mixed form: C:/..., which Git
# Bash accepts). No secret on this command line. The script runs under a bash that
# folds its stderr into its stdout, so one ordered stream is relayed line by
# line (a second pipe would need an event handler, and those arrive after the
# process has already been seen to exit).
$rootMixed = $InstallRoot -replace '\\', '/'
$shPath = $installSh -replace '\\', '/'
$psi.Arguments = "-l -c `"exec bash \`"`$0\`" \`"`$@\`" 2>&1`" `"$shPath`" --role agent `"$rootMixed`""

# Started from inside a Git Bash, this process inherited that shell's record of
# its own original PATH and TEMP; a login shell started below would rebuild its
# PATH from that stale record and lose the Windows entries (node, powershell).
foreach ($stale in @('ORIGINAL_PATH', 'ORIGINAL_TEMP', 'ORIGINAL_TMP')) { Set-ChildEnv $stale '' }

# The private Node first on PATH, so the installer (and the npm it runs) use it.
$nodeDir = Split-Path -Parent $node
Set-ChildEnv 'PATH' ($nodeDir + ';' + $env:PATH)
if ($tag) { Set-ChildEnv 'MULLION_INSTALL_TAG' $tag }
if ($ReleaseBaseUrl) { Set-ChildEnv 'MULLION_INSTALL_BASE_URL' $base }
if ($bashIsPrivate) { Set-ChildEnv 'MULLION_INSTALL_GIT_BASH' $bash }
if ($PrimaryUrl) { Set-ChildEnv 'MULLION_AGENT_PRIMARY_URL' $PrimaryUrl }
if ($ProjectsRoots) { Set-ChildEnv 'MULLION_AGENT_PROJECTS_ROOTS' $ProjectsRoots }
if ($AgentName) { Set-ChildEnv 'MULLION_AGENT_NAME' $AgentName }
if ($AdvertiseUrl) { Set-ChildEnv 'MULLION_AGENT_ADVERTISE_URL' $AdvertiseUrl }
if ($token) { Set-ChildEnv 'MULLION_AGENT_ENROLLMENT_TOKEN' $token }

$proc = New-Object Diagnostics.Process
$proc.StartInfo = $psi
try {
  [void]$proc.Start()
  while ($null -ne ($line = $proc.StandardOutput.ReadLine())) { Emit 'install' 'log' $line }
  $proc.WaitForExit()
  $installExit = $proc.ExitCode
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($installExit -ne 0) {
  Fail 4 'install' "the release installer exited with status $installExit"
}

$infoFile = Join-Path $InstallRoot 'install.json'
$extra = @{}
if (Test-Path -LiteralPath $infoFile) {
  # The install succeeded; an unreadable install.json must not turn that into a failure.
  try {
    $j = Get-Content -LiteralPath $infoFile -Raw | ConvertFrom-Json
    foreach ($prop in $j.PSObject.Properties) { $extra[$prop.Name] = $prop.Value }
  } catch { }
}
$extra['gitBash'] = $bash
Emit 'done' 'ok' "Mullion is installed in $InstallRoot" $extra
exit 0
