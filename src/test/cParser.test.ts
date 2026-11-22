import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { EnhancedMermaidGenerator } from "../core/EnhancedMermaidGenerator";
import { CAstParser } from "../core/language-services/c/CAstParser";
import { applyFolds, planFoldRegions } from "../core/fold/CollapsePlanner";
import { analyzeCode } from "../core/analyzer";
import { initCLanguageService } from "../core/language-services/c";
import { FlowchartIR, NodeType } from "../ir/ir";

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
  const SWITCH_TEST = "SWITCH 切函数时清空画布并重置缩放";
  const ELSE_TEST = "ELSE else 与 else if 要识别成判断分支";
  const LOOPBODY_TEST = "LOOPBODY while 与 do-while 的循环体要逐条展开";
  const ESCAPE_TEST = "ESCAPE 代码里的 != 与反斜杠要原样显示";
  const OUTLINE_TEST = "OUTLINE 侧边栏只剩流程图视图";
  const FOLD_TEST = "FOLD 判断的 then 分支可以折叠";
  const ADCFUNCS_TEST = "ADCFUNCS my_adc.c 每个函数逐个校验";
  const GLOW_TEST = "GLOW 光标与点击驱动节点光晕";
  const FOLDDEFAULT_TEST = "FOLDDEFAULT 顶部复选框切换默认展开与折叠";

  const ANY_TEST = (): boolean =>
    selected(PARSER_TEST) ||
    selected(SMOKE_TEST) ||
    selected(VARS_TEST) ||
    selected(SWITCH_TEST) ||
    selected(ELSE_TEST) ||
    selected(LOOPBODY_TEST) ||
    selected(ESCAPE_TEST) ||
    selected(OUTLINE_TEST) ||
    selected(FOLD_TEST) ||
    selected(ADCFUNCS_TEST) ||
    selected(GLOW_TEST) ||
    selected(FOLDDEFAULT_TEST);

  suiteSetup(async () => {
    if (!ANY_TEST()) {
      return;
    }
    const wasmPath = path.join(__dirname, "../../dist/tree-sitter-c.wasm");
    parser = await CAstParser.create(wasmPath);
  });

  if (!ANY_TEST()) {
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

  // 切函数：画布必须清空重画、缩放回到整图（不能把上一个函数放大后的视口带过来）
  if (selected(SWITCH_TEST)) {
    test(SWITCH_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉无关面板，实拍才看得清
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

      // 1) L2 断言：两个函数的图源确实不同（第一个函数有 for/while，第二个没有）
      const flowA = parser.generateFlowchart(adcText, "MyAdc_SendTelemetry");
      const flowB = parser.generateFlowchart(adcText, "MyAdc_StartConversion");
      const mermaidA = new EnhancedMermaidGenerator().generate(flowA);
      const mermaidB = new EnhancedMermaidGenerator().generate(flowB);
      assert.ok(mermaidA.includes("for_init_"), "SendTelemetry 的图里应有 for 循环节点");
      assert.ok(mermaidA.includes("end loop"), "SendTelemetry 的图里应有循环收尾节点");
      assert.ok(!mermaidB.includes("for_init_"), "StartConversion 的图里不该有 for 循环节点");
      assert.notStrictEqual(mermaidA, mermaidB, "两个函数必须产出不同的图源");

      // 2) 打开编辑器 + 把图表面板开到侧边（不改编辑器所在列，编辑器对象一直有效）
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(adcPath));
      let editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const firstFunction = document.getText().indexOf("MyAdc_SendTelemetry");
      const firstPosition = document.positionAt(firstFunction);
      editor.selection = new vscode.Selection(firstPosition, firstPosition);

      await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
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

      // 3) 视觉证据一：先放大到循环，画面变成局部大图
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await vscode.commands.executeCommand("codevisualizer.focusLoopNode");
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 4) 视觉证据二：光标切到另一个函数 → 画布清空重画 + 缩放回到整图
      const secondFunction = document.getText().indexOf("MyAdc_StartConversion");
      assert.ok(secondFunction > firstFunction, "样例里应能找到第二个函数");
      // 面板抢焦点后重新把这个编辑器唤回可见，选区变更才会真正派发
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const secondPosition = document.positionAt(secondFunction);
      editor.selection = new vscode.Selection(secondPosition, secondPosition);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await vscode.window.tabGroups.close(tab);
      await tryCommand("workbench.action.toggleFullScreen");
    });
  }

  // else / else if：必须各自成为判断分支，不能退化成一条 "else ..." 普通语句
  if (selected(ELSE_TEST)) {
    test(ELSE_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉无关面板
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

      const motorPath = path.join(__dirname, "../../test-files/my_motor.c");
      const motorText = require("fs").readFileSync(motorPath, "utf8") as string;
      const ir = parser.generateFlowchart(motorText, "MyMotor_UpdateCurrentSample");

      // 1) L3：else / else if 不能变成普通语句节点
      const strayElse = ir.nodes.filter((node) => /^\s*else\b/i.test(node.label));
      assert.deepStrictEqual(
        strayElse.map((node) => node.label),
        [],
        "else / else if 不能被当成普通语句"
      );

      // 2) L3：else if 的条件本身要是一个判断节点
      const elseIfDecision = ir.nodes.find(
        (node) =>
          node.nodeType === NodeType.DECISION &&
          node.label.includes("stall_overcurrent_since_ticks")
      );
      assert.ok(elseIfDecision, "else if 的条件应该成为 decision 节点");

      // 3) L3：外层 if 的 False 分支要连到 else if 判断节点，True 分支连到刹车动作
      const outerDecision = ir.nodes.find(
        (node) =>
          node.nodeType === NodeType.DECISION &&
          node.label.includes("stall_overcurrent_active == 0U")
      );
      assert.ok(outerDecision, "外层 if 条件应该是 decision 节点");
      const falseEdge = ir.edges.find(
        (edge) => edge.from === outerDecision!.id && /^false$/i.test(edge.label || "")
      );
      assert.ok(falseEdge, "外层 if 必须有一条 False 分支");
      assert.strictEqual(
        falseEdge!.to,
        elseIfDecision!.id,
        "外层 if 的 False 分支应指向 else if 的判断节点"
      );
      const elseIfTrue = ir.edges.find(
        (edge) => edge.from === elseIfDecision!.id && /^true$/i.test(edge.label || "")
      );
      assert.ok(elseIfTrue, "else if 必须有 True 分支");
      const brakeNode = ir.nodes.find((node) => node.id === elseIfTrue!.to);
      assert.ok(
        brakeNode && brakeNode.label.includes("MyMotor_ApplyStallBrake"),
        `else if 的 True 分支应通往刹车动作，实际是: ${brakeNode && brakeNode.label}`
      );

      // 4) L2：图源里 else if 的条件出现在判断节点上，分支箭头是 ✖
      const mermaid = new EnhancedMermaidGenerator().generate(ir);
      assert.ok(mermaid.includes("stall_overcurrent_since_ticks"), "图源里应有 else if 的条件");
      assert.ok(
        !/-- "else/i.test(mermaid),
        "图源里不应该出现 else 标签的普通边"
      );
      assert.ok(
        mermaid.includes(String.fromCodePoint(0x2716)),
        "else 分支要渲染成 ✖"
      );

      // 5) L3：同一文件里的普通 else 也必须变成分支
      const unescape = (text: string): string =>
        text.replace(/#60;/g, "<").replace(/#62;/g, ">");
      const dutyIr = parser.generateFlowchart(motorText, "MyMotor_UpdateDuty");
      assert.deepStrictEqual(
        dutyIr.nodes.filter((node) => /^\s*else\b/i.test(node.label)).map((node) => node.label),
        [],
        "普通 else 也不能被当成普通语句"
      );
      const dutyDecision = dutyIr.nodes.find(
        (node) =>
          node.nodeType === NodeType.DECISION &&
          unescape(node.label).includes("motor_duty_percent < motor_target_duty_percent")
      );
      assert.ok(dutyDecision, "占空比小于目标的判断应是 decision 节点");
      const dutyElseBody = dutyIr.nodes.find((node) =>
        node.label.includes("motor_duty_percent--")
      );
      assert.ok(dutyElseBody, "else 分支里的语句要成为独立节点");
      assert.ok(
        dutyIr.edges.some(
          (edge) =>
            edge.from === dutyDecision!.id &&
            edge.to === dutyElseBody!.id &&
            /^false$/i.test(edge.label || "")
        ),
        "else 的语句必须挂在 False 分支上"
      );

      // 6) L4：用同文件里更小的 MyMotor_UpdateDuty 做画面证据（整图能看清两个 else 分支）
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(motorPath));
      let editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const fnPosition = document.getText().indexOf("MyMotor_UpdateDuty");
      assert.ok(fnPosition >= 0, "my_motor.c 应包含 MyMotor_UpdateDuty");
      const cursor = document.positionAt(fnPosition);
      editor.selection = new vscode.Selection(cursor, cursor);

      await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
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

      await new Promise((resolve) => setTimeout(resolve, 1500));
      // 面板抢焦后唤回编辑器，确保渲染的就是这个函数
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      editor.selection = new vscode.Selection(cursor, cursor);
      // 窄栏里节点文字太小，按 skill 要求先把面板那一列拉宽再实拍
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await vscode.window.tabGroups.close(tab);
      await tryCommand("workbench.action.toggleFullScreen");
    });
  }

  // 循环体：while / do-while 的 {} 里必须逐条语句成节点，不能压成一整块
  if (selected(LOOPBODY_TEST)) {
    test(LOOPBODY_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉无关面板
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

      // 1) L3：用户报的 MyAdc_SendTelemetry 循环体不能塌成一块
      const adcPath = path.join(__dirname, "../../test-files/my_adc.c");
      const adcText = require("fs").readFileSync(adcPath, "utf8") as string;
      const adcIr = parser.generateFlowchart(adcText, "MyAdc_SendTelemetry");
      const collapsed = adcIr.nodes.filter((node) => /^\s*\{/.test(node.label));
      assert.deepStrictEqual(
        collapsed.map((node) => node.label.slice(0, 60)),
        [],
        "循环体不能被压成一整块语句"
      );
      const whileBody = adcIr.nodes.find((node) => node.label.includes("digits[--count]"));
      assert.ok(whileBody, "while 循环体里的写字节语句要独立成节点");
      const doBodyDigits = adcIr.nodes.find((node) => node.label.includes("digits[count++]"));
      const doBodyDivide = adcIr.nodes.find((node) => node.label.includes("whole /= 10U"));
      assert.ok(doBodyDigits, "do-while 体里的写数字语句要独立成节点");
      assert.ok(doBodyDivide, "do-while 体里的移位语句要独立成节点");
      assert.notStrictEqual(
        doBodyDigits!.id,
        doBodyDivide!.id,
        "do-while 体内的两条语句要分成两个节点"
      );
      const whileDecision = adcIr.nodes.find(
        (node) => node.nodeType === NodeType.DECISION && node.label.includes("count != 0U")
      );
      assert.ok(whileDecision, "while 的条件应是 decision 节点");
      assert.ok(
        adcIr.edges.some(
          (edge) =>
            edge.from === whileDecision!.id &&
            edge.to === whileBody!.id &&
            /^true$/i.test(edge.label || "")
        ),
        "while 的 True 分支要指向循环体第一条语句"
      );
      assert.ok(
        adcIr.edges.some(
          (edge) => edge.from === whileBody!.id && edge.to === whileDecision!.id
        ),
        "循环体末尾要回到 while 条件"
      );
      assert.ok(
        adcIr.edges.some(
          (edge) => edge.from === doBodyDigits!.id && edge.to === doBodyDivide!.id
        ),
        "do-while 体内的语句要顺序相连"
      );

      // 2) L2：图源里没有以 { 开头的整块节点
      const adcMermaid = new EnhancedMermaidGenerator().generate(adcIr);
      assert.ok(adcMermaid.includes("digits[--count]"), "图源里应有 while 体的语句");
      assert.ok(!/">\s*\{/.test(adcMermaid), "图源里不应出现整块花括号语句");

      // 3) L3：专向小样例里 while 与 do-while 体都要逐条展开
      const samplePath = path.join(__dirname, "../../test-files/loop_body_sample.c");
      const sampleText = require("fs").readFileSync(samplePath, "utf8") as string;
      const whileIr = parser.generateFlowchart(sampleText, "while_body_sample");
      const doIr = parser.generateFlowchart(sampleText, "do_body_sample");
      for (const [name, sampleIr] of [
        ["while_body_sample", whileIr],
        ["do_body_sample", doIr],
      ] as const) {
        assert.deepStrictEqual(
          sampleIr.nodes
            .filter((node) => /^\s*\{/.test(node.label))
            .map((node) => node.label.slice(0, 40)),
          [],
          `${name} 里不能出现整块花括号节点`
        );
      }
      const totalAdd = whileIr.nodes.find((node) => node.label.includes("total += guard"));
      const guardInc = whileIr.nodes.find((node) => node.label.includes("guard++"));
      const totalSub = doIr.nodes.find((node) => node.label.includes("total -= 2"));
      const doGuardInc = doIr.nodes.find((node) => node.label.includes("guard++"));
      assert.ok(totalAdd && guardInc, "while 体的两条语句要各自成节点");
      assert.ok(totalSub && doGuardInc, "do-while 体的两条语句要各自成节点");
      assert.ok(
        whileIr.edges.some(
          (edge) => edge.from === totalAdd!.id && edge.to === guardInc!.id
        ),
        "while 体内两条语句要顺序相连"
      );
      assert.ok(
        doIr.edges.some(
          (edge) => edge.from === totalSub!.id && edge.to === doGuardInc!.id
        ),
        "do-while 体内两条语句要顺序相连"
      );

      // 4) L4：do-while 图小，整图 + 停留让 100ms 实拍看清循环体与回边
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
      let editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const fnPosition = document.getText().indexOf("while_body_sample");
      assert.ok(fnPosition >= 0, "样例里应有 while_body_sample");
      const cursor = document.positionAt(fnPosition);
      editor.selection = new vscode.Selection(cursor, cursor);

      await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
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

      await new Promise((resolve) => setTimeout(resolve, 1500));
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      editor.selection = new vscode.Selection(cursor, cursor);
      // 窄栏里文字太小，先把面板那一列拉宽再实拍
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 再切到 do-while 样例，同一轮录屏里两张小图都能看清
      const doPosition = document.getText().indexOf("do_body_sample");
      assert.ok(doPosition > fnPosition, "样例里应有 do_body_sample");
      const doCursor = document.positionAt(doPosition);
      editor.selection = new vscode.Selection(doCursor, doCursor);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await vscode.window.tabGroups.close(tab);
      await tryCommand("workbench.action.toggleFullScreen");
    });
  }

  // 转义：!= 不能变成不等号，字符串里的反斜杠不能叠成两个
  if (selected(ESCAPE_TEST)) {
    test(ESCAPE_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉无关面板
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

      const samplePath = path.join(__dirname, "../../test-files/escape_sample.c");
      const sampleText = require("fs").readFileSync(samplePath, "utf8") as string;
      const ir = parser.generateFlowchart(sampleText, "escape_sample");

      // 1) L3：IR 里 != 保持原文，反斜杠只用实体编码一次
      const conditionNode = ir.nodes.find((node) => node.label.includes("value"));
      assert.ok(conditionNode, "样例里应有 value 的判断节点");
      assert.ok(conditionNode!.label.includes("!="), `!= 不能变形: ${conditionNode!.label}`);
      assert.ok(
        !conditionNode!.label.includes(String.fromCodePoint(0x2260)),
        `!= 不能渲染成不等号: ${conditionNode!.label}`
      );
      const writeNode = ir.nodes.find((node) => node.label.includes("MyUart_WriteString"));
      assert.ok(writeNode, "样例里应有写字符串节点");
      assert.ok(
        !writeNode!.label.includes("\\\\"),
        `反斜杠不能叠成两个: ${writeNode!.label}`
      );
      assert.ok(
        writeNode!.label.includes("#92;r#92;n"),
        `反斜杠应编码成单次实体: ${writeNode!.label}`
      );

      // 2) L2：图源里同样不能出现双反斜杠或不等号
      const mermaid = new EnhancedMermaidGenerator().generate(ir);
      assert.ok(mermaid.includes("!="), "图源里 != 必须保持原文");
      assert.ok(
        !mermaid.includes(String.fromCodePoint(0x2260)),
        "图源里不能出现不等号"
      );
      assert.ok(!mermaid.includes("\\\\"), "图源里不能出现双反斜杠");

      // 3) L4：小样例整图，实拍确认 != 与 \r\n 原样显示
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
      let editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const fnPosition = document.getText().indexOf("escape_sample");
      assert.ok(fnPosition >= 0, "样例里应有 escape_sample");
      const cursor = document.positionAt(fnPosition);
      editor.selection = new vscode.Selection(cursor, cursor);

      await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
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

      await new Promise((resolve) => setTimeout(resolve, 1500));
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      editor.selection = new vscode.Selection(cursor, cursor);
      // 窄栏里文字太小，先把面板那一列拉宽再实拍
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await vscode.window.tabGroups.close(tab);
      await tryCommand("workbench.action.toggleFullScreen");
    });
  }

  // 侧边栏只保留流程图视图：Outline 树与它的跳转命令都已删除
  if (selected(OUTLINE_TEST)) {
    test(OUTLINE_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉无关面板
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

      // 1) L3：清单里 codevisualizer-container 只剩 flowchartView
      const contributes = (extension.packageJSON as { contributes?: { views?: Record<string, { id: string }[]> } })
        .contributes;
      const containerViews = contributes?.views?.["codevisualizer-container"] ?? [];
      assert.deepStrictEqual(
        containerViews.map((view) => view.id),
        ["codevisualizer.flowchartView"],
        "CodeVisualizer 容器只能声明流程图这一个视图"
      );

      // 2) L3：导航命令已经不存在
      const commands = await vscode.commands.getCommands(true);
      assert.ok(
        !commands.includes("codevisualizer.revealOutlineNode"),
        "revealOutlineNode 命令必须随 Outline 一起删除"
      );

      // 3) L4：打开侧边栏，画面里只有 Flowchart，没有 Outline 分区
      const adcPath = path.join(__dirname, "../../test-files/escape_sample.c");
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(adcPath));
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const fnPosition = document.getText().indexOf("escape_sample");
      const cursor = document.positionAt(Math.max(fnPosition, 0));
      editor.selection = new vscode.Selection(cursor, cursor);

      await tryCommand("codevisualizer.flowchartView.focus");
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await tryCommand("workbench.action.toggleFullScreen");
    });
  }

  // 折叠：只折 ✔️（then）分支，默认全展开，点节点角标触发展开/折叠
  if (selected(FOLD_TEST)) {
    test(FOLD_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉无关面板
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

      const samplePath = path.join(__dirname, "../../test-files/fold_sample.c");
      const sampleText = require("fs").readFileSync(samplePath, "utf8") as string;

      // 1) L3：规划器只认 then 分支、且要求单出口
      const ir = parser.generateFlowchart(sampleText, "fold_sample");
      const regions = planFoldRegions(ir);
      const anchor = ir.nodes.find(
        (node) => node.nodeType === NodeType.DECISION && node.label.includes("value #62; 10")
      ) ?? ir.nodes.find((node) => node.nodeType === NodeType.DECISION);
      assert.ok(anchor, "样例里应有 if 判断节点");
      const region = regions.find((item) => item.anchorId === anchor!.id);
      assert.ok(region, "then 分支应被识别成可折叠区域");
      assert.strictEqual(region!.statementCount, 3, "then 分支有 3 条语句");
      assert.strictEqual(region!.exitTargets.length, 1, "区域必须只有一个出口");
      const elseNode = ir.nodes.find((node) => node.label.includes("total = value;"));
      assert.ok(elseNode, "样例里应有 else 的语句");
      assert.ok(
        !region!.memberIds.includes(elseNode!.id),
        "else 分支不能被算进 then 区域"
      );
      // 由 else 分支进入合并点时，该区域必须被判定为不可折叠
      const multiIr = parser.generateFlowchart(sampleText, "fold_multi_exit_sample");
      const multiRegions = planFoldRegions(multiIr);
      for (const multiRegion of multiRegions) {
        assert.strictEqual(
          multiRegion.exitTargets.length,
          1,
          "多出口区域不允许折叠"
        );
      }

      // 2) L3：折叠后成员被摘要节点替代，边重新接到摘要节点
      const collapsedIr = applyFolds(ir, new Set([anchor!.id]));
      assert.strictEqual(
        collapsedIr.nodes.length,
        ir.nodes.length - region!.memberIds.length + 1,
        "折叠后节点数应为 原节点 - 成员 + 1 个摘要"
      );
      for (const memberId of region!.memberIds) {
        assert.ok(
          !collapsedIr.nodes.some((node) => node.id === memberId),
          `成员节点应被隐藏: ${memberId}`
        );
      }
      const summary = collapsedIr.nodes.find(
        (node) => node.fold?.summary === true
      );
      assert.ok(summary, "折叠后应有摘要节点");
      assert.ok(
        summary!.label.includes(`共 ${region!.statementCount} 步`),
        `摘要应标明被折叠的语句数: ${summary!.label}`
      );
      const anchorAfter = collapsedIr.nodes.find((node) => node.id === anchor!.id);
      assert.ok(anchorAfter?.fold, "锚点要带折叠信息");
      assert.strictEqual(anchorAfter!.fold!.collapsed, true, "锚点应标记为已折叠");
      assert.ok(
        collapsedIr.edges.some(
          (edge) => edge.from === anchor!.id && edge.to === summary!.id
        ),
        "锚点要连到摘要节点"
      );
      assert.ok(
        collapsedIr.edges.some(
          (edge) =>
            edge.from === summary!.id && edge.to === region!.exitTargets[0]
        ),
        "摘要节点要接回区域出口"
      );
      assert.ok(
        !collapsedIr.locationMap.some((entry) =>
          region!.memberIds.includes(entry.nodeId)
        ),
        "隐藏节点不应再出现在 locationMap"
      );

      // 3) L2：图源里有折叠钮与折叠类名，且不再出现被隐藏的语句
      const mermaid = new EnhancedMermaidGenerator().generate(collapsedIr);
      assert.ok(mermaid.includes("node-folded"), "折叠后的节点要有 node-folded 类（webview 据此画角标）");
      assert.ok(
        !mermaid.includes("MyUart_WriteString"),
        "被折叠的语句不应再出现在图源里"
      );

      // 3.1) 大函数 MyAdc_SendTelemetry：没有 if，只能折 for 循环体
      const adcPath = path.join(__dirname, "../../test-files/my_adc.c");
      const adcText = require("fs").readFileSync(adcPath, "utf8") as string;
      const adcIr = parser.generateFlowchart(adcText, "MyAdc_SendTelemetry");

      // switch 里的 break 必须汇到 switch 自己的出口，不能直接跳到函数 End
      const breakNodes = adcIr.nodes.filter(
        (node) => node.nodeType === NodeType.BREAK_CONTINUE
      );
      assert.ok(breakNodes.length >= 4, `switch 里应有 break 节点，实际 ${breakNodes.length}`);
      for (const breakNode of breakNodes) {
        const outEdge = adcIr.edges.find((edge) => edge.from === breakNode.id);
        assert.ok(outEdge, `break 必须有出边: ${breakNode.id}`);
        assert.notStrictEqual(
          outEdge!.to,
          adcIr.exitNodeId,
          `switch 的 break 不能跳到函数 End: ${breakNode.id}`
        );
        assert.ok(
          outEdge!.to.startsWith("switch_exit"),
          `break 应汇到 switch 出口，实际 ${outEdge!.to}`
        );
      }
      assert.ok(
        adcIr.nodes.some((node) => node.id.startsWith("switch_exit")),
        "switch 需要一个自己的汇合出口节点"
      );

      // for 循环体是唯一可折叠区域，且只能靠回边收尾（不能吞掉循环之后的语句）
      const adcRegions = planFoldRegions(adcIr);
      const forRegion = adcRegions.find((item) => item.anchorId.startsWith("for_cond"));
      assert.ok(forRegion, "for 循环体应被识别成可折叠区域");
      assert.ok(
        forRegion!.statementCount >= 20,
        `循环体语句数应该很可观，实际 ${forRegion!.statementCount}`
      );
      assert.deepStrictEqual(forRegion!.exitTargets, [], "循环体只应有回边，没有外部出口");
      const tailStatement = adcIr.nodes.find((node) => node.label.includes("V#92;r#92;n"));
      assert.ok(tailStatement, "函数末尾应有 V\\r\\n 的写串语句");
      assert.ok(
        !forRegion!.memberIds.includes(tailStatement!.id),
        "折叠区域不能吞掉循环之后的语句"
      );

      const adcCollapsed = applyFolds(adcIr, new Set([forRegion!.anchorId]));
      assert.ok(
        adcCollapsed.nodes.length < adcIr.nodes.length,
        "折叠后节点应减少"
      );
      const adcIds = new Set(adcCollapsed.nodes.map((node) => node.id));
      assert.deepStrictEqual(
        adcCollapsed.edges
          .filter((edge) => !adcIds.has(edge.from) || !adcIds.has(edge.to))
          .map((edge) => `${edge.from}->${edge.to}`),
        [],
        "折叠后不能出现悬空边"
      );
      assert.ok(
        adcCollapsed.nodes.some((node) => node.id === adcIr.exitNodeId),
        "折叠后仍要保留函数 End 节点"
      );
      const adcSummary = adcCollapsed.nodes.find((node) => node.fold?.summary === true);
      assert.ok(adcSummary, "折叠后应有摘要节点");
      assert.ok(
        adcCollapsed.edges.some(
          (edge) => edge.from === adcSummary!.id && edge.to === forRegion!.anchorId
        ),
        "摘要要保留回边到循环条件"
      );
      assert.ok(
        adcCollapsed.edges.some(
          (edge) =>
            edge.from === forRegion!.anchorId &&
            edge.to === adcSummary!.id &&
            /^true$/i.test(edge.label || "")
        ),
        "循环条件的 True 分支要指向摘要节点"
      );

      // 4) L4：用大函数 MyAdc_SendTelemetry 实拍展开态 → 点击角标折叠 → 再点击展开
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(adcPath));
      let editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const fnPosition = document.getText().indexOf("MyAdc_SendTelemetry");
      assert.ok(fnPosition >= 0, "样例里应有 MyAdc_SendTelemetry");
      const cursor = document.positionAt(fnPosition);
      editor.selection = new vscode.Selection(cursor, cursor);

      await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
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

      await new Promise((resolve) => setTimeout(resolve, 1500));
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      editor.selection = new vscode.Selection(cursor, cursor);
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await vscode.commands.executeCommand("codevisualizer.debugFoldClick");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await vscode.commands.executeCommand("codevisualizer.debugFoldClick");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      await vscode.window.tabGroups.close(tab);
      await tryCommand("workbench.action.toggleFullScreen");
    });
  }

  // 顶部复选框：决定分支默认展开还是默认折叠
  if (selected(FOLDDEFAULT_TEST)) {
    test(FOLDDEFAULT_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

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

      // 1) L3：配置项在 package.json 里声明，默认折叠（false）
      const manifest = require("../../package.json");
      const property =
        manifest.contributes.configuration.properties["codevisualizer.defaultExpandBranches"];
      assert.ok(property, "package.json 要声明 codevisualizer.defaultExpandBranches");
      assert.strictEqual(property.type, "boolean", "配置项应为 boolean");
      assert.strictEqual(property.default, false, "默认应为折叠（false）");

      const config = vscode.workspace.getConfiguration("codevisualizer");
      const original = config.get<boolean>("defaultExpandBranches", false);
      const setDefault = async (expanded: boolean): Promise<void> => {
        await config.update(
          "defaultExpandBranches",
          expanded,
          vscode.ConfigurationTarget.Global
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));
      };

      try {
        // 2) L1：打开样例函数，先按默认（折叠）实拍
        const samplePath = path.join(__dirname, "../../test-files/fold_sample.c");
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(samplePath)
        );
        let editor = await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.One,
          preview: false,
        });
        const ifPosition = document.getText().indexOf("if (value > 10)");
        assert.ok(ifPosition >= 0, "样例里应有 if (value > 10)");
        const cursor = document.positionAt(ifPosition);
        editor.selection = new vscode.Selection(cursor, cursor);

        await setDefault(false);
        await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
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

        await new Promise((resolve) => setTimeout(resolve, 1500));
        editor = await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.One,
          preview: false,
        });
        editor.selection = new vscode.Selection(cursor, cursor);
        await tryCommand("workbench.action.increaseViewSize");
        await tryCommand("workbench.action.increaseViewSize");
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 3) L3：折叠态图源里应出现摘要节点
        const parserLocal = await CAstParser.create(
          path.join(__dirname, "../../dist/tree-sitter-c.wasm")
        );
        const sampleText = document.getText();
        const ir = parserLocal.generateFlowchart(sampleText, "fold_sample");
        const regions = planFoldRegions(ir);
        assert.ok(regions.length > 0, "样例里应有可折叠区域");
        const collapsedIr = applyFolds(
          ir,
          new Set(regions.map((region) => region.anchorId))
        );
        assert.ok(
          collapsedIr.nodes.some((node) => node.fold?.summary === true),
          "折叠态应生成摘要节点"
        );
        assert.ok(
          applyFolds(ir, new Set()).nodes.length === ir.nodes.length,
          "展开态不应隐藏任何节点"
        );

        // 4) L1：点击顶部复选框 → 默认展开 → 图重画成展开态
        await vscode.commands.executeCommand("codevisualizer.debugFoldDefaultClick");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.strictEqual(
          vscode.workspace
            .getConfiguration("codevisualizer")
            .get<boolean>("defaultExpandBranches", false),
          true,
          "点一次复选框后配置应切到默认展开"
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // 5) L1：再点一次复选框 → 回到默认折叠
        await vscode.commands.executeCommand("codevisualizer.debugFoldDefaultClick");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.strictEqual(
          vscode.workspace
            .getConfiguration("codevisualizer")
            .get<boolean>("defaultExpandBranches", false),
          false,
          "再点一次复选框应回到默认折叠"
        );
        await new Promise((resolve) => setTimeout(resolve, 1500));

        await vscode.window.tabGroups.close(tab);
      } finally {
        await config.update(
          "defaultExpandBranches",
          original,
          vscode.ConfigurationTarget.Global
        );
        await tryCommand("workbench.action.toggleFullScreen");
      }
    });
  }

  // my_adc.c 全量函数结构校验 + 逐个渲染实拍
  if (selected(ADCFUNCS_TEST)) {
    test(ADCFUNCS_TEST, async function () {
      this.timeout(60000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉无关面板
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
      const functions = parser.listFunctions(adcText);
      assert.ok(functions.length >= 6, `my_adc.c 应有至少 6 个函数，实际 ${functions.length}`);

      // analyzeCode 走的是语言服务注册表，测试进程里要自己初始化一次
      await initCLanguageService(path.join(__dirname, "../../dist/tree-sitter-c.wasm"));

      // 1) L3：逐函数结构 + 折叠不变量
      const reachableFrom = (startId: string, edges: { from: string; to: string }[]): Set<string> => {
        const out = new Map<string, string[]>();
        for (const edge of edges) {
          const list = out.get(edge.from);
          if (list) {
            list.push(edge.to);
          } else {
            out.set(edge.from, [edge.to]);
          }
        }
        const seen = new Set<string>();
        const stack = [startId];
        while (stack.length > 0) {
          const id = stack.pop() as string;
          if (seen.has(id)) {
            continue;
          }
          seen.add(id);
          for (const next of out.get(id) ?? []) {
            stack.push(next);
          }
        }
        return seen;
      };

      // 单个函数的结构 + 折叠不变量；raw 与 merged 两套 IR 共用
      const checkIr = (label: string, ir: FlowchartIR): void => {
        const ids = new Set(ir.nodes.map((node) => node.id));
        assert.ok(ir.nodes.length >= 2, `${label} 至少要有 Start/End`);
        assert.ok(
          ir.nodes.some((node) => node.id === ir.entryNodeId && node.label === "Start"),
          `${label} 缺少 Start 节点`
        );
        assert.ok(
          ir.nodes.some((node) => node.id === ir.exitNodeId && node.label === "End"),
          `${label} 缺少 End 节点`
        );
        assert.deepStrictEqual(
          ir.edges
            .filter((edge) => !ids.has(edge.from) || !ids.has(edge.to))
            .map((edge) => `${edge.from}->${edge.to}`),
          [],
          `${label} 存在悬空边`
        );
        assert.deepStrictEqual(
          ir.nodes
            .filter((node) => /^\s*\{/.test(node.label) || /^\s*else\b/i.test(node.label))
            .map((node) => node.label),
          [],
          `${label} 存在整块花括号 / else 语句节点`
        );
        for (const breakNode of ir.nodes.filter(
          (node) => node.nodeType === NodeType.BREAK_CONTINUE
        )) {
          const outEdge = ir.edges.find((edge) => edge.from === breakNode.id);
          assert.ok(outEdge, `${label} 的 ${breakNode.id} 没有出边`);
          assert.notStrictEqual(
            outEdge!.to,
            ir.exitNodeId,
            `${label} 的 ${breakNode.id} 不能直连 End`
          );
        }

        const regions = planFoldRegions(ir);
        for (const region of regions) {
          const falseEdge = ir.edges.find(
            (edge) => edge.from === region.anchorId && /^false$/i.test(edge.label || "")
          );
          const falseReach = falseEdge
            ? reachableFrom(falseEdge.to, ir.edges)
            : new Set<string>();
          for (const target of region.exitTargets) {
            assert.ok(
              falseReach.has(target),
              `${label}: 区域 ${region.anchorId} 的出口 ${target} 不在 false 分支可达集合里`
            );
          }
          assert.ok(
            !region.memberIds.includes(ir.entryNodeId!) &&
              !region.memberIds.includes(ir.exitNodeId!),
            `${label}: 区域 ${region.anchorId} 不能包含 Start/End`
          );
        }
        const collapsed = applyFolds(ir, new Set(regions.map((region) => region.anchorId)));
        const collapsedIds = new Set(collapsed.nodes.map((node) => node.id));
        assert.deepStrictEqual(
          collapsed.edges
            .filter((edge) => !collapsedIds.has(edge.from) || !collapsedIds.has(edge.to))
            .map((edge) => `${edge.from}->${edge.to}`),
          [],
          `${label}: 折叠后出现悬空边`
        );
        assert.ok(
          collapsed.nodes.some((node) => node.id === ir.entryNodeId),
          `${label}: 折叠后丢了 Start`
        );
        assert.ok(
          collapsed.nodes.some((node) => node.id === ir.exitNodeId),
          `${label}: 折叠后丢了 End`
        );
        for (const summary of collapsed.nodes.filter((node) => node.fold?.summary === true)) {
          assert.ok(
            collapsed.edges.some((edge) => edge.from === summary.id),
            `${label}: 摘要节点 ${summary.id} 没有出边`
          );
          assert.ok(
            collapsed.edges.some((edge) => edge.to === summary.id),
            `${label}: 摘要节点 ${summary.id} 没有入边`
          );
        }
      };

      for (const name of functions) {
        checkIr(name, parser.generateFlowchart(adcText, name));
        // UI 实际用的是 analyzeCode 合并后的 IR，两套都要过同一套不变量
        const offset = adcText.indexOf(name);
        const merged = await analyzeCode(adcText, "c", name, Math.max(offset, 0));
        checkIr(`${name}(merged)`, merged);
      }

      // 2) L4：逐个函数渲染实拍（切函数会重置缩放，每张都是整图）
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(adcPath));
      let editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const firstOffset = document.getText().indexOf(functions[0]);
      const firstPosition = document.positionAt(Math.max(firstOffset, 0));
      editor.selection = new vscode.Selection(firstPosition, firstPosition);

      await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
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

      await new Promise((resolve) => setTimeout(resolve, 1500));
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      // 图窄了节点文字读不出来：先关掉侧边栏，再把面板列拉宽
      await tryCommand("workbench.action.closeSidebar");
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      for (const name of functions) {
        const offset = document.getText().indexOf(name);
        const position = document.positionAt(Math.max(offset, 0));
        editor.selection = new vscode.Selection(position, position);
        // 每个函数停留 1.2s，让 100ms 实拍拍到它的整图
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      await vscode.window.tabGroups.close(tab);
      await tryCommand("workbench.action.toggleFullScreen");
    });
  }

  // 光晕：光标所在节点要亮，点击节点后一直亮，点空白才恢复成光标节点
  if (selected(GLOW_TEST)) {
    test(GLOW_TEST, async function () {
      this.timeout(40000);
      const extension = vscode.extensions.getExtension("ducphamngoc.codevisualizer");
      assert.ok(extension, "CodeVisualizer extension should be available in the test host");
      await extension.activate();

      // 0) 窗口可视环境（不可删）：全屏 + 关掉无关面板
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

      // 1) L3：光标位置必须能映射到一个节点（这个节点就是该亮光晕的那个）
      const samplePath = path.join(__dirname, "../../test-files/escape_sample.c");
      const sampleText = require("fs").readFileSync(samplePath, "utf8") as string;
      const ir = parser.generateFlowchart(sampleText, "escape_sample");
      const cursorOffset = sampleText.indexOf("MyUart_WriteString");
      assert.ok(cursorOffset > 0, "样例里应有写串语句");
      const cursorEntry = ir.locationMap.find(
        (entry) => cursorOffset >= entry.start && cursorOffset <= entry.end
      );
      assert.ok(cursorEntry, "光标位置应命中一个节点的源码区间");
      const conditionEntry = ir.locationMap.find(
        (entry) => {
          const text = ir.nodes.find((node) => node.id === entry.nodeId)?.label ?? "";
          return text.includes("value != 0");
        }
      );
      assert.ok(conditionEntry, "判断条件应有自己的区间");
      assert.notStrictEqual(
        cursorEntry!.nodeId,
        conditionEntry!.nodeId,
        "光标语句与判断条件必须是不同节点（便于验证光晕切换）"
      );

      // 2) L4：光标在写串语句上 → 该节点光晕；点另一个节点 → 光晕跟过去并保持；
      //    点空白 → 取消锁定
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(samplePath));
      let editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      const cursorPosition = document.positionAt(cursorOffset);
      editor.selection = new vscode.Selection(cursorPosition, cursorPosition);

      await vscode.commands.executeCommand("codevisualizer.openFlowchartToSide");
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

      await new Promise((resolve) => setTimeout(resolve, 1500));
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      editor.selection = new vscode.Selection(cursorPosition, cursorPosition);
      await tryCommand("workbench.action.closeSidebar");
      await tryCommand("workbench.action.increaseViewSize");
      await tryCommand("workbench.action.increaseViewSize");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // 点击另一个节点 → 光晕锁定在它上面
      await vscode.commands.executeCommand("codevisualizer.debugGlowClick");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 点空白 → 取消锁定，光晕回到光标节点
      await vscode.commands.executeCommand("codevisualizer.debugGlowBlank");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 光标切到另一个节点 → 光晕必须跟着换到那个节点
      const conditionOffset = sampleText.indexOf("if (value != 0)");
      assert.ok(conditionOffset > 0, "样例里应有 if 条件");
      const conditionPosition = document.positionAt(conditionOffset);
      editor.selection = new vscode.Selection(conditionPosition, conditionPosition);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const returnOffset = sampleText.indexOf("return value");
      assert.ok(returnOffset > 0, "样例里应有 return 语句");
      const returnPosition = document.positionAt(returnOffset);
      editor.selection = new vscode.Selection(returnPosition, returnPosition);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await vscode.window.tabGroups.close(tab);
      await tryCommand("workbench.action.toggleFullScreen");
    });
  }
});
