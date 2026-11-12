param([switch]$SkipToolInstall)
$ErrorActionPreference = 'Stop'
$sources = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'component-sources.json') -Raw | ConvertFrom-Json
$buildRoot = Join-Path $PSScriptRoot '.build'
$binRoot = Join-Path $buildRoot 'bin'
New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
function Test-Hash([string]$File,[string]$Hash) {
    return (Test-Path -LiteralPath $File -PathType Leaf) -and ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Hash)
}
function Get-VerifiedFile([string]$Url,[string]$File,[string]$Hash) {
    if (Test-Hash $File $Hash) { return }
    $temporaryFile = $File + '.download'
    Invoke-WebRequest -Uri $Url -OutFile $temporaryFile -UseBasicParsing
    if (-not (Test-Hash $temporaryFile $Hash)) { throw ('SHA-256 mismatch: ' + $Url) }
    Move-Item -LiteralPath $temporaryFile -Destination $File -Force
}
$nodeFile = Join-Path $binRoot 'node.exe'
Get-VerifiedFile $sources.node.url $nodeFile $sources.node.sha256
$ytdlpFolder = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $ytdlpFolder -Force | Out-Null
Get-VerifiedFile $sources.ytdlp.url (Join-Path $ytdlpFolder 'yt-dlp.exe') $sources.ytdlp.sha256
$ffmpegFile = Join-Path $binRoot 'ffmpeg.exe'
$ffprobeFile = Join-Path $binRoot 'ffprobe.exe'
if (-not (Test-Hash $ffmpegFile $sources.ffmpeg.files.'ffmpeg.exe') -or -not (Test-Hash $ffprobeFile $sources.ffmpeg.files.'ffprobe.exe')) {
    $archiveFile = Join-Path $buildRoot 'ffmpeg-essentials.zip'
    Get-VerifiedFile $sources.ffmpeg.url $archiveFile $sources.ffmpeg.archiveSha256
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archiveFile)
    try {
        foreach ($name in @('ffmpeg.exe','ffprobe.exe')) {
            $entry = $archive.Entries | Where-Object { $_.FullName.EndsWith('/bin/' + $name) } | Select-Object -First 1
            if (-not $entry) { throw ('Missing file: ' + $name) }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $binRoot $name),$true)
        }
    } finally { $archive.Dispose() }
}
if (-not $SkipToolInstall) {
    $npmCommand = Get-Command npm -ErrorAction Stop | Select-Object -First 1
    Push-Location (Join-Path $PSScriptRoot 'build-tools')
    try { & $npmCommand.Source ci --ignore-scripts --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci failed.' } }
    finally { Pop-Location }
}
& $nodeFile (Join-Path $PSScriptRoot 'build-helper.mjs') --node $nodeFile --ffmpeg $ffmpegFile --ffprobe $ffprobeFile
exit $LASTEXITCODE
