# deadman / remove the reboot startup-helper logon task.
#   powershell -ExecutionPolicy Bypass -File "$HOME\.claude\deadman\uninstall-helper.ps1"
try {
  Unregister-ScheduledTask -TaskName 'DeadmanRises' -Confirm:$false -ErrorAction Stop
  Write-Output 'DeadmanRises logon task removed.'
} catch {
  Write-Output 'DeadmanRises task not found (already removed).'
}
