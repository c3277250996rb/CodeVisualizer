param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [Parameter(Mandatory = $true)]
    [string]$StopFile,
    [Parameter(Mandatory = $true)]
    [string]$ReadyFile,
    # optional: window title pattern to keep in front so frames show the rendering
    [string]$ActivateWindowTitle = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ($ActivateWindowTitle) {
    Add-Type -Namespace CodeVisualizer -Name WindowApi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$screenBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$frameNumber = 0
$runTimer = [System.Diagnostics.Stopwatch]::StartNew()
$captureTimer = [System.Diagnostics.Stopwatch]::new()
$timingLog = [System.IO.StreamWriter]::new((Join-Path $OutputDirectory 'frames.csv'), $false, [System.Text.UTF8Encoding]::new($false))
$timingLog.WriteLine('Frame,ElapsedMs,CapturedAt')
New-Item -ItemType File -Path $ReadyFile -Force | Out-Null

while (-not (Test-Path -LiteralPath $StopFile)) {
    # every ~1s keep the target window in front, otherwise the frames only show whatever is on top
    if ($ActivateWindowTitle -and ($frameNumber % 10) -eq 0) {
        try {
            $target = Get-Process -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $ActivateWindowTitle } |
                Select-Object -First 1
            if ($target -and ([CodeVisualizer.WindowApi]::GetForegroundWindow() -ne $target.MainWindowHandle)) {
                [void][CodeVisualizer.WindowApi]::ShowWindowAsync($target.MainWindowHandle, 9)
                [void][CodeVisualizer.WindowApi]::SetForegroundWindow($target.MainWindowHandle)
            }
        }
        catch {
            # activation is best effort, never break the recording
        }
    }
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