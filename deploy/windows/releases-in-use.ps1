# Prints the names of the release directories under -ReleasesDir that a running
# process is using, one per line (issue #2161, part of #1728). The updater
# (scripts/self-update.sh) uses it to leave those alone when it prunes old
# releases.
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
#       -File releases-in-use.ps1 -ReleasesDir C:\...\Mullion\releases
#
# Why it exists: a session's pty-host master keeps running from the release it
# was started in, across any number of updates. On Linux deleting that
# directory is harmless (the process keeps its open files); on Windows a delete
# removes everything the OS has not locked (the running node.exe, the loaded
# native modules) and leaves a half-deleted release under a live session. So a
# release a process still runs from is not pruned.
#
# How a process is found to be "in" a release: by the native modules it has
# LOADED (node-pty's binary, better-sqlite3's), which are resolved to the
# release's real path. Not by its command line: a master is started through the
# `current` junction (`...\current\dist\pty-host\pty-host.mjs`), so its command
# line never names the release it resolved to. The command line and executable
# path are checked as well, for a process started with a release's own path.
#
# A process it cannot inspect (another user's, a protected one) is skipped: the
# updater only ever has to protect this user's own sessions.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the
# ANSI code page. Exit status: 0 (an empty list is a valid answer, and so is a
# releases directory that does not exist), 1 with the reason on stderr.
param(
  [Parameter(Mandatory = $true)][string]$ReleasesDir
)

$ErrorActionPreference = 'Stop'

try {
  $root = [System.IO.Path]::GetFullPath($ReleasesDir).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { exit 0 }

  # Everything a node process points into, lower-cased with backslashes, so the
  # comparison does not depend on slash style or case.
  $seen = New-Object System.Collections.Generic.List[string]
  foreach ($proc in [System.Diagnostics.Process]::GetProcessesByName('node')) {
    try {
      foreach ($module in $proc.Modules) { $seen.Add($module.FileName.ToLowerInvariant().Replace('/', '\')) }
    } catch {
      # Access denied, or the process exited while it was being read.
    } finally {
      $proc.Dispose()
    }
  }
  foreach ($row in Get-CimInstance Win32_Process -Filter "Name = 'node.exe'") {
    foreach ($text in @($row.ExecutablePath, $row.CommandLine)) {
      if ($text) { $seen.Add($text.ToLowerInvariant().Replace('/', '\')) }
    }
  }

  foreach ($dir in Get-ChildItem -LiteralPath $root -Directory) {
    $needle = ($dir.FullName.TrimEnd('\') + '\').ToLowerInvariant()
    foreach ($text in $seen) {
      if ($text.Contains($needle)) {
        Write-Output $dir.Name
        break
      }
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine("releases-in-use: $($_.Exception.Message)")
  exit 1
}
