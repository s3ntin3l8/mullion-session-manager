# Registers (or removes) Mullion's per-user scheduled task on Windows -- the
# Windows counterpart of installing a systemd --user unit or a launchd agent
# (issue #2160, part of #1728). Run by deploy/install.sh; it can be run by
# hand too.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File register-task.ps1
#       -TaskName Mullion-agent -NodePath C:\...\node.exe
#       -LauncherPath C:\...\current\scripts\windows-launcher.mjs
#       -MullionHome C:\...\Mullion [-Start] [-NoBrand]
#   powershell.exe ... -File register-task.ps1 -TaskName Mullion-agent -Remove
#
# Why a per-user task and not a Windows service: the agent CLIs, their logins,
# git credentials and Git Bash are per user, so the agent has to run as the
# user, in the user's session -- which also keeps the named pipes' access list
# (current user + SYSTEM) correct as it is. It starts when the user logs on and
# needs no elevation: it uses the ScheduledTasks cmdlets for the user's own
# task, not `schtasks /Create`, which a non-elevated Administrators-group
# account is refused (#871). (An opt-in service for headless hosts is a
# separate issue.)
#
# The task runs scripts/windows-launcher.mjs, which supervises the server: Task
# Scheduler's own restart-on-failure has a one-minute floor.
#
# It does not run node.exe itself but <MullionHome>\runtime\mullion-agent.exe, a
# copy of that Node made here (-NoBrand keeps the plain node.exe):
#   - its PE header says "Windows GUI" instead of "console", so Task Scheduler
#     opens no console window (a console node.exe gets a visible one, and
#     closing it stops the agent);
#   - when runtime\rcedit.exe is there (the bootstrap downloads it, pinned and
#     checksummed) its version info and icon say Mullion, so the Windows
#     Firewall prompt and Task Manager show "Mullion agent" and not "Node.js
#     JavaScript Runtime".
# A failure at any step leaves the plain node.exe in use; the agent still runs.
# mullion-agent.exe.json next to the copy records what it was made from, so the
# copy is only rebuilt when the Node changes, and so a caller that passes the
# copy back as -NodePath (the updater passes process.execPath) gets the original.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the
# ANSI code page. Exit status: 0 on success, 1 (with the reason on stderr) on
# any failure.
param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [string]$NodePath,
  [string]$LauncherPath,
  [string]$MullionHome,
  [switch]$Start,
  [switch]$Remove,
  [switch]$NoBrand,
  [string]$RceditPath,
  [string]$IconPath
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  [Console]::Error.WriteLine("register-task: $message")
  exit 1
}

# The name ends up in a command line (the launcher's third argument) and in
# MULLION_SERVICE_UNIT, so it is held to a plain set of characters.
if ($TaskName -notmatch '^[A-Za-z0-9._-]+$') {
  Fail "the task name '$TaskName' may only contain letters, digits, '.', '_' and '-'"
}

# Bumped when what the copy is made of changes, so existing copies are rebuilt.
$BrandVersion = 1

# The Node version a program reports, or '' if it cannot be asked. Through
# System.Diagnostics.Process, not `& $exe`: Windows PowerShell 5.1 returns
# nothing for a native command when the host gave it no console.
function Get-ProgramVersion([string]$Exe) {
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = '--version'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    # Read asynchronously: a blocking ReadToEnd first would never let the
    # timeout fire for a process that hangs with its stdout open.
    $outTask = $p.StandardOutput.ReadToEndAsync()
    [void]$p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(20000)) { $p.Kill(); return '' }
    $out = $outTask.Result
    return $out.Trim()
  } catch { return '' }
}

# Marks a PE file as a Windows GUI program (subsystem 2) instead of a console
# one (3): the Subsystem field is 0x5C bytes after the PE signature.
function Set-PeSubsystemGui([string]$File) {
  $fs = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $br = New-Object IO.BinaryReader($fs)
    $fs.Position = 0x3C
    $pe = $br.ReadInt32()
    $fs.Position = $pe
    if ($br.ReadUInt32() -ne 0x00004550) { throw "$File is not a PE file" }
    $fs.Position = $pe + 0x5C
    $current = $br.ReadUInt16()
    if ($current -ne 2 -and $current -ne 3) { throw "unexpected PE subsystem $current in $File" }
    $fs.Position = $pe + 0x5C
    $bw = New-Object IO.BinaryWriter($fs)
    $bw.Write([UInt16]2)
    $bw.Flush()
  } finally {
    $fs.Dispose()
  }
}

# The program the task should run: the windowless (and, with rcedit, branded)
# copy of $SourceNode, or $SourceNode itself when a copy cannot be made.
function Get-AgentExe([string]$SourceNode, [string]$Home_, [string]$Rcedit, [string]$Icon) {
  $runtime = Join-Path $Home_ 'runtime'
  $target = Join-Path $runtime 'mullion-agent.exe'
  $stampFile = $target + '.json'
  $source = $SourceNode
  if ((Split-Path -Leaf $source) -ieq 'mullion-agent.exe') {
    # The copy handed back (the updater passes the running server's own
    # executable): the Node it was made from is in the stamp.
    $source = $null
    try {
      $old = Get-Content -LiteralPath ($SourceNode + '.json') -Raw | ConvertFrom-Json
      if ($old.source -and (Test-Path -LiteralPath $old.source -PathType Leaf)) { $source = [string]$old.source }
    } catch { }
    if (-not $source) { return $SourceNode }
  }
  $item = Get-Item -LiteralPath $source
  $haveRcedit = [bool]($Rcedit -and (Test-Path -LiteralPath $Rcedit -PathType Leaf))
  $haveIcon = [bool]($Icon -and (Test-Path -LiteralPath $Icon -PathType Leaf))
  $want = ConvertTo-Json -Compress -InputObject ([ordered]@{
      brand = $BrandVersion
      source = $item.FullName
      length = $item.Length
      lastWrite = $item.LastWriteTimeUtc.Ticks
      rcedit = $haveRcedit
      icon = $(if ($haveIcon) { (Get-Item -LiteralPath $Icon).Length } else { 0 })
    })
  if ((Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $stampFile)) {
    if ((Get-Content -LiteralPath $stampFile -Raw).Trim() -eq $want) { return $target }
  }

  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $sourceVersion = Get-ProgramVersion $source
  $tmp = $target + '.new'
  function Build([bool]$withResources) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $source -Destination $tmp -Force
    Set-PeSubsystemGui $tmp
    if ($withResources) {
      $fileVersion = if ($sourceVersion -match '^v?(\d+)\.(\d+)\.(\d+)') { "$($Matches[1]).$($Matches[2]).$($Matches[3]).0" } else { '1.0.0.0' }
      $rc = @($tmp,
        '--set-version-string', 'FileDescription', 'Mullion agent',
        '--set-version-string', 'ProductName', 'Mullion',
        '--set-version-string', 'CompanyName', 'Mullion',
        '--set-version-string', 'InternalName', 'mullion-agent',
        '--set-version-string', 'OriginalFilename', 'mullion-agent.exe',
        '--set-file-version', $fileVersion,
        '--set-product-version', $fileVersion)
      if ($haveIcon) { $rc += @('--set-icon', $Icon) }
      & $Rcedit @rc 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "rcedit exited with status $LASTEXITCODE" }
    }
    # The copy has to behave exactly like the Node it came from.
    $built = Get-ProgramVersion $tmp
    if (-not $built -or ($sourceVersion -and $built -ne $sourceVersion)) {
      throw "the copy reports '$built', not '$sourceVersion'"
    }
  }
  $branded = $haveRcedit
  try {
    Build $haveRcedit
  } catch {
    if (-not $haveRcedit) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
    Write-Output "branding: $($_.Exception.Message); making the windowless copy without the Mullion name and icon"
    $branded = $false
    Build $false
  }

  # The previous run is stopping: its server (and any session master it started,
  # which survives a restart) may still hold the old copy.
  $replaced = $false
  for ($i = 0; $i -lt 20 -and -not $replaced; $i++) {
    try { Move-Item -LiteralPath $tmp -Destination $target -Force; $replaced = $true } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $replaced) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $target) {
      $inUse = Get-ProgramVersion $target
      Write-Output "branding: $target is in use (a session started by the previous agent is still running); keeping the existing copy, which is Node $inUse (the Node it should be made from is $sourceVersion)"
      return $target
    }
    throw "could not write $target"
  }
  # What the stamp records is what was built: if the resources were left out,
  # the next registration tries again.
  if (-not $branded -and $haveRcedit) { $want = $want -replace '"rcedit":true', '"rcedit":false' }
  [IO.File]::WriteAllText($stampFile, $want, (New-Object Text.UTF8Encoding($false)))
  return $target
}

try {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

  if ($Remove) {
    if ($existing) {
      # Stopping first ends the launcher, and with it the server. Sessions run
      # in detached masters and keep running.
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Output "removed task $TaskName"
    } else {
      Write-Output "task $TaskName was not registered"
    }
    exit 0
  }

  foreach ($pair in @(@('NodePath', $NodePath), @('LauncherPath', $LauncherPath), @('MullionHome', $MullionHome))) {
    if ([string]::IsNullOrWhiteSpace($pair[1])) { Fail "-$($pair[0]) is required" }
  }
  # GetFullPath keeps a trailing backslash, and in a command line a backslash
  # before a quote escapes the quote: "C:\Mullion\" "Mullion-agent" would reach
  # the launcher as ONE argument, with the task name swallowed. A drive root
  # (C:\) keeps its backslash, since "C:" alone is a different place.
  function Trim-Backslash([string]$path) {
    $trimmed = $path.TrimEnd('\')
    if ($trimmed.EndsWith(':')) { return $path }
    return $trimmed
  }
  $node = Trim-Backslash ([System.IO.Path]::GetFullPath($NodePath))
  $launcher = Trim-Backslash ([System.IO.Path]::GetFullPath($LauncherPath))
  $home_ = Trim-Backslash ([System.IO.Path]::GetFullPath($MullionHome))
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Fail "node was not found at $node" }
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { Fail "the launcher was not found at $launcher" }
  if (-not (Test-Path -LiteralPath $home_ -PathType Container)) { Fail "the install root was not found at $home_" }

  # Re-registering replaces the definition IN PLACE (-Force below), rather than
  # unregistering first: a registration that then fails leaves the old task
  # registered, not a host with no task at all (the updater restarts the agent
  # this way, and a failure there must not leave it gone). The old run is
  # stopped first, so the new definition is what starts next.
  $wasRunning = $false
  if ($existing) {
    $wasRunning = ($existing.State -eq 'Running')
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }

  # The windowless copy of Node, made after the previous run was stopped (above)
  # so the old copy is not in use. Anything that goes wrong falls back to the
  # plain node.exe: the agent runs either way.
  $exe = $node
  if (-not $NoBrand) {
    if (-not $RceditPath) { $RceditPath = Join-Path $home_ 'runtime\rcedit.exe' }
    if (-not $IconPath) { $IconPath = Join-Path $PSScriptRoot 'mullion.ico' }
    try {
      $exe = Get-AgentExe $node $home_ $RceditPath $IconPath
    } catch {
      Write-Output "branding skipped: $($_.Exception.Message); the task runs $node"
      $exe = $node
    }
  }

  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  # Quoted: install roots under a profile can contain spaces.
  $arguments = '"{0}" "{1}" "{2}"' -f $launcher, $home_, $TaskName
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $home_
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
      -Settings $settings -Description 'Mullion (per-user; started at logon by scripts/windows-launcher.mjs)' -Force | Out-Null
  } catch {
    if ($wasRunning) {
      # -Force replaces only on success, so the old definition is intact: bring
      # the agent back rather than leave it stopped.
      Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Fail "$($_.Exception.Message) -- the previous task definition is unchanged, and was started again"
    }
    throw
  }
  Write-Output "registered task $TaskName for $user"

  if ($Start) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "started task $TaskName"
  }
  exit 0
} catch {
  Fail $_.Exception.Message
}
