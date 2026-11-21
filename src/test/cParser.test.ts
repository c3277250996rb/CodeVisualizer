import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CAstParser } from "../core/language-services/c/CAstParser";
import { NodeType } from "../ir/ir";

suite("C flowchart parser", () => {
  let parser: CAstParser;

  suiteSetup(async () => {
    const wasmPath = path.join(__dirname, "../../dist/tree-sitter-c.wasm");
    parser = await CAstParser.create(wasmPath);
  });

  test("generates a flowchart for the commented C sample", () => {
    const samplePath = path.join(__dirname, "../../test-files/preview_sample.c");
    const source = fs.readFileSync(samplePath, "utf8");

    assert.ok(parser.listFunctions(source).includes("sum_positive"));

    const flowchart = parser.generateFlowchart(source, "sum_positive");

    assert.strictEqual(flowchart.title, "Flowchart for function: sum_positive");
    assert.ok(flowchart.nodes.some((node) => node.nodeType === NodeType.DECISION));
    assert.ok(flowchart.nodes.some((node) => node.label.includes("values[index]")));
    assert.ok(flowchart.edges.length > 0);
  });

  test("opens the sample with CodeVisualizer and captures the rendered flowchart", async function () {
    this.timeout(20000);
    console.log(`VSCODE_TEST_RUNTIME_VERSION=${vscode.version}`);
    assert.strictEqual(vscode.window.activeColorTheme.kind, vscode.ColorThemeKind.Light);

    const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
    assert.ok(extension, "CodeVisualizer extension should be available in the test host");
    await extension.activate();

    const samplePath = path.join(__dirname, "../../test-files/preview_sample.c");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const position = document.positionAt(document.getText().indexOf("int total"));
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const screenshotPath = path.join(os.tmpdir(), "CodeVisualizer-flowchart-e2e.png");
    const escapedScreenshotPath = screenshotPath.replace(/'/g, "''");
    const testUserDataPath = process.env.CODEVISUALIZER_TEST_USER_DATA;
    assert.ok(testUserDataPath, "Test user data directory should be configured by test.ps1");
    const escapedUserDataPath = testUserDataPath.replace(/'/g, "''");
    const captureScript = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TestWindow { [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }'",
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      `$target = Get-Process -Id ${process.ppid} -ErrorAction SilentlyContinue`,
      `$userDataPath = '${escapedUserDataPath}'`,
      `if (-not $target -or $target.MainWindowHandle -eq 0) { $targetProcess = Get-CimInstance Win32_Process -Filter "Name = 'Code.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($userDataPath) } | Select-Object -First 1; if ($targetProcess) { $target = Get-Process -Id $targetProcess.ProcessId -ErrorAction SilentlyContinue } }`,
      "if (-not $target -or $target.MainWindowHandle -eq 0) { throw 'Extension Development Host window was not found.' }",
      "[void][TestWindow]::ShowWindowAsync($target.MainWindowHandle, 9)",
      "$shell = New-Object -ComObject WScript.Shell",
      "if (-not $shell.AppActivate($target.Id)) { throw 'Could not activate the extension development host window.' }",
      "Start-Sleep -Milliseconds 500",
      "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)",
      "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
      "$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
      `$screenshotPath = '${escapedScreenshotPath}'`,
      "$bitmap.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)",
      "$graphics.Dispose()",
      "$bitmap.Dispose()",
      "Write-Output $screenshotPath",
    ].join("; ");
    const captureOutput = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", captureScript], {
      encoding: "utf8",
    });
    console.log(captureOutput.trim());

    assert.ok(fs.statSync(screenshotPath).size > 10000, "Screenshot should contain the rendered VS Code window");
    console.log(`FLOWCHART_E2E_SCREENSHOT=${screenshotPath}`);
  });
});