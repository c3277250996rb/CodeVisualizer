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
  // test.ps1 -Only 会设置 CODEVISUALIZER_TEST_ONLY，只注册标题包含该关键字的用例
  const ONLY = (process.env.CODEVISUALIZER_TEST_ONLY || "").trim().toLowerCase();
  const selected = (title: string): boolean =>
    ONLY.length === 0 || title.toLowerCase().includes(ONLY);
  const PARSER_TEST = "generates a flowchart for the commented C sample";
  const SMOKE_TEST = "opens MyAdc_SendTelemetry and zooms into the loop";

  suiteSetup(async () => {
    if (!selected(PARSER_TEST) && !selected(SMOKE_TEST)) {
      return;
    }
    const wasmPath = path.join(__dirname, "../../dist/tree-sitter-c.wasm");
    parser = await CAstParser.create(wasmPath);
  });

  if (!selected(PARSER_TEST) && !selected(SMOKE_TEST)) {
    test("filter matched no tests", () => {
      assert.fail(`CODEVISUALIZER_TEST_ONLY="${ONLY}" 没有匹配的用例`);
    });
  }

  if (selected(PARSER_TEST)) {
  test(PARSER_TEST, () => {
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
  }

  // 冒烟测试：全屏打开 my_adc.c 的 MyAdc_SendTelemetry，再把循环放大，
  // 让 100ms 实拍能清楚录到真实渲染的画面
  if (selected(SMOKE_TEST)) {
  test(SMOKE_TEST, async function () {
    this.timeout(40000);
    const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
    assert.ok(extension, "CodeVisualizer extension should be available in the test host");
    await extension.activate();

    // 全屏 + 收起侧边栏/底部面板/辅助栏，画面只剩编辑器区，流程图才看得清
    const tryCommand = async (command: string): Promise<void> => {
      try {
        await vscode.commands.executeCommand(command);
      } catch (error) {
        console.warn(`Command ${command} failed: ${error}`);
      }
    };
    await tryCommand("workbench.action.toggleFullScreen");
    await tryCommand("workbench.action.closeSidebar");
    await tryCommand("workbench.action.closePanel");
    await tryCommand("workbench.action.closeAuxiliaryBar");

    const samplePath = path.join(__dirname, "../../test-files/my_adc.c");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    const functionPosition = document.getText().indexOf("MyAdc_SendTelemetry");
    assert.ok(functionPosition >= 0, "my_adc.c should contain MyAdc_SendTelemetry");
    const position = document.positionAt(functionPosition);
    editor.selection = new vscode.Selection(position, position);

    // 直接用同一份源码校验图源：循环继续线是 🔄，class 语句不能一行带多个类名
    const mermaid = new EnhancedMermaidGenerator().generate(
      parser.generateFlowchart(document.getText(), "MyAdc_SendTelemetry")
    );
    assert.ok(mermaid.includes(String.fromCodePoint(0x1f504)), "循环继续线应该渲染成 🔄");
    const multiClassLine = mermaid
      .split("\n")
      .find((line) => /^\s*class\s+\S+\s+\S+\s+\S+/.test(line));
    assert.ok(!multiClassLine, `class 语句每行只能带一个类名: ${multiClassLine}`);

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

    // 等 mermaid 渲染完再放大到循环，并停留 1s 让录屏拍下放大后的画面
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await vscode.commands.executeCommand("codevisualizer.focusLoopNode");
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await vscode.window.tabGroups.close(tab);
    await tryCommand("workbench.action.toggleFullScreen");
  });
  }
});
