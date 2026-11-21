$ErrorActionPreference = 'Stop'
$testExitCode = 1
$captureId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$captureDirectory = Join-Path $env:TEMP "CodeVisualizer-screen-capture-$captureId"
$testUserDataPath = Join-Path $PSScriptRoot ".vscode-test\runs\$captureId"
$stopFile = Join-Path $captureDirectory 'stop'
$readyFile = Join-Path $captureDirectory 'ready'
$captureScript = Join-Path $PSScriptRoot 'capture-screen.ps1'
$recorder = $null
$previousUserDataPath = $env:CODEVISUALIZER_TEST_USER_DATA
$previousCaptureDirectory = $env:CODEVISUALIZER_CAPTURE_DIRECTORY

Push-Location -LiteralPath $PSScriptRoot
try {
    New-Item -ItemType Directory -Path $captureDirectory -Force | Out-Null
    $recorderStdout = Join-Path $captureDirectory 'recorder.stdout.log'
    $recorderStderr = Join-Path $captureDirectory 'recorder.stderr.log'
    $env:CODEVISUALIZER_TEST_USER_DATA = $testUserDataPath
    $env:CODEVISUALIZER_CAPTURE_DIRECTORY = $captureDirectory
    $recorderArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$captureScript`" -OutputDirectory `"$captureDirectory`" -StopFile `"$stopFile`" -ReadyFile `"$readyFile`""
    $recorder = Start-Process -FilePath 'powershell.exe' -ArgumentList $recorderArguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $recorderStdout -RedirectStandardError $recorderStderr

    $readyWait = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $readyFile) -and $readyWait.Elapsed.TotalSeconds -lt 10) {
        [System.Threading.ManualResetEventSlim]::new($false).Wait(50)
    }
    if (-not (Test-Path -LiteralPath $readyFile)) {
        throw 'Screen capture process did not become ready.'
    }

    & npm.cmd test
    $testExitCode = $LASTEXITCODE
}
finally {
    if ($recorder) {
        New-Item -ItemType File -Path $stopFile -Force | Out-Null
        $recorder.WaitForExit()
        $frameCount = (Get-ChildItem -LiteralPath $captureDirectory -Filter 'frame-*.jpg' -File).Count
        $captureRows = Import-Csv -LiteralPath (Join-Path $captureDirectory 'frames.csv')
        $intervals = for ($index = 1; $index -lt $captureRows.Count; $index++) {
            [double]$captureRows[$index].ElapsedMs - [double]$captureRows[$index - 1].ElapsedMs
        }
        $averageInterval = if ($intervals.Count -gt 0) {
            [math]::Round(($intervals | Measure-Object -Average).Average, 1)
        } else {
            0
        }
        $maximumInterval = if ($intervals.Count -gt 0) {
            [math]::Round(($intervals | Measure-Object -Maximum).Maximum, 1)
        } else {
            0
        }
        Write-Output "SCREEN_CAPTURE_DIRECTORY=$captureDirectory"
        Write-Output "SCREEN_CAPTURE_INTERVAL_MS=100"
        Write-Output "SCREEN_CAPTURE_FRAME_COUNT=$frameCount"
        Write-Output "SCREEN_CAPTURE_AVERAGE_INTERVAL_MS=$averageInterval"
        Write-Output "SCREEN_CAPTURE_MAX_INTERVAL_MS=$maximumInterval"
        if (Test-Path -LiteralPath $recorderStderr) {
            $recorderError = Get-Content -LiteralPath $recorderStderr -Raw
            if (-not [string]::IsNullOrWhiteSpace($recorderError)) {
                Write-Output "SCREEN_CAPTURE_ERROR=$recorderError"
                $testExitCode = 1
            }
        }
        if ($frameCount -lt 10) {
            Write-Output 'SCREEN_CAPTURE_ERROR=Fewer than 10 frames were captured.'
            $testExitCode = 1
        }
    }
    $env:CODEVISUALIZER_TEST_USER_DATA = $previousUserDataPath
    $env:CODEVISUALIZER_CAPTURE_DIRECTORY = $previousCaptureDirectory
    Pop-Location
}

exit $testExitCode