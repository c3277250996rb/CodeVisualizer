# 测试入口：默认构建一次 + 跑 vscode-test + 全程 100ms 实拍录屏
param(
    [switch]$SkipBuild,
    [switch]$FreshProfile,
    [switch]$NoRecordScreen,
    # 只跑标题包含该关键字的用例，例如 -Only MyAdc
    [string]$Only = ''
)

$ErrorActionPreference = 'Stop'
$testExitCode = 1
$recorder = $null
$captureDirectory = $null
$previousUserDataPath = $env:CODEVISUALIZER_TEST_USER_DATA
$previousCaptureDirectory = $env:CODEVISUALIZER_CAPTURE_DIRECTORY
$previousOnly = $env:CODEVISUALIZER_TEST_ONLY

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

    if ($SkipBuild) {
        # npm run compile 会 rimraf out，所以 -SkipBuild 前必须确认测试代码还在
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'out\test'))) {
            throw '-SkipBuild 但 out/test 不存在：先完整跑一次（去掉 -SkipBuild）或执行 npm run compile-tests'
        }
    }

    if ($Only) {
        $env:CODEVISUALIZER_TEST_ONLY = $Only
        Write-Output "TEST_ONLY=$Only"
    }

    # 100ms 实拍是默认行为：录下测试期间窗口真实画面的全过程，只记录不参与成败判定
    if (-not $NoRecordScreen) {
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
            '-ActivateWindowTitle'
            # 标题含空格，Start-Process 的数组参数用空格拼接，必须自己带引号
            '"*Extension Development Host*"'
        )
        $recorder = Start-Process -FilePath 'powershell.exe' -ArgumentList $recorderArguments -PassThru -WindowStyle Hidden
        $readyWait = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not (Test-Path -LiteralPath $readyFile) -and $readyWait.Elapsed.TotalSeconds -lt 5) {
            Start-Sleep -Milliseconds 50
        }
        # 录屏脚本起不来时不要静默变成 0 帧，明确报出来
        if (-not (Test-Path -LiteralPath $readyFile)) {
            Write-Output "SCREEN_CAPTURE_WARNING=recorder-not-ready $captureDirectory"
        }
        Write-Output 'SCREEN_CAPTURE_INTERVAL_MS=100'
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
        $frames = @(Get-ChildItem -LiteralPath $captureDirectory -Filter 'frame-*.jpg' -File)
        Write-Output "SCREEN_CAPTURE_FRAME_COUNT=$($frames.Count)"
        $timingLogPath = Join-Path $captureDirectory 'frames.csv'
        if (Test-Path -LiteralPath $timingLogPath) {
            # 用记录里的时间戳反算真实帧间隔，确认是 100ms 级实拍
            $rows = @(Get-Content -LiteralPath $timingLogPath | Select-Object -Skip 1)
            if ($rows.Count -gt 1) {
                $firstElapsed = [double]($rows[0].Split(',')[1])
                $lastElapsed = [double]($rows[$rows.Count - 1].Split(',')[1])
                $averageInterval = [math]::Round(($lastElapsed - $firstElapsed) / ($rows.Count - 1), 1)
                Write-Output "SCREEN_CAPTURE_AVERAGE_INTERVAL_MS=$averageInterval"
            }
            Write-Output "SCREEN_CAPTURE_TIMING_LOG=$timingLogPath"
        }
    }
    $env:CODEVISUALIZER_TEST_USER_DATA = $previousUserDataPath
    $env:CODEVISUALIZER_CAPTURE_DIRECTORY = $previousCaptureDirectory
    $env:CODEVISUALIZER_TEST_ONLY = $previousOnly
    Pop-Location
}

Write-Output "TEST_EXIT_CODE=$testExitCode"
exit $testExitCode
