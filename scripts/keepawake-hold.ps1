# deadman / keep-awake holder — keeps the SYSTEM awake (NOT the display) for as
# long as this process lives. Spawned detached by keepawake.js, which finds/kills
# it by matching this script name in the process command line (Node's child.pid is
# unreliable for a hidden detached PowerShell — it gets reparented on Windows).
# Killing it (or its exit) auto-releases the lease. Re-asserts every 60s.
# Deliberately omits ES_DISPLAY_REQUIRED so the monitor can still sleep/lock.
# Does NOT block user-initiated sleep / lid-close (by Windows design).
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DeadmanPower {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
# NB: 0x80000000 parses as a signed Int32 in PowerShell and will NOT cast to
# [uint32] directly. The L suffix makes it an Int64 first, which casts cleanly.
$ES_CONTINUOUS      = [uint32]0x80000000L
$ES_SYSTEM_REQUIRED = [uint32]0x00000001L
while ($true) {
  [DeadmanPower]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
  Start-Sleep -Seconds 60
}
