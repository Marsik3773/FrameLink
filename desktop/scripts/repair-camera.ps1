$ErrorActionPreference = 'Stop'
$resources = $PSScriptRoot
function Register-Dll([string]$folder, [string]$name, [switch]$Remove) {
    $program = Join-Path $env:SystemRoot ($folder + '\regsvr32.exe')
    $dll = Join-Path $resources $name
    $mode = if ($Remove) { '/s /u' } else { '/s' }
    $p = Start-Process $program -ArgumentList "$mode `"$dll`"" -Wait -PassThru
    return $p.ExitCode
}

$modern = 'FrameLinkMediaSource.dll'
if ([int](Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' CurrentBuildNumber) -ge 22000) {
    $result = Register-Dll 'System32' $modern
    if ($result) { exit $result }
    & "$resources\framelink-camera-register.exe" --install
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    # Remove the capture filter from both registry views when upgrading from 0.3.0.
    $result64 = Register-Dll 'System32' 'FrameLinkCamera-x64.dll' -Remove
    $result32 = Register-Dll 'SysWOW64' 'FrameLinkCamera-x86.dll' -Remove
    if ($result64 -or $result32) { exit 1 }
    exit 0
}

$result = Register-Dll 'System32' 'FrameLinkCamera-x64.dll'
if ($result) { exit $result }
$result = Register-Dll 'SysWOW64' 'FrameLinkCamera-x86.dll'
if ($result) {
    $null = Register-Dll 'System32' 'FrameLinkCamera-x64.dll' -Remove
}
exit $result
