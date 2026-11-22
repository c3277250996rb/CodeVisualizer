---
name: targeted-testing
description: '本项目的测试执行规范：每次有代码改动要验证时，先改测试内容再定向运行，删掉与本次改动无关的步骤，且必须保留 100ms 实拍录屏。USE FOR: 用户要求“测试/跑测试/验证改动/实拍检查”，或自己改完 CodeVisualizer 代码需要验证时。DO NOT USE FOR: 纯代码阅读、提交信息、打包发布。'
argument-hint: '说明本次改了什么，我会据此写针对性断言并定向跑测试'
---

# 定向测试（CodeVisualizer）

## 这个技能解决什么

以前的问题是：改了代码，测试用例没跟着改，还在跑上一轮的步骤——于是又慢又测不到东西（最典型：只断言“面板能打开了”，mermaid 白屏了也照样“通过”）。

本技能规定：**测试内容必须先对齐本次改动，然后只跑对应用例，且实拍录屏永远开着。**

## 硬性规则（不可违反）

1. **实拍 100ms 录屏绝对不能删、不能关**
   - `test.ps1` 默认启动 `capture-screen.ps1`（每 100ms 截一帧 + `frames.csv` 时间戳）。
   - 禁止加 `-NoRecordScreen`；禁止删除/改写 `capture-screen.ps1`；禁止把录屏改成可选。
   - 每次必须确认输出里存在：
     `SCREEN_CAPTURE_INTERVAL_MS=100`、`SCREEN_CAPTURE_FRAME_COUNT>0`、`SCREEN_CAPTURE_AVERAGE_INTERVAL_MS` 在 100~150 之间。
   - 必须亲眼看**至少一帧**（用图片查看工具打开 `frame-*.jpg`），确认画面确实是本次改动后的真实渲染。
2. **先改测试，再跑测试**
   - 动手前先写清「改动点 → 断言」对照；没有对应断言就先补，不接受“跑一遍看看”。
   - 只断言“面板能打开 / 命令执行成功”的用例不合格，必须断言到**图源或行为细节**（见下方“断言层次”）。
3. **测试窗口必须全屏 + 关闭无关面板，这几步同样不能删、不能省**
   - 打开测试 VS Code 后必须保留这四步（缺一步实拍就看不清楚）：
     ```ts
     await tryCommand("workbench.action.toggleFullScreen");
     await tryCommand("workbench.action.closeSidebar");
     await tryCommand("workbench.action.closePanel");
     await tryCommand("workbench.action.closeAuxiliaryBar");
     ```
   - 目的：让编辑器区（含流程图面板）占满画面，录屏里能看清节点与箭头；否则帧里全是别的窗口和侧边栏，等于没拍。
   - 唯一例外：**被测对象本身就在侧边栏里**（如 GLOBALS/LOCALS 卡片只长在 `codevisualizer.flowchartView` 中）。
     这时仍要全屏 + 关底部面板 + 关辅助栏，但要在需要拍证据的那一步把被测视图开出来并聚焦：
     ```ts
     await tryCommand("codevisualizer.flowchartView.focus");
     ```
     不能因为“侧边栏要关”就把被测视图一起关掉，那等于拍了个空窗口。
   - 用例结束时把全屏恢复回去（`toggleFullScreen` 再调一次），不要给用户留一个卡在半屏/全屏的窗口。
4. **定向执行，只删“与本次改动无关的业务步骤”**
   - 一律用 `.\test.ps1 -Only <关键字>` 只跑本次相关的用例，不要默认全量。
   - 可以删：上一轮遗留的样例文件、无关断言、无意义的 `setTimeout`、与本次无关的鼠标模拟、旧的命令调用。
   - **不能删**：100ms 实拍录屏、以及上一条的“全屏 + 关闭侧边栏/底部面板/辅助栏”。这些不是“无关步骤”，而是采集证据的前提。
   - 用例里不允许出现“固定 sleep 等结果”，只用轮询等待（`waitFor`）或事件。
5. **不复用旧证据**
   - 每次以本次日志/本次截图目录为准，不用 `%TEMP%` 里上一轮的目录、不引用旧的 `Project.build_log.htm` 式残留。
6. **时间预算**
   - `-SkipBuild` 单次 ≤ 10s，含构建 ≤ 20s；超了必须解释原因并优化掉（常见元凶：错误的选择器导致 10s 轮询到超时）。

## 断言层次（越靠下越好）

| 层次 | 例子 | 是否合格 |
|---|---|---|
| L0 只验证命令不报错 | `executeCommand` 返回成功 | 不合格 |
| L1 只验证面板存在 | `tabGroups` 找到 `flowchartPanel` 标签 | 单独使用时不合格 |
| L2 图源断言 | `mermaid` 里包含/不包含某段内容、`class` 语句合法 | 推荐 |
| L3 行为断言 | 解析出的 IR 节点类型/数量、回写后的源码文本 | 推荐 |
| L4 视觉证据 | 100ms 实拍里看清节点/箭头/文字 | 必须配合 L2/L3 |

## 操作步骤

1. **列出改动点**：`git status --porcelain` + `git diff --stat`，逐条写“改了哪个行为”。
2. **找对应用例**：`src/test/cParser.test.ts`（`PARSER_TEST` / `SMOKE_TEST`），判断是改现有用例还是新增。
3. **改断言**：把 L2/L3 断言写进用例；需要新的样例代码就放进 `test-files/`，并让用例显式引用。
4. **删无关步骤**：把这次用不到的旧样例、无关断言、多余按键模拟、`setTimeout` 从用例里去掉；保持一次运行只验证一件事。**全屏 + 关面板不在此列，必须保留。**
5. **定向跑**：
   ```powershell
   npm.cmd run compile            # 有源码改动时
   npm.cmd run compile-tests      # npm run compile 会 rimraf out，必须补跑
   .\test.ps1 -SkipBuild -Only MyAdc
   ```
   注意：**绝不能**先 `compile` 再 `-SkipBuild` 而漏掉 `compile-tests`，否则 `out/test` 被删，0 个用例也返回退出码 0。
6. **核对输出**：`1 passing`、`TEST_EXIT_CODE=0`、`SCREEN_CAPTURE_FRAME_COUNT>0`、平均间隔 ≈100ms。
7. **看帧**：打开本次 `SCREEN_CAPTURE_DIRECTORY` 里放大后的某一帧，确认画面 = 本次改动后的真实效果；如果看不到，调整聚焦目标/停留时间，而不是放宽断言。
8. **报告**：改动点 / 新增断言 / 执行的用例 / 帧数与目录 / 一帧的结论。证据不全就别说“测试通过”。帧里必须看得到**流程图面板本身**（全屏 + 关面板生效），而不是别的窗口。

## 本项目速查

| 项 | 值 |
|---|---|
| 测试入口 | `.\test.ps1`（参数：`-SkipBuild`、`-FreshProfile`、`-Only <关键字>`，`-NoRecordScreen` **禁用**） |
| 用例文件 | `src/test/cParser.test.ts`（`selected()` 按 `CODEVISUALIZER_TEST_ONLY` 过滤） |
| 测试配置 | `.vscode-test.mjs`（`files: 'out/test/**/*.test.js'`） |
| 录屏脚本 | `capture-screen.ps1`（100ms/帧 + `frames.csv`，`-ActivateWindowTitle` 保持窗口在前） |
| 常用命令 | `codevisualizer.openFlowchartToSide`、`codevisualizer.focusLoopNode` |
| 交互约定 | 双击节点=局部放大；右键代码行=行内编辑；右键空白=复位；右键不可编辑节点=无操作 |
| 测试窗口可视环境（**不可删**） | `toggleFullScreen` + `closeSidebar` + `closePanel` + `closeAuxiliaryBar`，结束时再 `toggleFullScreen` 恢复 |
| 样例 | `test-files/my_adc.c`（`MyAdc_SendTelemetry`，含 for/do-while/while/switch） |

## 新增定向用例模板

```ts
const MY_TEST = "验证 xxx 行为";

if (selected(MY_TEST)) {
  test(MY_TEST, async function () {
    this.timeout(40000);
    // 0) 窗口可视环境（不可删）
    await tryCommand("workbench.action.toggleFullScreen");
    await tryCommand("workbench.action.closeSidebar");
    await tryCommand("workbench.action.closePanel");
    await tryCommand("workbench.action.closeAuxiliaryBar");
    // 1) 只做与本次改动相关的准备
    // 2) L2/L3 断言：解析结果或图源内容
    // 3) 需要看画面时：打开面板 → focusLoopNode → 停留 1s 让实拍拍到
    // 4) 结束时恢复全屏
  });
}
```

运行：`.\test.ps1 -SkipBuild -Only <MY_TEST 的关键字>`

## 反模式（本项目真实踩过的坑）

- 只断言“面板打开”，结果 mermaid 报 `Syntax error in text` 白屏也算通过。
- 选择器写错（`viewType === 'codevisualizer.flowchartPanel'`，实际带 `mainThreadWebview-` 前缀），白等满 10 秒再误报失败。
- `compile` 之后再 `-SkipBuild`，`out/` 被删 → 0 个用例、退出码 0，看着像通过。
- 用例还在跑上一轮的样例文件，和这次改动完全无关。
- 固定 `sleep 5000` 等渲染，既慢又不稳。
- 把“全屏 + 关闭侧边栏/底部面板/辅助栏”当成无关步骤删掉 → 实拍帧里全是别的窗口和侧边栏，等于没拍。
- 为了“快”把实拍关掉——这是明令禁止的。
