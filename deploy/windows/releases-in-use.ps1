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
# The script is conservative in the one direction that matters: a release it
# fails to report gets DELETED. So it does not guess. The releases directory is
# resolved to its real path first (a junction, a short 8.3 name or a substituted
# drive in the path would otherwise make every module path "elsewhere"), and a
# node process whose modules cannot be read -- when it is still running --
# makes the whole answer "unknown": exit 1 with the reason on stderr, which the
# updater treats as "prune nothing". A process that exited while it was being
# read is not an error.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less script in the
# ANSI code page. Exit status: 0 (an empty list is a valid answer, and so is a
# releases directory that does not exist), 1 with the reason on stderr.
param(
  [Parameter(Mandatory = $true)][string]$ReleasesDir
)

$ErrorActionPreference = 'Stop'

# The real path of a directory: junctions, symlinks, short names and substituted
# drives resolved, the way the loader reports a module's path.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class MullionRealPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);

  public static string Resolve(string path) {
    // 0 = query only, 7 = share everything, 3 = OPEN_EXISTING,
    // 0x02000000 = FILE_FLAG_BACKUP_SEMANTICS (needed to open a directory).
    using (SafeFileHandle handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder buffer = new StringBuilder(1024);
      uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
      if (length == 0 || length >= buffer.Capacity) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      string real = buffer.ToString();
      if (real.StartsWith(@"\\?\UNC\")) return @"\\" + real.Substring(8);
      if (real.StartsWith(@"\\?\")) return real.Substring(4);
      return real;
    }
  }
}
'@

try {
  $given = [System.IO.Path]::GetFullPath($ReleasesDir)
  if (-not (Test-Path -LiteralPath $given -PathType Container)) { exit 0 }
  $root = [MullionRealPath]::Resolve($given).TrimEnd('\')

  # Everything a node process points into, lower-cased with backslashes, so the
  # comparison does not depend on slash style or case.
  $seen = New-Object System.Collections.Generic.List[string]
  $unreadable = New-Object System.Collections.Generic.List[string]
  foreach ($proc in [System.Diagnostics.Process]::GetProcessesByName('node')) {
    try {
      foreach ($module in $proc.Modules) { $seen.Add($module.FileName.ToLowerInvariant().Replace('/', '\')) }
    } catch {
      # Access denied, a bitness mismatch, or the process exited while it was
      # being read. Only the last is harmless -- and HasExited cannot tell them
      # apart (it throws for a process we may not open), so ask whether the
      # process is still there.
      $id = $proc.Id
      if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $unreadable.Add([string]$id) }
    } finally {
      $proc.Dispose()
    }
  }
  if ($unreadable.Count -gt 0) {
    [Console]::Error.WriteLine("releases-in-use: could not read the loaded modules of node process(es) $($unreadable -join ', '), so it cannot tell which releases are in use")
    exit 1
  }
  foreach ($row in Get-CimInstance Win32_Process -Filter "Name = 'node.exe'") {
    foreach ($text in @($row.ExecutablePath, $row.CommandLine)) {
      if ($text) { $seen.Add($text.ToLowerInvariant().Replace('/', '\')) }
    }
  }

  foreach ($dir in Get-ChildItem -LiteralPath $root -Directory) {
    $path = $dir.FullName.TrimEnd('\').ToLowerInvariant()
    # The release's path as a prefix of a longer one (a module or a script under
    # it), or as a whole argument (a working directory on a command line): not
    # as the start of a longer NAME, so 1.2.3 is not 1.2.30.
    $inside = $path + '\'
    foreach ($text in $seen) {
      if ($text.Contains($inside) -or $text.EndsWith($path) -or $text.Contains($path + '"') -or $text.Contains($path + ' ')) {
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
