$ErrorActionPreference = 'Stop'

$codePath = 'C:\Program Files\Microsoft VS Code\Code.exe'
if (-not (Test-Path -LiteralPath $codePath)) {
    throw "VS Code was not found at: $codePath"
}

$workspacePath = $PSScriptRoot
$samplePath = Join-Path $workspacePath 'test-files\preview_sample.c'
$userDataPath = Join-Path $workspacePath '.vscode-test\preview-user-data'
$settingsPath = Join-Path $userDataPath 'User\settings.json'

New-Item -ItemType Directory -Path (Split-Path -Parent $settingsPath) -Force | Out-Null
@{
    'window.autoDetectColorScheme' = $true
    'workbench.colorTheme' = 'Light Modern'
} | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8

$arguments = @(
    "--user-data-dir=`"$userDataPath`""
    "--extensionDevelopmentPath=`"$workspacePath`""
    '--new-window'
    "`"$workspacePath`""
    "`"$samplePath`""
)
$process = Start-Process -FilePath $codePath -ArgumentList $arguments -PassThru

Write-Host "VS Code preview window started (PID $($process.Id))."
Write-Host 'The window stays open after this launcher exits. In VS Code, run: CodeVisualizer: Open Flowchart'
[void](Read-Host 'Press Enter to close this launcher; VS Code will remain open')
