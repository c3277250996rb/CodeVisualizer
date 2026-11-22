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
  const SWITCH_TEST = "SWITCH 切函数时清空画布并重置缩放";
  const ELSE_TEST = "ELSE else 与 else if 要识别成判断分支";
  const LOOPBODY_TEST = "LOOPBODY while 与 do-while 的循环体要逐条展开";
  const ESCAPE_TEST = "ESCAPE 代码里的 != 与反斜杠要原样显示";
  const OUTLINE_TEST = "OUTLINE 侧边栏只剩流程图视图";

  const ANY_TEST = (): boolean =>
    selected(PARSER_TEST) ||
    selected(SMOKE_TEST) ||
    selected(VARS_TEST) ||
    selected(SWITCH_TEST) ||
    selected(ELSE_TEST) ||
    selected(LOOPBODY_TEST) ||
    selected(ESCAPE_TEST) ||
    selected(OUTLINE_TEST);

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
});
