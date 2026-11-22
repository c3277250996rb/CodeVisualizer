$ErrorActionPreference = 'Stop'

$codePath = 'C:\Program Files\Microsoft VS Code\Code.exe'
if (-not (Test-Path -LiteralPath $codePath)) {
    throw "VS Code was not found at: $codePath"
}

$workspacePath = $PSScriptRoot
# 预览默认打开这个文件里的目标函数，光标落在函数里，流程图会自动分析它
$samplePath = Join-Path $workspacePath 'test-files\my_adc.c'
$targetFunction = 'MyAdc_SendTelemetry'
$userDataPath = Join-Path $workspacePath '.vscode-test\preview-user-data'
$settingsPath = Join-Path $userDataPath 'User\settings.json'

if (-not (Test-Path -LiteralPath $samplePath)) {
    throw "Sample file was not found at: $samplePath"
}

# 定位函数定义行（宁可匹配带花括号的定义行，也不要匹配到调用处）
$functionLine = 1
$sampleLines = Get-Content -LiteralPath $samplePath
for ($index = 0; $index -lt $sampleLines.Count; $index++) {
    $line = $sampleLines[$index]
    if ($line -match "\b$targetFunction\s*\(" -and $line -match '\{\s*$') {
        $functionLine = $index + 1
        break
    }
}

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
    "--goto=$samplePath`:$functionLine"
)
$process = Start-Process -FilePath $codePath -ArgumentList $arguments -PassThru

Write-Host "VS Code preview window started (PID $($process.Id))."
Write-Host "Opened: $samplePath -> $targetFunction (line $functionLine)"
Write-Host 'The window stays open after this launcher exits. In VS Code, run: CodeVisualizer: Open Flowchart'
[void](Read-Host 'Press Enter to close this launcher; VS Code will remain open')
