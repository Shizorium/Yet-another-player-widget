param([switch]$Check)

$ErrorActionPreference = 'Stop'

function Get-NodeMajorVersion([string]$Runtime) {
    # --version works in Windows PowerShell 5.1 without embedded JavaScript quotes.
    $versionText = & $Runtime --version
    if ($LASTEXITCODE -ne 0) { return 0 }
    $versionMatch = [regex]::Match([string]$versionText, '^v(\d+)\.')
    if (-not $versionMatch.Success) { return 0 }
    return [int]$versionMatch.Groups[1].Value
}

try {
    $standaloneHelper = Join-Path $PSScriptRoot 'Helper.exe'
    if (Test-Path -LiteralPath $standaloneHelper -PathType Leaf) {
        if ($Check) { & $standaloneHelper --check --no-pause }
        else { & $standaloneHelper --no-pause }
        exit $LASTEXITCODE
    }
    $helperFile = Join-Path $PSScriptRoot 'server.mjs'
    if (-not (Test-Path -LiteralPath $helperFile -PathType Leaf)) { throw 'Не найден server.mjs. Восстановите папку helper из архива модуля.' }
    $runtimeCandidates = @()
    if ($env:YAPW_NODE) {
        $runtimeCandidates = @($env:YAPW_NODE)
    } else {
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($nodeCommand) { $runtimeCandidates += $nodeCommand.Source }
        $runtimeCandidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    }
    $runtimePath = $null
    foreach ($candidate in $runtimeCandidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        if ((Get-NodeMajorVersion $candidate) -ge 22) { $runtimePath = $candidate; break }
    }
    if (-not $runtimePath) {
        if ($env:YAPW_NODE) { throw 'YAPW_NODE должен указывать на существующий node.exe версии 22 или новее.' }
        throw 'Не найден Node.js 22 или новее. Установите его: https://nodejs.org/'
    }
    if ($Check) {
        Write-Host 'Проверка запуска пройдена.' -ForegroundColor Green
        Write-Host "Node.js: $(& $runtimePath --version)"
        Write-Host "Программа: $runtimePath"
        exit 0
    }
    Write-Host 'Yet another player widget — запуск помощника' -ForegroundColor Cyan
    & $runtimePath $helperFile
    exit $LASTEXITCODE
} catch {
    Write-Host "Ошибка запуска: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
