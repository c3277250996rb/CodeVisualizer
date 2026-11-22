# 精简版测试入口：默认只构建一次并跑 vscode-test，不再默认开录屏
param(
    [switch]$SkipBuild,
    [switch]$FreshProfile,
    [switch]$RecordScreen
)

$ErrorActionPreference = 'Stop'
$testExitCode = 1
$recorder = $null
$captureDirectory = $null
$previousUserDataPath = $env:CODEVISUALIZER_TEST_USER_DATA
$previousCaptureDirectory = $env:CODEVISUALIZER_CAPTURE_DIRECTORY

Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not $SkipBuild) {
        Write-Output 'BUILD=webpack'
        & npm.cmd run compile
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run compile failed'
        }

        Write-Output 'BUILD=tsc'
        & npm.cmd run compile-tests
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run compile-tests failed'
        }
    }

    # 默认复用固定 profile，避免每次都当首次启动；需要隔离时用 -FreshProfile
    $userDataPath = if ($FreshProfile) {
        Join-Path $PSScriptRoot (".vscode-test\runs\" + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    } else {
        Join-Path $PSScriptRoot '.vscode-test\light-user-data'
    }
    New-Item -ItemType Directory -Path $userDataPath -Force | Out-Null
    $env:CODEVISUALIZER_TEST_USER_DATA = $userDataPath

    # 录屏是可选能力：只有显式 -RecordScreen 才启动，也不参与成败判定
    if ($RecordScreen) {
        $captureDirectory = Join-Path $env:TEMP ("CodeVisualizer-screen-" + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        New-Item -ItemType Directory -Path $captureDirectory -Force | Out-Null
        $stopFile = Join-Path $captureDirectory 'stop'
        $readyFile = Join-Path $captureDirectory 'ready'
        $env:CODEVISUALIZER_CAPTURE_DIRECTORY = $captureDirectory
        $recorderArguments = @(
            '-NoProfile'
            '-ExecutionPolicy'
            'Bypass'
            '-WindowStyle'
            'Hidden'
            '-File'
            (Join-Path $PSScriptRoot 'capture-screen.ps1')
            '-OutputDirectory'
            $captureDirectory
            '-StopFile'
            $stopFile
            '-ReadyFile'
            $readyFile
        )
        $recorder = Start-Process -FilePath 'powershell.exe' -ArgumentList $recorderArguments -PassThru -WindowStyle Hidden
        $readyWait = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath $readyFile) -and $readyWait.Elapsed.TotalSeconds -lt 5) {
            Start-Sleep -Milliseconds 50
        }
        Write-Output "SCREEN_CAPTURE_DIRECTORY=$captureDirectory"
    }

    # 直接调用 vscode-test，绕开 npm 的 pretest（那会再跑一遍 clean+webpack+eslint）
    & npx.cmd vscode-test
    $testExitCode = $LASTEXITCODE
}
finally {
    if ($recorder) {
        New-Item -ItemType File -Path (Join-Path $captureDirectory 'stop') -Force | Out-Null
        $recorder.WaitForExit()
        $frameCount = @(Get-ChildItem -LiteralPath $captureDirectory -Filter 'frame-*.jpg' -File).Count
        Write-Output "SCREEN_CAPTURE_FRAME_COUNT=$frameCount"
    }
    $env:CODEVISUALIZER_TEST_USER_DATA = $previousUserDataPath
    $env:CODEVISUALIZER_CAPTURE_DIRECTORY = $previousCaptureDirectory
    Pop-Location
}

Write-Output "TEST_EXIT_CODE=$testExitCode"
exit $testExitCode
