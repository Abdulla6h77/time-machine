$ErrorActionPreference = 'Stop'
$taskName = 'TinyFish Time Machine Worker'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { throw "Task already exists. Inspect its action before replacing it." }
$configPath = Join-Path $PSScriptRoot 'state/collector-config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Create the local collector configuration first.' }
$node = (Get-Command node.exe).Source
$entry = Join-Path $PSScriptRoot 'supervise.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + $entry + '"') -WorkingDirectory $PSScriptRoot
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 365))
)
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Supervises the existing TinyFish Time Machine collector for the signed-in user.' | Out-Null
