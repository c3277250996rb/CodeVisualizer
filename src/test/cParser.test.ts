import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { EnhancedMermaidGenerator } from "../core/EnhancedMermaidGenerator";
import { CAstParser } from "../core/language-services/c/CAstParser";
import { NodeType } from "../ir/ir";

/** 轮询等待条件成立，替代固定 sleep，避免无意义等待 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite("C flowchart parser", () => {
  let parser: CAstParser;

  suiteSetup(async () => {
    const wasmPath = path.join(__dirname, "../../dist/tree-sitter-c.wasm");
    parser = await CAstParser.create(wasmPath);
  });

  test("generates a flowchart for the commented C sample", () => {
    const source = [
      "/* Function summary. */",
      "int sum_positive(int value) {",
      "  // Reject non-positive input.",
      "  if (value <= 0) { return 0; }",
      "  return value;",
      "}",
    ].join("\n");

    assert.ok(parser.listFunctions(source).includes("sum_positive"));

    const flowchart = parser.generateFlowchart(source, "sum_positive");

    assert.strictEqual(flowchart.title, "Flowchart for function: sum_positive");
    assert.strictEqual(flowchart.headerComment, "Function summary.");
    assert.strictEqual(flowchart.nodes.find((node) => node.nodeType === NodeType.ENTRY)?.comment, undefined);
    const decisionCommentNode = flowchart.nodes.find(
      (node) => node.nodeType === NodeType.DECISION && node.comment?.includes("Reject non-positive input")
    );
    assert.ok(decisionCommentNode);
    assert.ok(flowchart.nodes.some((node) => node.nodeType === NodeType.DECISION));
    assert.ok(flowchart.edges.length > 0);

    const mermaid = new EnhancedMermaidGenerator().generate(flowchart);
    assert.ok(mermaid.includes('class="code-comment"'));
    assert.ok(mermaid.includes("Reject non-positive input"));
    assert.ok(mermaid.includes(String.fromCodePoint(0x2714, 0xfe0f)));
    assert.ok(mermaid.includes(String.fromCodePoint(0x2716)));
    assert.ok(!mermaid.includes("- - - -"));
  });

  // 冒烟测试：命令能把 WebView 面板拉起来即可，不截图、不操作鼠标、不等固定时长
  test("opens the flowchart panel for the sample", async function () {
    this.timeout(20000);
    const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
    assert.ok(extension, "CodeVisualizer extension should be available in the test host");
    await extension.activate();

    const samplePath = path.join(__dirname, "../../test-files/motor_comment_sample.c");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const functionPosition = document.getText().indexOf("MyMotor_Init");
    assert.ok(functionPosition >= 0, "Sample should contain MyMotor_Init");
    const position = document.positionAt(functionPosition);
    editor.selection = new vscode.Selection(position, position);

    await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");

    // VS Code 会把面板 viewType 加上 mainThreadWebview- 之类的前缀，
    // 这里只比对后缀，否则会白等满 10 秒再误判失败
    const isFlowchartPanel = (candidate: vscode.Tab): boolean =>
      candidate.input instanceof vscode.TabInputWebview &&
      candidate.input.viewType.endsWith("codevisualizer.flowchartPanel");

    const tab = await waitFor(
      () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .find(isFlowchartPanel),
      10000
    );
    assert.ok(tab, "Flowchart webview panel should open");
    await vscode.window.tabGroups.close(tab);
  });
});
