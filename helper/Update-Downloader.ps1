$ErrorActionPreference = 'Stop'
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' -Headers @{ 'User-Agent' = 'YetAnotherPlayerWidget-Setup' }
$asset = $release.assets | Where-Object name -EQ 'yt-dlp.exe' | Select-Object -First 1
if (-not $asset -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'GitHub не вернул подтверждённый файл загрузчика.' }
$binFolder = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $binFolder -Force | Out-Null
$downloadFile = Join-Path $binFolder 'yt-dlp.download'
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloadFile
$actualHash = (Get-FileHash -LiteralPath $downloadFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $asset.digest.Substring(7)) { throw 'Контрольная сумма загрузчика не совпала. Файл не будет использован.' }
Move-Item -LiteralPath $downloadFile -Destination (Join-Path $binFolder 'yt-dlp.exe') -Force
Write-Host "yt-dlp $($release.tag_name) готов. Перезапустите помощник." -ForegroundColor Green
