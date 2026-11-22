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
  const VARS_TEST = "VARS 变量面板跟随函数与文件刷新";

  suiteSetup(async () => {
    if (!selected(PARSER_TEST) && !selected(SMOKE_TEST) && !selected(VARS_TEST)) {
      return;
    }
    const wasmPath = path.join(__dirname, "../../dist/tree-sitter-c.wasm");
    parser = await CAstParser.create(wasmPath);
  });

  if (!selected(PARSER_TEST) && !selected(SMOKE_TEST) && !selected(VARS_TEST)) {
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
    assert.ok(flowchart.nodes.some((node) => node.nodeType === NodeType.DECISION));
    assert.ok(flowchart.edges.length > 0);
    // 注释当成代码识别：函数体里的注释会变成普通语句节点
    assert.ok(
      flowchart.nodes.some((node) => node.label.includes("Reject non-positive input")),
      "body 里的注释应该成为语句节点"
    );

    const mermaid = new EnhancedMermaidGenerator().generate(flowchart);
    assert.ok(!mermaid.includes("code-comment"), "不再有注释专用的渲染块");
    assert.ok(mermaid.includes("Reject non-positive input"), "注释作为代码出现在节点里");
    // 函数外的头注释不属于函数体语句，不应该进图
    assert.ok(!mermaid.includes("Function summary."));
    assert.ok(mermaid.includes(String.fromCodePoint(0x2714, 0xfe0f)));
    assert.ok(mermaid.includes(String.fromCodePoint(0x2716)));
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

  // 变量面板：切函数、切文件后 Locals/Globals 必须换成对应的数据
  if (selected(VARS_TEST)) {
    test(VARS_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉侧边栏/底部面板/辅助栏，实拍才看得清
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

      const adcPath = path.join(__dirname, "../../test-files/my_adc.c");
      const adcText = require("fs").readFileSync(adcPath, "utf8") as string;

      // 1) L3 断言：IR 必须带上实际分析的函数名，Locals 才是这个函数的
      const flowA = parser.generateFlowchart(adcText, "MyAdc_SendTelemetry");
      assert.strictEqual(flowA.functionName, "MyAdc_SendTelemetry", "IR 要记录分析的函数名");
      const varsA = parser.collectVariables(adcText, flowA.functionName);
      const namesA = varsA.locals.map((item) => item.name);
      assert.ok(namesA.includes("vref_centivolts"), `Locals 应包含 SendTelemetry 的局部变量: ${namesA}`);
      assert.ok(namesA.includes("values"), `Locals 应包含 values: ${namesA}`);

      // 2) L3 断言：换函数后 Locals 必须变
      const varsB = parser.collectVariables(adcText, "MyAdc_StartConversion");
      const namesB = varsB.locals.map((item) => item.name);
      assert.ok(namesB.includes("now_ticks"), `StartConversion 的 Locals 应有 now_ticks: ${namesB}`);
      assert.ok(!namesB.includes("vref_centivolts"), `切函数后不应该是上一个函数的变量: ${namesB}`);
      assert.notDeepStrictEqual(namesB, namesA, "两个函数的 Locals 不应该相同");

      // 3) L3 断言：换文件后 Globals 必须变
      const motorPath = path.join(__dirname, "../../test-files/my_motor.c");
      const motorText = require("fs").readFileSync(motorPath, "utf8") as string;
      const motorVars = parser.collectVariables(motorText, "MyMotor_Init");
      const adcGlobals = varsA.globals.map((item) => item.name);
      const motorGlobals = motorVars.globals.map((item) => item.name);
      assert.ok(motorGlobals.length > 0, "my_motor.c 应该有全局变量");
      assert.notDeepStrictEqual(motorGlobals, adcGlobals, "切文件后 Globals 不应该还是上一个文件的");

      // 4) 视觉证据：GLOBALS/LOCALS 卡片长在侧边栏视图里（面板只画图），
      //    所以这一步是"关无关 panel + 打开被测视图"，每个状态停留 1s 让 100ms 实拍拍到切换过程
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(adcPath));
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const firstFunction = document.getText().indexOf("MyAdc_SendTelemetry");
      const firstPosition = document.positionAt(firstFunction);
      editor.selection = new vscode.Selection(firstPosition, firstPosition);

      await tryCommand("codevisualizer.flowchartView.focus");
      // 侧边栏太窄时 GLOBALS/LOCALS 会被切断，实拍读不出来：先把视图拉宽再拍
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const secondFunction = document.getText().indexOf("MyAdc_StartConversion");
      assert.ok(secondFunction > firstFunction, "样例里应能找到第二个函数");
      const secondPosition = document.positionAt(secondFunction);
      editor.selection = new vscode.Selection(secondPosition, secondPosition);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 换文件：Globals 必须换成 my_motor.c 的
      const motorDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(motorPath));
      const motorEditor = await vscode.window.showTextDocument(motorDocument, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const motorFunction = motorDocument.getText().indexOf("MyMotor_Init");
      const motorPosition = motorDocument.positionAt(motorFunction);
      motorEditor.selection = new vscode.Selection(motorPosition, motorPosition);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await tryCommand("workbench.action.toggleFullScreen");
    });
  }
});
