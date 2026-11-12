param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$moduleRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $moduleRoot 'dist' }
$releaseRoot = [IO.Path]::GetFullPath($OutputDirectory)
$manifestFile = Join-Path $moduleRoot 'module.json'
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $moduleRoot 'package.json') -Raw | ConvertFrom-Json
$bundle = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bundle-info.json') -Raw | ConvertFrom-Json
$version = $manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+$' -or $version -ne $package.version -or $version -ne $bundle.version) { throw 'Module, package and EXE versions must match.' }
if ($manifest.id -ne 'yet-another-player-widget' -or -not $manifest.persistentStorage) { throw 'Invalid module id or missing persistentStorage.' }
$baseUrl = 'https://github.com/Shizorium/Yet-another-player-widget'
$zipName = 'yet-another-player-widget-' + $version + '.zip'
if ($manifest.manifest -ne ($baseUrl + '/releases/latest/download/module.json') -or $manifest.download -ne ($baseUrl + '/releases/download/v' + $version + '/' + $zipName)) { throw 'Manifest/download URL does not match this release.' }
function Get-Sha256([string]$File) { return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
$exeFile = Join-Path $PSScriptRoot 'Helper.exe'
$exeHash = Get-Sha256 $exeFile
if ($exeHash -ne $bundle.executableSha256 -or -not (Get-Content -LiteralPath ($exeFile + '.sha256') -Raw).StartsWith($exeHash)) { throw 'Helper.exe checksum mismatch. Rebuild the helper.' }
foreach ($record in $bundle.files) {
    $source = $null
    if ($record.path -in @('helper/server.mjs','scripts/model.js')) { $source = Join-Path $moduleRoot $record.path }
    elseif ($record.path.StartsWith('licenses/')) { $source = Join-Path $PSScriptRoot $record.path }
    if ($source -and (Get-Sha256 $source) -ne $record.sha256) { throw ('Embedded source changed; rebuild EXE: ' + $record.path) }
}
$releaseFiles = [Collections.Generic.List[IO.FileInfo]]::new()
function Add-ReleaseFile([string]$RelativePath) {
    $entry = Get-Item -LiteralPath (Join-Path $moduleRoot $RelativePath) -Force
    if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('Unexpected file: ' + $RelativePath) }
    $releaseFiles.Add($entry)
}
function Add-ReleaseDirectory([string]$RelativePath) {
    $directory = Get-Item -LiteralPath (Join-Path $moduleRoot $RelativePath) -Force
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Unexpected directory link: ' + $RelativePath) }
    foreach ($entry in Get-ChildItem -LiteralPath $directory.FullName -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($entry.Name -in @('.git','.build','node_modules','dist') -or $entry.Name -like '*.log') { continue }
        $relative = $entry.FullName.Substring($moduleRoot.Length + 1)
        if ($entry.PSIsContainer) { Add-ReleaseDirectory $relative } else { Add-ReleaseFile $relative }
    }
}
foreach ($name in @('.gitattributes','.gitignore','module.json','package.json','README.md','CHANGELOG.md')) { Add-ReleaseFile $name }
foreach ($name in @('scripts','styles','docs','tests','helper/licenses')) { Add-ReleaseDirectory $name }
foreach ($name in @('build-helper.mjs','Build-Helper.ps1','Package-Module.ps1','bundle-info.json','component-sources.json','Helper.exe','Helper.exe.sha256','launcher.cjs','server.mjs','Start-Helper.cmd','Start-Helper.ps1','Update-Downloader.ps1','bin/SOURCE.txt','build-tools/package.json','build-tools/package-lock.json')) { Add-ReleaseFile ('helper/' + $name) }
foreach ($name in @('storage/uploads/.gitkeep','storage/youtube/.gitkeep')) { Add-ReleaseFile $name }
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$archivePath = Join-Path $releaseRoot $zipName
$stream = [IO.File]::Open($archivePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$archive = $null
try {
    $archive = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
    foreach ($file in $releaseFiles | Sort-Object FullName) {
        $relative = $file.FullName.Substring($moduleRoot.Length + 1).Replace('\','/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,('yet-another-player-widget/' + $relative),[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { if ($archive) { $archive.Dispose() }; $stream.Dispose() }
Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $releaseRoot 'module.json') -Force
$zipHash = Get-Sha256 $archivePath
$manifestHash = Get-Sha256 (Join-Path $releaseRoot 'module.json')
$sums = $zipHash + '  ' + $zipName + "`n" + $manifestHash + "  module.json`n" + $exeHash + "  Helper.exe`n"
[IO.File]::WriteAllText((Join-Path $releaseRoot 'SHA256SUMS.txt'),$sums,[Text.Encoding]::ASCII)
Write-Output ('Created: ' + $archivePath)
Write-Output ('Files: ' + $releaseFiles.Count + '; version: ' + $version + '; ZIP SHA256: ' + $zipHash)
