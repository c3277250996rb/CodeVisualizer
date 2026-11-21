param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [Parameter(Mandatory = $true)]
    [string]$StopFile,
    [Parameter(Mandatory = $true)]
    [string]$ReadyFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$screenBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$frameNumber = 0
$runTimer = [System.Diagnostics.Stopwatch]::StartNew()
$captureTimer = [System.Diagnostics.Stopwatch]::new()
$timingLog = [System.IO.StreamWriter]::new((Join-Path $OutputDirectory 'frames.csv'), $false, [System.Text.UTF8Encoding]::new($false))
$timingLog.WriteLine('Frame,ElapsedMs,CapturedAt')
New-Item -ItemType File -Path $ReadyFile -Force | Out-Null

while (-not (Test-Path -LiteralPath $StopFile)) {
    $captureTimer.Restart()
    $elapsedMilliseconds = [math]::Round($runTimer.Elapsed.TotalMilliseconds, 1)
    $capturedAt = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fff'
    $bitmap = New-Object System.Drawing.Bitmap($screenBounds.Width, $screenBounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($screenBounds.Location, [System.Drawing.Point]::Empty, $screenBounds.Size)
        $framePath = Join-Path $OutputDirectory ('frame-{0:D5}.jpg' -f $frameNumber)
        $bitmap.Save($framePath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
        $timingLog.WriteLine("$frameNumber,$elapsedMilliseconds,$capturedAt")
        $timingLog.Flush()
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }

    $frameNumber++
    $waitMilliseconds = 100 - [int]$captureTimer.ElapsedMilliseconds
    if ($waitMilliseconds -gt 0) {
        $waitHandle = [System.Threading.ManualResetEvent]::new($false)
        [void]$waitHandle.WaitOne($waitMilliseconds)
        $waitHandle.Dispose()
    }
}

$timingLog.Dispose()