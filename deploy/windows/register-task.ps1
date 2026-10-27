# Registers (or removes) Mullion's per-user scheduled task on Windows -- the
# Windows counterpart of installing a systemd --user unit or a launchd agent
# (issue #2160, part of #1728). Run by deploy/install.sh; it can be run by
# hand too.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File register-task.ps1
#       -TaskName Mullion-agent -NodePath C:\...\node.exe
#       -LauncherPath C:\...\current\scripts\windows-launcher.mjs
#       -MullionHome C:\...\Mullion [-Start]
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
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the
# ANSI code page. Exit status: 0 on success, 1 (with the reason on stderr) on
# any failure.
param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [string]$NodePath,
  [string]$LauncherPath,
  [string]$MullionHome,
  [switch]$Start,
  [switch]$Remove
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

  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  # Quoted: install roots under a profile can contain spaces.
  $arguments = '"{0}" "{1}" "{2}"' -f $launcher, $home_, $TaskName
  $action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $home_
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
