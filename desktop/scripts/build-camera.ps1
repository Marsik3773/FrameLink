$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$work = Join-Path (Get-Location) 'native/build'
$source = Join-Path $work 'windows-samples'
$ref = '434f6002bdf9cf9829406c3ff2b33387982d6168'
$path = 'Samples/Win7Samples/multimedia/directshow/baseclasses'

function Invoke-Checked([scriptblock]$command) {
    & $command
    if ($LASTEXITCODE -ne 0) { throw "Build command failed with exit code $LASTEXITCODE" }
}

if (!(Test-Path (Join-Path $source "$path/streams.h"))) {
    New-Item -ItemType Directory -Force $source | Out-Null
    Invoke-Checked { git -C $source init }
    Invoke-Checked { git -C $source sparse-checkout set $path }
    Invoke-Checked { git -C $source config remote.origin.url https://github.com/microsoft/Windows-classic-samples.git }
    Invoke-Checked { git -C $source fetch --depth 1 --filter=blob:none origin $ref }
    Invoke-Checked { git -C $source checkout FETCH_HEAD }
}
foreach ($arch in @('x64', 'Win32')) {
    $out = Join-Path $work $arch
    Invoke-Checked { cmake -S native/camera -B $out -A $arch "-DBASECLASSES=$source/$path" }
    Invoke-Checked { cmake --build $out --config Release --parallel }
    if ($arch -eq 'x64') {
        Copy-Item (Join-Path $out 'Release/framelink-virtualcam.exe') 'native/framelink-virtualcam.exe' -Force
    }
    $suffix = if ($arch -eq 'x64') { 'x64' } else { 'x86' }
    Copy-Item (Join-Path $out 'Release/FrameLinkCamera.dll') "native/FrameLinkCamera-$suffix.dll" -Force
}
Copy-Item "$work/x64/Release/framelink-camera-register.exe" native -Force
$mf = Join-Path $work 'vcam'
if (!(Test-Path "$mf/.git")) {
    Invoke-Checked { git clone --quiet https://github.com/smourier/VCamSample.git $mf }
}
$ref = '5840d0c4c70bd388d40cd434a6783a4d34701d81'
Invoke-Checked { git -C $mf checkout --force $ref }
Invoke-Checked { git -C $mf apply --ignore-space-change --ignore-whitespace (Resolve-Path 'native/mf/framelink.patch') }
Copy-Item native/frame_queue.h,native/frame_reader.h "$mf/VCamSampleSource" -Force
$env:CL = '/DNOMINMAX'
Invoke-Checked { nuget restore "$mf/VCamSample.sln" -NonInteractive }
$vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
$msbuild = & $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\Current\Bin\MSBuild.exe' | Select-Object -First 1
Invoke-Checked { & $msbuild "$mf/VCamSampleSource/VCamSampleSource.vcxproj" /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=v143 "/p:OutDir=$work/mfout/" /verbosity:minimal }
Copy-Item "$work/mfout/VCamSampleSource.dll" native/FrameLinkMediaSource.dll -Force
