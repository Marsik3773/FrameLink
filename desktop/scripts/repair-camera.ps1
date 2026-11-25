$ErrorActionPreference = 'Stop'
$resources = $PSScriptRoot
foreach ($entry in @(@('System32','FrameLinkCamera-x64.dll'), @('SysWOW64','FrameLinkCamera-x86.dll'), @('System32','FrameLinkMediaSource.dll'))) {
    $program = Join-Path $env:SystemRoot ($entry[0] + '\regsvr32.exe')
    $dll = Join-Path $resources $entry[1]
    $p = Start-Process $program -ArgumentList "/s `"$dll`"" -Wait -PassThru
    if ($p.ExitCode) { exit $p.ExitCode }
}
& "$resources\framelink-camera-register.exe" --install
if ($LASTEXITCODE -eq 3) { exit 0 } # DirectShow only on older Windows.
exit $LASTEXITCODE
