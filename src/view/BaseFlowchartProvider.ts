import * as vscode from "vscode";
import { analyzeCode } from "../core/analyzer";
import { FlowchartIR, LocationMapEntry } from "../ir/ir";
import { EnhancedMermaidGenerator } from "../core/EnhancedMermaidGenerator";
import { LLMManager } from "../core/llm/LLMManager";
import { getExtensionContext } from "../core/llm/LLMContext";
import { EnvironmentDetector } from "../core/utils/EnvironmentDetector";
import { MetricsAnalyzer, CodeMetrics } from "../core/utils/MetricsAnalyzer";
import {
  buildStructureKey,
  DocumentModel,
  DocumentSnapshot,
} from "../core/document/DocumentModel";
import { collectSymbols } from "../core/document/SymbolCatalog";
import { applyFolds, planFoldRegions } from "../core/fold/CollapsePlanner";

const MERMAID_VERSION = "11.8.0";
const SVG_PAN_ZOOM_VERSION = "3.6.1";

// Define specific types for messages from the webview to avoid `any`
export type HighlightCodeMessage = {
  command: "highlightCode";
  payload: { start: number; end: number };
};

export type ExportMessage = {
  command: "export";
  payload: { fileType: "svg" | "png"; data: string };
};

export type ExportErrorMessage = {
  command: "exportError";
  payload: { error: string };
};

export type OpenInPanelMessage = {
  command: "openInPanel";
  payload: {};
};

// New message type for copying mermaid code
export type CopyMermaidMessage = {
  command: "copyMermaid";
  payload: { code: string };
};

export type RequestLLMLabelsMessage = {
  command: "requestLLMLabels";
  payload: {};
};

export type DisableLLMLabelsMessage = {
  command: "disableLLMLabels";
  payload: {};
};

export type SetupLLMMessage = {
  command: "setupLLM";
  payload: {};
};

export type UserInteractionStartMessage = {
  command: "userInteractionStart";
  payload: {};
};

export type UserInteractionEndMessage = {
  command: "userInteractionEnd";
  payload: {};
};

export type WebviewReadyMessage = {
  command: "webviewReady";
  payload: {};
};

export type RequestFunctionMessage = {
  command: "requestFunction";
  payload: { name?: string };
};

export type EditStatementMessage = {
  command: "editStatement";
  payload: { start: number; end: number; text: string; original?: string };
};

export type RevealVariableMessage = {
  command: "revealVariable";
  payload: { start: number; end: number };
};

export type ToggleFoldMessage = {
  command: "toggleFold";
  payload: { anchorId: string; collapsed?: boolean };
};

export type SetFoldDefaultMessage = {
  command: "setFoldDefault";
  payload: { expanded: boolean };
};

export type WebviewMessage =
  | HighlightCodeMessage
  | ExportMessage
  | ExportErrorMessage
  | OpenInPanelMessage
  | CopyMermaidMessage
  | RequestLLMLabelsMessage
  | DisableLLMLabelsMessage
  | SetupLLMMessage
  | UserInteractionStartMessage
  | UserInteractionEndMessage
  | WebviewReadyMessage
  | RequestFunctionMessage
  | EditStatementMessage
  | RevealVariableMessage
  | ToggleFoldMessage
  | SetFoldDefaultMessage;

export interface FlowchartViewContext {
  isPanel: boolean;
  showPanelButton: boolean;
}

/**
 * Abstract base class for flowchart providers that contains shared functionality
 * between sidebar and panel implementations.
 */
export abstract class BaseFlowchartProvider {
  protected _disposables: vscode.Disposable[] = [];
  protected _locationMap: LocationMapEntry[] = [];
  protected _currentFunctionRange: vscode.Range | undefined;
  protected _debounceTimer?: NodeJS.Timeout;
  protected _currentDocument?: vscode.TextDocument;
  /** 最近一次渲染时的文档版本；TextDocument 是活对象，必须单独记版本号。 */
  protected _currentVersion?: number;
  protected _currentPosition?: number;
  protected _isUpdating: boolean = false;
  protected _eventListenersSetup: boolean = false;
  protected _mermaidCodeOriginal?: string;
  protected _mermaidCodeLLM?: string;
  private _cachedClickHandlers?: { source: string; lines: string[] };
  protected _userInteracting: boolean = false;
  /** 分析快照缓存，避免同一版本重复解析。 */
  protected _documentModel: DocumentModel = new DocumentModel();
  /** 页面是否已经完整渲染过一次（之后只推消息）。 */
  protected _htmlRendered: boolean = false;
  /** webview 脚本是否已就绪（握手完成后才能安全地推消息）。 */
  protected _webviewReady: boolean = false;
  /** 上一次渲染的图结构签名，用于判断布局是否会变。 */
  protected _lastStructureKey?: string;
  /** 固定展示的函数名；为空时跟随光标。 */
  protected _pinnedFunction?: string;
  /** 固定模式所属的文档；切到别的文件时固定自动失效。 */
  protected _pinnedUri?: string;
  /** 上次渲染的文档，用于判断是否切换了文件。 */
  protected _lastDocumentUri?: string;
  /** 上次渲染的函数名，用于判断是否切换了函数（切函数要清画布并重置缩放）。 */
  protected _lastFunctionName?: string;
  /** 当前图里的 Start / End 节点 id，用于从位置映射里排除这两个边界节点。 */
  private _entryNodeId?: string;
  private _exitNodeId?: string;
  /** 默认折叠：这里只记用户显式展开过的判断；键为 "uri#函数名"。 */
  protected _expandedAnchors = new Map<string, Set<string>>();
  /** 用户显式折叠过的判断（默认展开时用来反向覆盖）。 */
  protected _collapsedAnchors = new Map<string, Set<string>>();
  /** 折叠状态刚变过：即使光标还在同一函数里也要重新生成图。 */
  private _foldsDirty = false;
  /** 交互期间跳过的刷新，交互结束后补做。 */
  protected _pendingUpdate: boolean = false;
  /** 页面未就绪时挂起的节点聚焦请求。 */
  private _pendingFocusKind?: string;

  constructor(protected readonly _extensionUri: vscode.Uri) {
    // Detect environment and apply any necessary compatibility fixes
    this.initializeEnvironment();
    
    // Listen for configuration changes to update themes and zoom settings
    this._disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("codevisualizer.theme")) {
          // Refresh the current view when theme changes
          this.updateView(vscode.window.activeTextEditor);
          return;
        }
        if (e.affectsConfiguration("codevisualizer.defaultExpandBranches")) {
          // 默认展开/折叠变了：清掉逐个切换的覆盖，按新默认重画
          this.resetFoldOverrides();
          this._foldsDirty = true;
          void this.updateView(this.editorForCurrentDocument());
          return;
        }
        if (e.affectsConfiguration("codevisualizer.nodeZoomFontScale")) {
          // Update the focused-node zoom without re-rendering the whole diagram
          this.getWebview()?.postMessage({
            command: "nodeZoomFontScale",
            payload: { scale: BaseFlowchartProvider.getNodeZoomFontScale() },
          });
        }
      })
    );
  }

  /**
   * Read the maximum zoom used when focusing a node from the context menu,
   * expressed as a multiple of the code font size inside the node.
   * 1 keeps the font at its original size, 2 doubles it.
   */
  private static getNodeZoomFontScale(): number {
    const config = vscode.workspace.getConfiguration("codevisualizer");
    const value = config.get<number>("nodeZoomFontScale", 0.8);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 0.8;
    }
    return Math.max(0.8, Math.min(0.8, value));
  }

  /**
   * Initialize environment-specific settings and compatibility fixes
   */
  private initializeEnvironment(): void {
    const env = EnvironmentDetector.detectEnvironment();
    
    if (env.requiresCompatibilityMode) {
      console.log(`CodeVisualizer: Running in compatibility mode for ${env.editor}`);
      
      // Add any environment-specific initialization here
      if (env.isCursor) {
        // Cursor-specific initialization
        console.log("CodeVisualizer: Applying Cursor-specific compatibility settings");
      } else if (env.isWindsurf) {
        // Windsurf-specific initialization  
        console.log("CodeVisualizer: Applying Windsurf-specific compatibility settings");
      } else if (env.isTrae) {
        // Trae-specific initialization
        console.log("CodeVisualizer: Applying Trae-specific compatibility settings");
      }
    }
  }

  /**
   * Abstract methods that subclasses must implement
   */
  protected abstract getWebview(): vscode.Webview | undefined;
  protected abstract setWebviewHtml(html: string): void;
  protected abstract getViewContext(): FlowchartViewContext;

  /**
   * Set up event listeners for editor changes and selection changes
   */
  protected setupEventListeners(): void {
    // Prevent setting up listeners multiple times
    if (this._eventListenersSetup) {
      return;
    }

    // Listen for changes to the active editor
    vscode.window.onDidChangeActiveTextEditor(
      async (editor) => {
        await this.updateView(editor);
      },
      null,
      this._disposables
    );

    // Listen for selection changes in the active editor
    vscode.window.onDidChangeTextEditorSelection(
      async (event) => {
        // 面板/侧边栏抢到焦点时 activeTextEditor 可能为 undefined，
        // 所以不能按“是否活动编辑器”过滤，只认这份文档是不是当前渲染的那一份
        const renderedUri = this._currentDocument?.uri.toString();
        if (
          !renderedUri ||
          event.textEditor.document.uri.toString() !== renderedUri
        ) {
          return;
        }
        const selection = event.selections[0];
        // If the cursor is still within the same function, just highlight the node
        if (
          this._currentFunctionRange &&
          this._currentFunctionRange.contains(selection)
        ) {
          const offset = event.textEditor.document.offsetAt(selection.active);
          this.highlightNode(this.nodeIdAtOffset(offset));
        } else {
          // If the cursor moves out of the function, regenerate the flowchart
          await this.updateView(event.textEditor);
        }
      },
      null,
      this._disposables
    );

    // Listen for changes to the document text for live updates
    vscode.workspace.onDidChangeTextDocument(
      (event) => {
        // 只响应当前渲染的那份文档；不看焦点，面板抢焦点时也要能刷新
        const renderedUri = this._currentDocument?.uri.toString();
        if (!renderedUri || event.document.uri.toString() !== renderedUri) {
          return;
        }
        if (event.contentChanges.length === 0) {
          return;
        }

        if (this._debounceTimer) {
          clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
          const editor =
            vscode.window.visibleTextEditors.find(
              (candidate) => candidate.document.uri.toString() === renderedUri
            ) ?? vscode.window.activeTextEditor;
          this.updateView(editor);
        }, 300);
      },
      null,
      this._disposables
    );

    this._eventListenersSetup = true;
  }

  /**
   * Handle messages from the webview
   */
  protected async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    switch (message.command) {
      case "toggleFold": {
        await this.toggleFold(
          message.payload.anchorId,
          message.payload.collapsed
        );
        return;
      }
      case "setFoldDefault": {
        await this.setDefaultExpandBranches(message.payload.expanded);
        return;
      }
      case "highlightCode": {
        const { start, end } = message.payload;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const startPos = editor.document.positionAt(start);
          const endPos = editor.document.positionAt(end);
          const range = new vscode.Range(startPos, endPos);

          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
        break;
      }

      case "export": {
        await this.handleExport(message.payload);
        break;
      }

      case "exportError": {
        vscode.window.showErrorMessage(
          `Export failed: ${message.payload.error}`
        );
        break;
      }

      case "openInPanel": {
        // This will be handled by the FlowchartPanelProvider
        vscode.commands.executeCommand("codevisualizer.openFlowchartInPanel");
        break;
      }

      case "copyMermaid": {
        await vscode.env.clipboard.writeText(message.payload.code);
        vscode.window.showInformationMessage("Mermaid code copied to clipboard!");
        break;
      }

      case "requestLLMLabels": {
        console.log("CodeVisualizer LLM: requestLLMLabels received");
        await this.handleLLMTranslate();
        break;
      }

      case "disableLLMLabels": {
        console.log("CodeVisualizer LLM: disableLLMLabels received");
        const webview = this.getWebview();
        if (webview && this._mermaidCodeOriginal) {
          webview.postMessage({ command: "applyMermaid", payload: { mermaid: this._mermaidCodeOriginal, llmApplied: false } });
        }
        break;
      }

      case "setupLLM": {
        console.log("CodeVisualizer LLM: setupLLM received");
        await vscode.commands.executeCommand("codevisualizer.llm.enableLabels");
        const ctx = getExtensionContext();
        const availability = ctx ? await LLMManager.getAvailability(ctx) : { enabled: false, provider: "openai", model: "" };
        const webview = this.getWebview();
        if (webview) {
          webview.postMessage({ command: "llmAvailability", payload: availability });
        }
        break;
      }

      case "userInteractionStart": {
        this._userInteracting = true;
        break;
      }

      case "userInteractionEnd": {
        this._userInteracting = false;
        await this.flushPendingUpdate();
        break;
      }

      case "webviewReady": {
        // 页面脚本就绪后，后续更新才能安全地走消息通道
        this._webviewReady = true;
        this.flushPendingFocus();
        break;
      }

      case "requestFunction": {
        this._pinnedFunction = message.payload.name;
        this._pinnedUri = this._pinnedFunction
          ? this._currentDocument?.uri.toString()
          : undefined;
        this._documentModel.invalidate();
        // 焦点在 webview 时 activeTextEditor 为空，优先用正在渲染的那份文档的编辑器
        const pinnedDocumentUri = this._currentDocument?.uri.toString();
        const pinnedEditor =
          (pinnedDocumentUri
            ? vscode.window.visibleTextEditors.find(
                (candidate) => candidate.document.uri.toString() === pinnedDocumentUri
              )
            : undefined) ?? vscode.window.activeTextEditor;
        await this.updateView(pinnedEditor);
        break;
      }

      case "editStatement": {
        await this.handleEditStatement(message.payload);
        break;
      }

      case "revealVariable": {
        const document = this._currentDocument;
        const editor = document
          ? vscode.window.visibleTextEditors.find(
              (candidate) => candidate.document.uri.toString() === document.uri.toString()
            )
          : vscode.window.activeTextEditor;
        if (document && editor) {
          const range = new vscode.Range(
            document.positionAt(message.payload.start),
            document.positionAt(message.payload.end)
          );
          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
        break;
      }
    }
  }

  /**
   * Merge click handlers from original Mermaid into a translated Mermaid string
   * to preserve node interactivity after LLM rewrites.
   */
  private static isClickLine(line: string): boolean {
    let index = 0;
    // Skip leading spaces and tabs without allocating new strings
    while (index < line.length) {
      const code = line.charCodeAt(index);
      if (code !== 32 && code !== 9) break; // 32 = space, 9 = tab
      index += 1;
    }
    return line.startsWith("click ", index);
  }

  private extractClickHandlers(src: string): string[] {
    if (this._cachedClickHandlers && this._cachedClickHandlers.source === src) {
      return this._cachedClickHandlers.lines;
    }
    const lines: string[] = [];
    const srcLines = src.split(/\r?\n/);
    for (const line of srcLines) {
      if (BaseFlowchartProvider.isClickLine(line)) {
        lines.push(line);
      }
    }
    this._cachedClickHandlers = { source: src, lines };
    return lines;
  }

  private extractMetadata(src: string): string[] {
    return src.split(/\r?\n/).filter(line => line.trim().startsWith("%%"));
  }

  private mergeMetadata(metadata: string[], translatedSrc: string): string {
    if (metadata.length === 0) return translatedSrc;
    return `${translatedSrc}\n${metadata.join("\n")}\n`;
  }

  private mergeClickHandlers(originalSrc: string, translatedSrc: string): string {
    try {
      const origClicks = this.extractClickHandlers(originalSrc);
      if (origClicks.length === 0) return translatedSrc;
      const withoutClicks = translatedSrc
        .split(/\r?\n/)
        .filter((l) => !BaseFlowchartProvider.isClickLine(l))
        .join("\n");
      // Append original click lines at end
      return `${withoutClicks}\n${origClicks.join("\n")}\n`;
    } catch {
      return translatedSrc;
    }
  }

  private async handleLLMTranslate(): Promise<void> {
    const ctx = getExtensionContext();
    const webview = this.getWebview();
    if (!ctx || !webview) return;
    if (!this._mermaidCodeOriginal) return;
    try {
      console.log("CodeVisualizer LLM: translateIfNeeded start");
      const metadata = this.extractMetadata(this._mermaidCodeOriginal);
      let translated = await LLMManager.translateIfNeeded(ctx, this._mermaidCodeOriginal);
      console.log("CodeVisualizer LLM: translateIfNeeded done");
      if (translated) {
        // Preserve click interactivity and metadata
        translated = this.mergeMetadata(metadata, translated);
        translated = this.mergeClickHandlers(this._mermaidCodeOriginal, translated);
        this._mermaidCodeLLM = translated;
        webview.postMessage({ command: "applyMermaid", payload: { mermaid: translated, llmApplied: true } });
      } else {
        vscode.window.showWarningMessage("LLM labels could not be applied. Using original labels.");
        // Notify webview to reset LLM UI state
        try {
          webview.postMessage({ command: "applyMermaid", payload: { mermaid: this._mermaidCodeOriginal, llmApplied: false } });
        } catch {}
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`LLM translation failed: ${message}`);
    }
  }

  /**
   * Handle export functionality
   */
  private async handleExport(payload: {
    fileType: "svg" | "png";
    data: string;
  }): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showErrorMessage(
        "Cannot export: No active text editor found."
      );
      return;
    }

    const { fileType, data } = payload;
    const documentUri = activeEditor.document.uri;

    const defaultDirectory = vscode.Uri.file(
      require("path").dirname(documentUri.fsPath)
    );
    const defaultFileUri = vscode.Uri.file(
      require("path").join(defaultDirectory.fsPath, `flowchart.${fileType}`)
    );

    const filters: { [name: string]: string[] } =
      fileType === "svg"
        ? { "SVG Images": ["svg"] }
        : { "PNG Images": ["png"] };

    const uri = await vscode.window.showSaveDialog({
      filters,
      defaultUri: defaultFileUri,
    });

    if (uri) {
      const buffer = Buffer.from(data, fileType === "png" ? "base64" : "utf-8");
      try {
        await vscode.workspace.fs.writeFile(uri, buffer);
        vscode.window.showInformationMessage(
          `Successfully exported flowchart to ${uri.fsPath}`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Failed to export flowchart: ${message}`
        );
      }
    }
  }

  /**
   * Highlight a specific node in the flowchart
   */
  public highlightNode(nodeId: string | null): void {
    const webview = this.getWebview();
    if (webview) {
      // Sanitize nodeId before sending to webview to match sanitized IDs in the diagram
      const sanitizedNodeId = nodeId ? nodeId.replace(/\s+/g, '_').replace(/[^\w-]/g, '_').replace(/_+/g, '_') : null;
      webview.postMessage({
        command: "highlightNode",
        payload: { nodeId: sanitizedNodeId },
      });
    }
  }

  /**
   * 放大并居中到指定类型的节点（例如 loop-start），供面板命令调用。
   * 页面未就绪（还在加载/重渲染）时先存起来，等 webviewReady 或渲染完成再发。
   */
  public focusNodeKind(kind: string): void {
    const webview = this.getWebview();
    if (!webview || !this._webviewReady || !this._htmlRendered) {
      this._pendingFocusKind = kind;
      return;
    }
    webview.postMessage({
      command: "focusNodeKind",
      payload: { kind },
    });
  }

  private flushPendingFocus(): void {
    const kind = this._pendingFocusKind;
    if (!kind) {
      return;
    }
    this._pendingFocusKind = undefined;
    this.focusNodeKind(kind);
  }

  /**
   * webview 被重建时调用，恢复“首次整页渲染”的流程。
   */
  public resetWebviewState(): void {
    this._documentModel.invalidate();
    this._htmlRendered = false;
    this._webviewReady = false;
    this._lastStructureKey = undefined;
    this._lastDocumentUri = undefined;
    this._lastFunctionName = undefined;
  }

  /**
   * 取分析快照：同一文档版本直接命中缓存，不重复解析。
   */
  private async getSnapshot(
    document: vscode.TextDocument,
    position: number
  ): Promise<DocumentSnapshot> {
    const uri = document.uri.toString();
    const cached = this._documentModel.get(
      uri,
      document.version,
      this._pinnedFunction,
      position
    );
    if (cached) {
      return cached;
    }

    // 固定函数模式必须让函数名生效，跟着光标传 position 会被解析器优先采用
    const ir = await analyzeCode(
      document.getText(),
      document.languageId,
      this._pinnedFunction,
      this._pinnedFunction ? undefined : position
    );

    const snapshot: DocumentSnapshot = {
      uri,
      version: document.version,
      languageId: document.languageId,
      functionName: this._pinnedFunction,
      ir,
      metrics: MetricsAnalyzer.analyze(ir, document.getText()),
      // 用本次实际分析的函数名取局部变量；固定模式下回退到固定函数
      symbols: collectSymbols(
        document.getText(),
        document.languageId,
        ir.functionName ?? this._pinnedFunction
      ),
      structureKey: buildStructureKey(ir),
    };
    this._documentModel.store(snapshot);
    return snapshot;
  }

  /**
   * 折叠状态按 "uri#函数名" 存；切函数/切文件时自动失效。
   */
  private foldKey(): string | undefined {
    const document = this._currentDocument;
    if (!document) {
      return undefined;
    }
    return `${document.uri.toString()}#${this._lastFunctionName ?? ""}`;
  }

  private expandedAnchorSet(create: boolean): Set<string> | undefined {
    return this.anchorOverrideSet(this._expandedAnchors, create);
  }

  private collapsedAnchorSet(create: boolean): Set<string> | undefined {
    return this.anchorOverrideSet(this._collapsedAnchors, create);
  }

  private anchorOverrideSet(
    store: Map<string, Set<string>>,
    create: boolean
  ): Set<string> | undefined {
    const key = this.foldKey();
    if (!key) {
      return undefined;
    }
    let set = store.get(key);
    if (!set && create) {
      set = new Set<string>();
      store.set(key, set);
    }
    return set;
  }

  /** 顶部复选框：true = 分支默认展开，false = 默认折叠。 */
  private defaultExpandBranches(): boolean {
    return vscode.workspace
      .getConfiguration("codevisualizer")
      .get<boolean>("defaultExpandBranches", false);
  }

  /**
   * 按“默认展开/折叠 + 用户逐个切换的覆盖”算出要折叠的锚点集合。
   */
  private collapsedAnchorsFor(ir: FlowchartIR): Set<string> {
    const defaultExpanded = this.defaultExpandBranches();
    const explicitExpanded = this.expandedAnchorSet(false) ?? new Set<string>();
    const explicitCollapsed = this.collapsedAnchorSet(false) ?? new Set<string>();
    const collapsed = new Set<string>();
    for (const region of planFoldRegions(ir)) {
      const shouldCollapse = defaultExpanded
        ? explicitCollapsed.has(region.anchorId)
        : !explicitExpanded.has(region.anchorId);
      if (shouldCollapse) {
        collapsed.add(region.anchorId);
      }
    }
    return collapsed;
  }

  /** 当前文档对应的编辑器（面板抢焦点时 activeTextEditor 可能为空）。 */
  private editorForCurrentDocument(): vscode.TextEditor | undefined {
    const uri = this._currentDocument?.uri.toString();
    if (!uri) {
      return vscode.window.activeTextEditor;
    }
    return (
      vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === uri
      ) ?? vscode.window.activeTextEditor
    );
  }

  /** 供命令使用：当前视图是否真的挂在 webview 上。 */
  public hasWebview(): boolean {
    return Boolean(this.getWebview());
  }

  /** 调试用：让 webview 模拟点击第一个折叠角标。 */
  public simulateFoldClick(): void {
    this.getWebview()?.postMessage({ command: "simulateFoldClick", payload: {} });
  }

  /** 调试用：模拟点击一个节点（或空白）来验证光晕锁定/解锁。 */
  public simulateGlowClick(kind: "node" | "blank"): void {
    this.getWebview()?.postMessage({ command: "simulateGlowClick", payload: { kind } });
  }

  /** 调试用：模拟点击顶部“默认展开”复选框，验证真实点击链路。 */
  public simulateFoldDefaultClick(): void {
    this.getWebview()?.postMessage({ command: "simulateFoldDefaultClick", payload: {} });
  }

  /** 折叠/展开单个判断的 ✔️ 分支。 */
  public async toggleFold(anchorId: string, collapsed?: boolean): Promise<void> {
    const expanded = this.expandedAnchorSet(true);
    const explicitCollapsed = this.collapsedAnchorSet(true);
    if (!expanded || !explicitCollapsed) {
      return;
    }
    const currentlyCollapsed = expanded.has(anchorId)
      ? false
      : this.defaultExpandBranches()
        ? explicitCollapsed.has(anchorId)
        : !expanded.has(anchorId);
    const nextCollapsed = collapsed ?? !currentlyCollapsed;
    if (nextCollapsed) {
      expanded.delete(anchorId);
      explicitCollapsed.add(anchorId);
    } else {
      explicitCollapsed.delete(anchorId);
      expanded.add(anchorId);
    }
    this._foldsDirty = true;
    await this.updateView(this.editorForCurrentDocument());
  }

  /** 供命令使用：一次折叠/展开当前函数里所有可折叠分支。 */
  public async setAllFolds(collapsed: boolean): Promise<void> {
    if (!this.getWebview() || !this._currentDocument) {
      return;
    }
    const expanded = this.expandedAnchorSet(true);
    const explicitCollapsed = this.collapsedAnchorSet(true);
    if (!expanded || !explicitCollapsed) {
      return;
    }
    expanded.clear();
    explicitCollapsed.clear();
    const snapshot = await this.getSnapshot(
      this._currentDocument,
      this._currentPosition ?? 0
    );
    for (const region of planFoldRegions(snapshot.ir)) {
      if (collapsed) {
        explicitCollapsed.add(region.anchorId);
      } else {
        expanded.add(region.anchorId);
      }
    }
    this._foldsDirty = true;
    await this.updateView(this.editorForCurrentDocument());
  }

  /** 顶部复选框：切换默认展开/折叠并立即重绘。 */
  public async setDefaultExpandBranches(expanded: boolean): Promise<void> {
    await vscode.workspace
      .getConfiguration("codevisualizer")
      .update("defaultExpandBranches", expanded, vscode.ConfigurationTarget.Global);
    this.resetFoldOverrides();
    this._foldsDirty = true;
    await this.updateView(this.editorForCurrentDocument());
  }

  private resetFoldOverrides(): void {
    this._expandedAnchors.clear();
    this._collapsedAnchors.clear();
  }

  /**
   * 光标位置 → 节点：在覆盖该偏移的所有区间里取最窄的那个，
   * 否则 if/switch 条件会被外面那一大块合并语句抢走。
   */
  private nodeIdAtOffset(offset: number): string | null {
    let best: LocationMapEntry | undefined;
    let bestWidth = Number.POSITIVE_INFINITY;
    for (const entry of this._locationMap) {
      if (offset < entry.start || offset > entry.end) {
        continue;
      }
      const width = entry.end - entry.start;
      if (width < bestWidth) {
        best = entry;
        bestWidth = width;
      }
    }
    if (!best) {
      return null;
    }
    // Start/End 的区间盖住整个函数，光标落在 if 关键字这类空隙时会被它抢到；
    // 这时退化成“后面第一个真实节点”
    if (best.nodeId === this._entryNodeId || best.nodeId === this._exitNodeId) {
      const next = this._locationMap
        .filter(
          (entry) =>
            entry.start >= offset &&
            entry.nodeId !== this._entryNodeId &&
            entry.nodeId !== this._exitNodeId
        )
        .sort((left, right) => left.start - right.start)[0];
      if (next) {
        return next.nodeId;
      }
    }
    return best.nodeId;
  }

  /**
   * 位置映射补全：解析器给出的 locationMap 可能缺少条件节点，
   * 这里把每个带 location 的节点都补上，光标才能落到节点上。
   */
  private buildLocationMap(ir: FlowchartIR): LocationMapEntry[] {
    const map = ir.locationMap.slice();
    for (const node of ir.nodes) {
      if (!node.location) {
        continue;
      }
      if (map.some((entry) => entry.nodeId === node.id)) {
        continue;
      }
      map.push({
        start: node.location.start,
        end: node.location.end,
        nodeId: node.id,
      });
    }
    return map;
  }

  /**
   * 按当前主题生成 Mermaid 代码。
   */
  private generateMermaid(ir: FlowchartIR): string {
    const vsCodeTheme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? "dark"
        : "light";
    const config = vscode.workspace.getConfiguration("codevisualizer");
    const selectedTheme = config.get<string>("theme", "monokai");
    return new EnhancedMermaidGenerator(selectedTheme, vsCodeTheme).generate(ir);
  }

  /**
   * 把 webview 中编辑过的语句写回源码。
   * 写入前校验目标位置的原文，避免文档已变化时写错行。
   */
  private async handleEditStatement(payload: {
    start: number;
    end: number;
    text: string;
    original?: string;
  }): Promise<void> {
    const webview = this.getWebview();
    const document = this._currentDocument ?? vscode.window.activeTextEditor?.document;

    if (!webview || !document) {
      webview?.postMessage({
        command: "editResult",
        payload: { ok: false, reason: "no-document" },
      });
      return;
    }

    const text = payload.text ?? "";
    if (payload.original !== undefined && text === payload.original) {
      webview.postMessage({
        command: "editResult",
        payload: { ok: true, changed: false },
      });
      return;
    }

    let start = payload.start;
    let end = payload.end;
    const rangeText = document.getText(
      new vscode.Range(document.positionAt(start), document.positionAt(end))
    );

    if (payload.original !== undefined && rangeText !== payload.original) {
      // 文档已变化：在附近重新定位原文，找不到则拒绝写入
      const fullText = document.getText();
      const searchFrom = Math.max(0, start - 2000);
      const index = payload.original.length > 0
        ? fullText.indexOf(payload.original, searchFrom)
        : -1;
      if (index < 0 || index > start + 2000) {
        webview.postMessage({
          command: "editResult",
          payload: { ok: false, reason: "stale" },
        });
        return;
      }
      start = index;
      end = index + payload.original.length;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(start), document.positionAt(end)),
      text
    );
    const applied = await vscode.workspace.applyEdit(edit);
    webview.postMessage({
      command: "editResult",
      payload: { ok: applied, reason: applied ? undefined : "apply-failed" },
    });
  }

  /**
   * Force update the view, ignoring the shouldUpdate check
   */
  public async forceUpdateView(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    // Reset the updating flag to ensure we can proceed
    this._isUpdating = false;

    // Clear current state to force regeneration
    this._currentDocument = undefined;
    this._currentVersion = undefined;
    this._currentPosition = undefined;
    this._currentFunctionRange = undefined;

    if (editor) {
      this._documentModel.invalidate(editor.document.uri.toString());
    }

    await this.updateView(editor);
  }

  /**
   * Main method to update the webview content. It analyzes the code and redraws the flowchart.
   */
  public async updateView(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    const webview = this.getWebview();
    if (!webview) {
      return;
    }

    // Prevent updates when user is interacting with the webview
    // （折叠是用户的显式操作，点角标时会带着手势状态，不能被这个门挡掉）
    if (this._userInteracting && !this._foldsDirty) {
      this._pendingUpdate = true;
      return;
    }

    // Prevent multiple simultaneous updates
    if (this._isUpdating) {
      // 正在渲染时不要丢掉这次请求，标记一下让本次渲染结束后补做
      this._pendingUpdate = true;
      return;
    }

    if (!editor) {
      this.setWebviewHtml(
        this.getLoadingHtml("Please open a file to see the flowchart.")
      );
      this._htmlRendered = false;
      this._webviewReady = false;
      this._lastStructureKey = undefined;
      this._lastFunctionName = undefined;
      this._currentDocument = undefined;
      this._currentPosition = undefined;
      return;
    }

    const position = editor.document.offsetAt(editor.selection.active);
    const document = editor.document;

    // 固定函数只对当初选择它的那份文档有意义，切到别的文件自动回到跟随光标
    if (this._pinnedFunction && this._pinnedUri !== document.uri.toString()) {
      this._pinnedFunction = undefined;
      this._pinnedUri = undefined;
    }

    // Check if we need to update - avoid unnecessary regeneration
    const shouldUpdate = this._foldsDirty || this._shouldUpdate(document, position);
    if (!shouldUpdate) {
      // Just update highlighting if we're still in the same function
      if (
        this._currentFunctionRange &&
        this._currentFunctionRange.contains(editor.selection.active)
      ) {
        this.highlightNode(this.nodeIdAtOffset(position));
      }
      return;
    }

    this._isUpdating = true;
    this._foldsDirty = false;
    if (!this._htmlRendered) {
      this.setWebviewHtml(this.getLoadingHtml("Generating flowchart..."));
    }

    try {
      const snapshot = await this.getSnapshot(document, position);

      // 折叠：把已折叠的判断区域换成摘要节点，图源与位置映射都用折叠后的 IR
      const foldedIr = applyFolds(snapshot.ir, this.collapsedAnchorsFor(snapshot.ir));
      this._locationMap = this.buildLocationMap(foldedIr);
      this._entryNodeId = foldedIr.entryNodeId;
      this._exitNodeId = foldedIr.exitNodeId;
      this._currentDocument = document;
      this._currentVersion = document.version;
      this._currentPosition = position;

      if (snapshot.ir.functionRange) {
        this._currentFunctionRange = new vscode.Range(
          document.positionAt(snapshot.ir.functionRange.start),
          document.positionAt(snapshot.ir.functionRange.end)
        );
      } else {
        this._currentFunctionRange = undefined;
      }

      const mermaidCode = this.generateMermaid(foldedIr);
      this._mermaidCodeOriginal = mermaidCode;
      this._mermaidCodeLLM = undefined;

      const ctx = getExtensionContext();
      const availability = ctx
        ? await LLMManager.getAvailability(ctx)
        : { enabled: false, provider: "openai", model: "" };

      const structureChanged = this._lastStructureKey !== snapshot.structureKey;
      const documentChanged = this._lastDocumentUri !== document.uri.toString();
      const functionChanged = this._lastFunctionName !== snapshot.ir.functionName;
      if (documentChanged || functionChanged) {
        // 换文件/换函数：逐个切换的状态不跟过去，新函数按默认值重新算
        this.resetFoldOverrides();
      }
      if (!this._htmlRendered || !this._webviewReady) {
        // 首次渲染（或 webview 重建）：整页加载一次
        this.setWebviewHtml(
          this.getWebviewContent(
            mermaidCode,
            this.getNonce(),
            availability,
            snapshot.metrics
          )
        );
        this._htmlRendered = true;
      } else {
        // 后续更新：不重建页面，只推送新的图与附带信息。
        // 同一个函数的刷新（编辑回写、主题变化等）保留缩放/位置；
        // 切换函数或切换文件则必须清空画布、重置缩放，直接显示新函数的全图。
        webview.postMessage({
          command: "applyGraph",
          payload: {
            mermaid: mermaidCode,
            preserveView: !documentChanged && !functionChanged,
            structureChanged: structureChanged || documentChanged || functionChanged,
            metrics: snapshot.metrics,
          },
        });
        webview.postMessage({ command: "llmAvailability", payload: availability });
      }
      // 顶栏“默认展开”复选框始终与配置保持一致
      webview.postMessage({
        command: "foldDefaultState",
        payload: { expanded: this.defaultExpandBranches() },
      });
      webview.postMessage({
        command: "applySymbols",
        payload: {
          functions: snapshot.symbols.functions,
          globals: snapshot.symbols.globals,
          locals: snapshot.symbols.locals,
          pinnedFunction: this._pinnedFunction,
        },
      });
      this._lastStructureKey = snapshot.structureKey;
      this._lastDocumentUri = document.uri.toString();
      this._lastFunctionName = snapshot.ir.functionName;

      // 挂起的聚焦请求（如图还没画出来时按下的“放大到循环”）在渲染后补发
      this.flushPendingFocus();

      // After updating the view, immediately highlight the node for the current cursor
      const offset = editor.document.offsetAt(editor.selection.active);
      this.highlightNode(this.nodeIdAtOffset(offset));

    } catch (error) {
      console.error("Flowchart generation failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred";
      this.setWebviewHtml(this.getLoadingHtml(`Error: ${errorMessage}`));
      this._htmlRendered = false;
      this._webviewReady = false;
      this._lastStructureKey = undefined;
      this._lastFunctionName = undefined;
    } finally {
      this._isUpdating = false;
      if (this._pendingUpdate) {
        // 渲染期间被推迟的请求：用微任务补一次，避免递归等待
        void Promise.resolve().then(() => this.flushPendingUpdate());
      }
    }
  }

  /**
   * 补做渲染期间被推迟的更新（切换文件、快速移动光标等）。
   */
  private async flushPendingUpdate(): Promise<void> {
    if (!this._pendingUpdate) {
      return;
    }
    this._pendingUpdate = false;
    const renderedUri = this._currentDocument?.uri.toString();
    const editor =
      vscode.window.activeTextEditor ??
      (renderedUri
        ? vscode.window.visibleTextEditors.find(
            (candidate) => candidate.document.uri.toString() === renderedUri
          )
        : undefined);
    await this.updateView(editor);
  }

  /**
   * Determines if the view should be updated based on document and position changes
   */
  private _shouldUpdate(
    document: vscode.TextDocument,
    position: number
  ): boolean {
    // Always update if no current document
    if (!this._currentDocument) {
      return true;
    }

    // Update if document changed (different file)
    if (this._currentDocument.uri.toString() !== document.uri.toString()) {
      return true;
    }

    // Update if document version changed (content was modified)
    if (this._currentVersion !== document.version) {
      return true;
    }

    // 固定函数模式：函数由下拉框决定，光标在同文件内移动不需要重算
    if (this._pinnedFunction) {
      return false;
    }

    // Update if we moved to a different function or there's no current function range
    if (!this._currentFunctionRange) {
      return true;
    }

    const currentPos = document.positionAt(position);
    if (!this._currentFunctionRange.contains(currentPos)) {
      return true;
    }

    // Don't update if we're just moving within the same function
    return false;
  }

  /**
   * Generates the complete HTML content for the webview panel.
   */
  protected getWebviewContent(
    flowchartSyntax: string,
    nonce: string,
    llmAvailability?: { enabled: boolean; provider: string; model: string },
    codeMetrics?: CodeMetrics
  ): string {
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? "dark"
        : "default";

    const context = this.getViewContext();

    const llm = llmAvailability || { enabled: false, provider: "openai", model: "" };
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">

        <meta http-equiv="Content-Security-Policy" content="${EnvironmentDetector.getContentSecurityPolicy(nonce, this.getWebview()?.cspSource || "'self'")}">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Code Flowchart</title>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js"></script>
        <script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/svg-pan-zoom@${SVG_PAN_ZOOM_VERSION}/dist/svg-pan-zoom.min.js"></script>
        <style>
          @font-face {
            font-family: 'JetBrains Mono';
            src: url('${this.getWebview()?.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "fonts", "JetBrainsMono-Regular.woff2"))}') format('woff2');
            font-style: normal;
            font-weight: 400;
            font-display: swap;
          }
            :root {
                --hover-fill: rgba(255, 165, 0, 0.18);
                --hover-stroke: #ff6b35;
                --hover-stroke-width: 3px;
                --hover-edge-color: #ff6b35;
                --hover-edge-width: 3px;
            }

            body, html {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
                display: flex;
                justify-content: center;
                align-items: center;
                overflow: hidden;
            }
            #container {
                width: 100%;
                height: 100%;
                ${
                  context.isPanel
                    ? "margin-top: 60px; height: calc(100% - 80px);"
                    : ""
                }
            }
            .mermaid { width: 100%; height: 100%; }
            .mermaid svg { width: 100%; height: 100%; }
            .mermaid .code-label {
              font-family: 'JetBrains Mono', Consolas, monospace !important;
              /* JetBrains Mono 的连字会把 != 画成不等号，代码必须原样显示 */
              font-variant-ligatures: none;
              font-feature-settings: 'liga' 0, 'calt' 0;
            }
            /* 合并块内的行：只做行级反馈，整块轮廓交给节点外框 */
            .mermaid .code-cell {
              font-family: 'JetBrains Mono', Consolas, monospace !important;
              font-variant-ligatures: none;
              font-feature-settings: 'liga' 0, 'calt' 0;
            }
            .mermaid .code-cell:hover {
              background: rgba(255, 165, 0, 0.10) !important;
              box-shadow: inset 2px 0 0 var(--hover-stroke);
            }
            .mermaid .code-cell:hover .code-cell-code {
              filter: drop-shadow(0 0 6px var(--hover-stroke));
            }
            /* 折叠钮：画在判断节点左侧外面的 2 倍大角标（由 decorateFoldBadges 生成） */
            .mermaid .fold-badge {
              cursor: pointer;
            }
            .mermaid .fold-badge circle {
              fill: var(--vscode-editorWidget-background, #2d2d2d);
              stroke: var(--vscode-descriptionForeground);
              stroke-width: 1;
            }
            .mermaid .fold-badge text {
              fill: var(--vscode-editor-foreground);
              font-family: 'Segoe UI Symbol', sans-serif;
              font-size: 18px;
              font-weight: 700;
              user-select: none;
            }
            .mermaid .fold-badge:hover circle {
              stroke: var(--hover-stroke);
              stroke-width: 2;
            }
            /* 折叠后的摘要节点用虚线框，表示里面还有东西 */
            .mermaid .node-folded .label-container,
            .mermaid .node-folded rect,
            .mermaid .node-folded path {
              stroke-dasharray: 5 4 !important;
            }
            /* 行内编辑：去掉行分隔线与底色，只留输入框自己的描边 */
            .mermaid .code-cell.is-editing {
              border-top-color: transparent !important;
              background: transparent !important;
              box-shadow: none !important;
            }
            /* 编辑框的字体、内边距、宽度全部由 startCodeEdit 逐条内联复制，
               这里不能再写 !important 的 inherit，否则会盖掉内联值 */
            .mermaid .code-cell-editor {
              font-variant-ligatures: none;
            }
            .mermaid .boolean-edge-label,
            .mermaid .boolean-edge-label * {
              font-family: 'Segoe UI Symbol', sans-serif !important;
              background: transparent !important;
            }
            .mermaid .boolean-edge-label-bkg {
              background: transparent !important;
            }
            .mermaid .boolean-edge-label--false,
            .mermaid .boolean-edge-label--false * {
              color: #d93025 !important;
            }

            /* Node highlighting styles */
            .highlighted > rect,
            .highlighted > polygon,
            .highlighted > circle,
            .highlighted > path {
                stroke: var(--vscode-editor-selectionBackground) !important;
                stroke-width: 4px !important;
            }

            /* 合并块只在小节上做选中反馈，悬停不给整块铺色（B 已去除） */
            .mermaid .node.highlighted .code-cell {
              background: rgba(90, 160, 255, 0.12) !important;
            }

            /* Transitions */
            .mermaid svg .node > *, .mermaid .edge-path, .mermaid .edge-path path, .mermaid .arrowhead, .mermaid .arrowhead path, .mermaid line, .mermaid g > path {
                transition: fill 0.15s ease-in-out, stroke 0.15s ease-in-out, filter 0.15s ease-in-out, stroke-width 0.15s ease-in-out;
            }


            
            /* 点击/光标驱动的光晕：不再由悬停触发 */
            .mermaid svg .node.glow > *,
            .mermaid svg .node.glow-child > * {
                fill: var(--hover-fill) !important;
                stroke: var(--hover-stroke) !important;
                stroke-width: var(--hover-stroke-width) !important;
                filter: drop-shadow(0 0 8px var(--hover-stroke));
            }

            /* 合并块：外框保留光晕，文字层不加光晕 */
            .mermaid svg .node.glow:has(.code-stack) > g.label,
            .mermaid svg .node.glow-child:has(.code-stack) > g.label {
                filter: none !important;
            }
            
            /* Enhanced edge highlighting that works with different Mermaid edge structures */
            .mermaid g[class*="edge"].glow > *,
            .mermaid g[id^="L_"].glow > *,
            .mermaid path[class*="edge"].glow,
            .mermaid g.glow > path,
            .mermaid g.edgePath.glow > path.path {
                stroke: var(--hover-edge-color) !important;
                stroke-width: var(--hover-edge-width) !important;
                filter: drop-shadow(0 0 2px var(--hover-edge-color));
            }

            /* Arrow markers for highlighted edges */
            .mermaid g[class*="edge"].glow polygon,
            .mermaid g[id^="L_"].glow polygon,
            .mermaid g.glow polygon,
            .mermaid g.edgePath.glow polygon {
                fill: var(--hover-edge-color) !important;
                stroke: var(--hover-edge-color) !important;
            }

            /* Edge labels */
            .mermaid g[class*="edge"].glow text,
            .mermaid g[id^="L_"].glow text,
            .mermaid g.glow text {
                fill: var(--hover-edge-color) !important;
                font-weight: bold !important;
            }
            
            #mermaid-source { display: none; }

            /* Other styles for controls */
            ${ this.getStylesForControls(context) }
        </style>
    </head>
    <body class="vars-open">
        ${ this.getHtmlForControls(context, codeMetrics) }
        ${ this.getHtmlForVarsPanel() }
        <div id="container">
            <div class="mermaid">${flowchartSyntax}</div>
        </div>
        <div id="mermaid-source">${flowchartSyntax.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>

        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            const INITIAL_LLM = ${JSON.stringify(llm)};
            const INITIAL_NODE_ZOOM_FONT_SCALE = ${BaseFlowchartProvider.getNodeZoomFontScale()};
            let nodeZoomFontScale = INITIAL_NODE_ZOOM_FONT_SCALE;
            let isLLMEnabled = false;

            function onNodeClick(start, end) {
                vscode.postMessage({
                    command: 'highlightCode',
                    payload: { start, end }
                });
            }

            let highlightedNodeId = null;
            // 由 setupInteractions 赋值的两个回调：重绘后重建光晕、光标驱动光晕
            let glowRefresh = null;
            let setCursorGlow = null;
            // 重渲染后复用的 pan/zoom 实例
            let panZoomInstance = null;
            // 由面板命令触发的节点聚焦处理（setupInteractions 里赋值）
            let focusNodeKindHandler = null;

            function applyMetricsToPanel(metrics) {
                if (!metrics) {
                    return;
                }
                const values = document.querySelectorAll('#metrics-panel .metrics-value');
                const nums = [
                    metrics.linesOfCode,
                    metrics.numberOfNodes,
                    metrics.numberOfEdges,
                    metrics.decisionPoints,
                    metrics.returnStatements,
                    metrics.functionParameters,
                ];
                values.forEach((el, index) => {
                    if (index < nums.length) {
                        el.textContent = String(nums[index]);
                    }
                });
            }

            // 记录当前视口：缩放与平移量，重渲染后原样还回去
            function captureViewState() {
                if (!panZoomInstance) {
                    return null;
                }
                const svg = document.querySelector('.mermaid svg');
                if (!svg) {
                    return null;
                }
                return {
                    zoom: panZoomInstance.getZoom(),
                    pan: panZoomInstance.getPan(),
                };
            }

            // 重渲染后恢复视口：编辑引起的刷新一律保持缩放比例和位置，
            // 只有用户自己的缩放/平移操作（以及切文件）才能改变视口
            function restoreViewState(state) {
                if (!panZoomInstance || !state) {
                    return;
                }
                const apply = () => {
                    panZoomInstance.zoom(state.zoom);
                    if (state.pan) {
                        panZoomInstance.pan(state.pan);
                    }
                };
                apply();
                // mermaid 布局可能还有一帧的收尾，下一帧再对齐一次
                requestAnimationFrame(apply);
            }

            // 切函数/切文件：视口必须回到“整张图刚好铺满”的初始状态
            function resetViewState() {
                const apply = () => {
                    if (!panZoomInstance) {
                        return;
                    }
                    panZoomInstance.resize();
                    panZoomInstance.fit();
                    panZoomInstance.center();
                };
                apply();
                requestAnimationFrame(apply);
            }

            // 清空画布：旧图的 svg、pan/zoom 实例、高亮状态全部丢掉，
            // 避免切换函数的那一瞬间还残留上一个函数的节点
            function clearCanvas(mermaidDiv, sourceDiv) {
                if (panZoomInstance) {
                    try {
                        panZoomInstance.destroy();
                    } catch (error) {
                        console.warn('[CodeVisualizer] destroy pan/zoom failed:', error);
                    }
                    panZoomInstance = null;
                }
                mermaidDiv.replaceChildren();
                mermaidDiv.removeAttribute('data-processed');
                if (sourceDiv) {
                    sourceDiv.textContent = '';
                }
                highlightedNodeId = null;
            }

            function updateLlmToggle(llmApplied) {
                try {
                    if (llmApplied === undefined) {
                        return;
                    }
                    isLLMEnabled = !!llmApplied;
                    localStorage.setItem('codevisualizer-llm-enabled', llmApplied ? 'true' : 'false');
                    const llmToggle = document.getElementById('llm-toggle');
                    if (llmToggle) {
                        llmToggle.textContent = llmApplied ? '✓ LLM' : 'LLM';
                        llmToggle.title = llmApplied ? 'Disable LLM labels' : 'Enable LLM labels';
                        llmToggle.removeAttribute('disabled');
                    }
                } catch (error) {
                    console.warn('[CodeVisualizer] Unable to persist LLM state:', error);
                }
            }

            // 统一的图渲染入口：同一函数刷新保留视口；切函数/切文件先清空画布再重置视口
            function renderGraphSource(newSource, options) {
                const mermaidDiv = document.querySelector('.mermaid');
                const sourceDiv = document.getElementById('mermaid-source');
                if (!mermaidDiv || !sourceDiv) {
                    return;
                }
                const opts = options || {};
                const keepView = !!opts.preserveView;
                const state = keepView ? captureViewState() : null;

                const idx = newSource.toLowerCase().indexOf('graph ');
                const finalSrc = idx >= 0 ? newSource.slice(idx) : newSource;

                if (keepView) {
                    const existingSvg = mermaidDiv.querySelector('svg');
                    if (existingSvg) {
                        existingSvg.remove();
                    }
                    mermaidDiv.removeAttribute('data-processed');
                } else {
                    // 切函数/切文件：先把上一个函数的图彻底清掉，再画新的
                    clearCanvas(mermaidDiv, sourceDiv);
                }
                mermaidDiv.textContent = finalSrc;
                sourceDiv.textContent = newSource.replace(/</g, '&lt;').replace(/>/g, '&gt;');

                const run = async () => {
                    try {
                        if (typeof mermaid.run === 'function') {
                            await mermaid.run({ querySelector: '.mermaid' });
                        } else if (typeof mermaid.init === 'function') {
                            mermaid.init(undefined, '.mermaid');
                        }
                        let attempts = 0;
                        const checkAndSetup = () => {
                            const svgElement = document.querySelector('.mermaid svg');
                            if (svgElement) {
                                setupInteractions(svgElement);
                                decorateFoldBadgesWithRetry(svgElement);
                                if (highlightedNodeId) {
                                    const hl = document.getElementById(highlightedNodeId);
                                    if (hl) {
                                        hl.classList.add('highlighted');
                                    }
                                }
                                if (typeof glowRefresh === 'function') {
                                    glowRefresh();
                                }
                                if (typeof setCursorGlow === 'function') {
                                    setCursorGlow(highlightedNodeId);
                                }
                                if (state) {
                                    restoreViewState(state);
                                } else {
                                    resetViewState();
                                }
                            } else if (attempts < 20) {
                                attempts += 1;
                                setTimeout(checkAndSetup, 100);
                            } else {
                                console.warn('[CodeVisualizer] SVG not found after mermaid re-render');
                            }
                        };
                        checkAndSetup();
                    } catch (error) {
                        console.error('[CodeVisualizer] Error re-rendering mermaid:', error);
                    }
                };
                run();

                updateLlmToggle(opts.llmApplied);
            }

            // 可折叠角标：贴在节点形状左侧外面，尺寸约是行内符号的 2 倍，
            // 追加在 SVG 内部，平移/缩放会跟着图一起动，也不会被标签框裁剪
            function decorateFoldBadges(svgRoot) {
                // mermaid 可能把自定义类挂在 g.node 或内层形状上，这里统一归到 g.node
                const found = Array.from(
                    svgRoot.querySelectorAll('.node-folded, .node-foldable')
                );
                const nodes = [];
                found.forEach((element) => {
                    const host = element.closest('g.node') || element;
                    if (nodes.indexOf(host) < 0) {
                        nodes.push(host);
                    }
                });
                // 先量好尺寸再插角标，避免刚插入的元素影响后续节点的 bbox
                const boxes = nodes.map((node) => {
                    try {
                        return node.getBBox();
                    } catch (error) {
                        return null;
                    }
                });
                const NS = 'http://www.w3.org/2000/svg';
                nodes.forEach((node, index) => {
                    const box = boxes[index];
                    if (!box || box.width === 0 || box.height === 0) {
                        return;
                    }
                    const existing = node.querySelector('.fold-badge');
                    if (existing) {
                        existing.remove();
                    }
                    const collapsed = node.classList.contains('node-folded');
                    const rawId = node.getAttribute('data-id') || node.id || '';
                    // 注意：这段代码在 TS 模板字符串里，正则不能写 \\d（会被去掉反斜杠）
                    const anchorId = String(rawId)
                        .replace(/^flowchart-/, '')
                        .replace(/-[0-9]+$/, '');
                    const centerX = box.x - 24;
                    const centerY = box.y + box.height / 2;
                    const badge = document.createElementNS(NS, 'g');
                    badge.setAttribute('class', 'fold-badge');
                    badge.setAttribute('data-anchor', anchorId);
                    badge.setAttribute('data-collapsed', collapsed ? '1' : '0');
                    const circle = document.createElementNS(NS, 'circle');
                    circle.setAttribute('cx', String(centerX));
                    circle.setAttribute('cy', String(centerY));
                    circle.setAttribute('r', '13');
                    const text = document.createElementNS(NS, 'text');
                    text.setAttribute('x', String(centerX));
                    text.setAttribute('y', String(centerY + 6));
                    text.setAttribute('text-anchor', 'middle');
                    text.textContent = collapsed ? '▾' : '▸';
                    badge.appendChild(circle);
                    badge.appendChild(text);
                    node.appendChild(badge);
                });
                return nodes.length;
            }

            // 大图渲染较慢：节点类名可能还没落到 DOM 上，短间隔重试几次
            function decorateFoldBadgesWithRetry(svgRoot, attempts) {
                const remaining = typeof attempts === 'number' ? attempts : 20;
                const count = decorateFoldBadges(svgRoot);
                if (count === 0 && remaining > 0) {
                    setTimeout(
                        () => decorateFoldBadgesWithRetry(svgRoot, remaining - 1),
                        150
                    );
                }
            }

            // 面板/侧边栏宽度变化（拖动分隔条、放大视图）后必须重新适配，
            // 否则 svg-pan-zoom 还按旧视口平移，图会被裁到视野外
            let viewportResizeTimer = null;
            window.addEventListener('resize', () => {
                if (!panZoomInstance) {
                    return;
                }
                if (viewportResizeTimer) {
                    clearTimeout(viewportResizeTimer);
                }
                viewportResizeTimer = setTimeout(() => {
                    if (!panZoomInstance) {
                        return;
                    }
                    try {
                        panZoomInstance.resize();
                        panZoomInstance.fit();
                        panZoomInstance.center();
                    } catch (error) {
                        console.warn('[CodeVisualizer] refit after resize failed:', error);
                    }
                }, 120);
            });

            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'highlightNode': {
                        const newId = message.payload.nodeId;
                        highlightedNodeId = newId;
                        // 光标在哪个节点上，就点亮哪个节点的光晕
                        if (typeof setCursorGlow === 'function') {
                            setCursorGlow(newId);
                        }
                        break;
                    }

                    case 'focusNodeKind':
                        if (typeof focusNodeKindHandler === 'function') {
                            focusNodeKindHandler(message.payload && message.payload.kind);
                        }
                        break;

                    case 'simulateFoldClick': {
                        const badges = document.querySelectorAll('.fold-badge');
                        if (badges.length > 0) {
                            badges[0].dispatchEvent(
                                new MouseEvent('click', { bubbles: true, cancelable: true })
                            );
                        }
                        break;
                    }

                    case 'simulateGlowClick': {
                        const svgRoot = document.querySelector('.mermaid svg');
                        if (!svgRoot) {
                            break;
                        }
                        const kind = message.payload && message.payload.kind;
                        if (kind === 'blank') {
                            svgRoot.dispatchEvent(
                                new MouseEvent('click', { bubbles: true, cancelable: true })
                            );
                            break;
                        }
                        const nodeElement = Array.from(svgRoot.querySelectorAll('g.node')).find(
                            (node) => !node.classList.contains('glow')
                        );
                        if (nodeElement) {
                            const shape = nodeElement.querySelector('rect, polygon, path') || nodeElement;
                            shape.dispatchEvent(
                                new MouseEvent('click', { bubbles: true, cancelable: true })
                            );
                        }
                        break;
                    }

                    case 'nodeZoomFontScale':
                        if (typeof message.payload.scale === 'number' && isFinite(message.payload.scale)) {
                            nodeZoomFontScale = Math.max(0.8, Math.min(0.8, message.payload.scale));
                        }
                        break;

                    case 'foldDefaultState': {
                        const box = document.getElementById('fold-default-checkbox');
                        if (box instanceof HTMLInputElement) {
                            box.checked = message.payload.expanded === true;
                        }
                        break;
                    }

                    case 'simulateFoldDefaultClick': {
                        const box = document.getElementById('fold-default-checkbox');
                        if (box instanceof HTMLInputElement) {
                            box.checked = !box.checked;
                            box.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        break;
                    }

                    case 'applyGraph':
                    case 'applyMermaid': {
                        renderGraphSource(message.payload.mermaid, {
                            preserveView: message.payload.preserveView !== false,
                            llmApplied: typeof message.payload.llmApplied === 'boolean' ? message.payload.llmApplied : undefined,
                        });
                        if (message.payload.metrics) {
                            applyMetricsToPanel(message.payload.metrics);
                        }
                        break;
                    }
                    case 'applyMetrics': {
                        applyMetricsToPanel(message.payload.metrics);
                        break;
                    }
                    case 'editResult': {
                        if (!message.payload.ok) {
                            console.warn('[CodeVisualizer] edit rejected:', message.payload.reason);
                        }
                        break;
                    }
                    case 'applySymbols': {
                        applySymbols(message.payload);
                        break;
                    }
                    case 'llmAvailability': {
                        setLLMButton(message.payload);
                        break;
                    }
                    case 'exportError':
                        // VSC will show the error message
                        break;

                }
            });


            // Enhanced error handling for different environments
            function initializeMermaid() {
                try {
                    mermaid.initialize({
                        startOnLoad: true,
                        theme: '${theme}',
                        securityLevel: 'loose',
                        flowchart: {
                            useMaxWidth: false,
                            htmlLabels: true,
                            curve: 'basis'
                        }
                    });
                } catch (error) {
                    console.warn('Mermaid initialization error:', error);
                    // Try with more basic configuration for compatibility
                    try {
                        mermaid.initialize({
                            startOnLoad: true,
                            theme: '${theme}',
                            securityLevel: 'loose'
                        });
                    } catch (fallbackError) {
                        console.error('Mermaid fallback initialization failed:', fallbackError);
                    }
                }
            }

            // Initialize mermaid with error handling
            if (typeof mermaid !== 'undefined') {
                initializeMermaid();
            } else {
                console.error('Mermaid library not loaded');
            }

            function setupInteractions(svgElement) {
                if (!svgElement) return;

                svgElement.querySelectorAll('.node.node-decision > rect').forEach((rect) => {
                  const x = Number(rect.getAttribute('x'));
                  const y = Number(rect.getAttribute('y'));
                  const width = Number(rect.getAttribute('width'));
                  const height = Number(rect.getAttribute('height'));
                  const centerX = x + width / 2;
                  const centerY = y + height / 2;
                  const diamondWidth = width * 1.25;
                  const diamondHeight = height * 1.6;
                  const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                  diamond.setAttribute('points', [
                    (centerX - diamondWidth / 2) + ',' + centerY,
                    centerX + ',' + (centerY - diamondHeight / 2),
                    (centerX + diamondWidth / 2) + ',' + centerY,
                    centerX + ',' + (centerY + diamondHeight / 2),
                  ].join(' '));
                  Array.from(rect.attributes).forEach((attribute) => {
                    if (!['x', 'y', 'width', 'height', 'rx', 'ry'].includes(attribute.name)) {
                      diamond.setAttribute(attribute.name, attribute.value);
                    }
                  });
                  rect.replaceWith(diamond);
                });

                svgElement.querySelectorAll('.edgeLabel').forEach((label) => {
                  const text = label.textContent.trim();
                  if (text === String.fromCodePoint(0x2714, 0xfe0f)) {
                    label.classList.add('boolean-edge-label');
                  } else if (text === String.fromCodePoint(0x2716)) {
                    label.classList.add('boolean-edge-label', 'boolean-edge-label--false');
                  }
                  if (label.classList.contains('boolean-edge-label')) {
                    label.querySelector('.labelBkg')?.classList.add('boolean-edge-label-bkg');
                  }
                });

                // Track user interaction state for pan/zoom
                let interactionTimeout = null;
                function notifyInteractionStart() {
                    vscode.postMessage({ command: 'userInteractionStart', payload: {} });
                    if (interactionTimeout) {
                        clearTimeout(interactionTimeout);
                    }
                }
                function notifyInteractionEnd() {
                    if (interactionTimeout) {
                        clearTimeout(interactionTimeout);
                    }
                    // Delay end notification to avoid flickering during rapid interactions
                    interactionTimeout = setTimeout(() => {
                        vscode.postMessage({ command: 'userInteractionEnd', payload: {} });
                    }, 300);
                }

                if (panZoomInstance) {
                    try {
                        panZoomInstance.destroy();
                    } catch (error) {
                        console.warn('[CodeVisualizer] destroy pan/zoom failed:', error);
                    }
                    panZoomInstance = null;
                }
                panZoomInstance = svgPanZoom(svgElement, {
                    zoomEnabled: true,
                    controlIconsEnabled: true,
                    fit: true,
                    center: true,
                    minZoom: 0.1,
                    maxZoom: 20,
                    zoomScaleSensitivity: 0.2,
                    // 双击用于进入行内编辑，不能再用作缩放
                    dblClickZoomEnabled: false,
                    onZoom: function() {
                        notifyInteractionStart();
                        notifyInteractionEnd();
                    },
                    onPan: function() {
                        notifyInteractionStart();
                        notifyInteractionEnd();
                    }
                });

                  // 局部放大：把某个节点放大并居中（双击节点触发）
                  function zoomToNode(target) {
                    const nodeBounds = target.getBoundingClientRect();
                    const viewBounds = svgElement.getBoundingClientRect();
                    if (nodeBounds.width === 0 || nodeBounds.height === 0 || viewBounds.width === 0 || viewBounds.height === 0) {
                      notifyInteractionEnd();
                      return;
                    }

                    const focus = {
                      x: nodeBounds.left + nodeBounds.width / 2,
                      y: nodeBounds.top + nodeBounds.height / 2,
                    };
                    // Zoom so the code text inside the node renders at nodeZoomFontScale
                    // times its natural size. This value is the zoom ceiling: it does not
                    // depend on the current zoom, so changing the setting always changes the
                    // result (the previous formula multiplied the already fitted zoom by a
                    // fill factor, which saturated at maxZoom for every value).
                    const currentZoom = panZoomInstance.getZoom();
                    const codeElement = target.querySelector('.code-label') || target;
                    const baseFontPx = parseFloat(window.getComputedStyle(codeElement).fontSize) || 16;
                    let currentScale = currentZoom;
                    try {
                      const bbox = target.getBBox();
                      if (bbox.width > 0 && nodeBounds.width > 0) {
                        // Rendered px / SVG user unit: covers pan-zoom and the SVG viewBox scale
                        currentScale = nodeBounds.width / bbox.width;
                      }
                    } catch {
                      // getBBox is unavailable for non-SVG targets; fall back to the pan-zoom level
                    }
                    if (!isFinite(currentScale) || currentScale <= 0) {
                      currentScale = currentZoom;
                    }
                    const targetZoom = Math.max(0.1, Math.min(20, currentZoom * nodeZoomFontScale / currentScale));
                    console.debug('[CodeVisualizer] node focus zoom', {
                      nodeZoomFontScale,
                      baseFontPx,
                      currentZoom,
                      currentScale,
                      renderedFontPx: baseFontPx * currentScale * targetZoom / currentZoom,
                      targetZoom,
                    });
                    panZoomInstance.zoomAtPoint(targetZoom, focus);

                    // pan() only lands on the next animation frame, so re-measure and
                    // correct a few frames until the node is truly centered.
                    let centerAttempts = 0;
                    const centerNode = () => {
                      const zoomedBounds = target.getBoundingClientRect();
                      const dx = viewBounds.left + viewBounds.width / 2 - (zoomedBounds.left + zoomedBounds.width / 2);
                      const dy = viewBounds.top + viewBounds.height / 2 - (zoomedBounds.top + zoomedBounds.height / 2);
                      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
                        return true;
                      }
                      const pan = panZoomInstance.getPan();
                      panZoomInstance.pan({ x: pan.x + dx, y: pan.y + dy });
                      return false;
                    };
                    const centerStep = () => {
                      centerAttempts += 1;
                      if (centerNode() || centerAttempts >= 3) {
                        notifyInteractionEnd();
                        return;
                      }
                      requestAnimationFrame(centerStep);
                    };
                    requestAnimationFrame(centerStep);
                  }

                  // 右键单击代码行进入编辑；只有在空白处右键才复位全图，
                  // 不可编辑的节点（Start/End/break/case 等）右键什么都不做
                  svgElement.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    const target = event.target instanceof Element ? event.target : null;
                    const row = target
                      ? target.closest('.code-cell[data-editable="1"], .code-label[data-editable="1"]')
                      : null;
                    if (!row) {
                      if (target && target.closest('.node')) {
                        return;
                      }
                      notifyInteractionStart();
                      panZoomInstance.fit();
                      panZoomInstance.center();
                      notifyInteractionEnd();
                      return;
                    }
                    const start = Number(row.getAttribute('data-start'));
                    const end = Number(row.getAttribute('data-end'));
                    const codeElement = row.classList.contains('code-cell')
                      ? row.querySelector('.code-cell-code')
                      : row;
                    startCodeEdit(codeElement || row, start, end);
                  });

                  // 折叠钮：单击折叠/展开该判断的 ✔️ 分支（捕获阶段先拦下，
                  // 否则 mermaid 的 click 指令会把这次点击当成"跳到代码"）
                  svgElement.addEventListener('click', (event) => {
                    const target = event.target instanceof Element ? event.target : null;
                    const toggle = target ? target.closest('.fold-badge, .fold-toggle') : null;
                    if (!toggle) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const anchorId = toggle.getAttribute('data-anchor');
                    if (!anchorId) {
                      return;
                    }
                    const currentlyCollapsed = toggle.getAttribute('data-collapsed') === '1';
                    vscode.postMessage({
                      command: 'toggleFold',
                      payload: { anchorId, collapsed: !currentlyCollapsed },
                    });
                  }, true);

                  // 双击节点局部放大；双击空白处复位全图
                  svgElement.addEventListener('dblclick', (event) => {
                    event.preventDefault();
                    const target = event.target instanceof Element ? event.target.closest('.node') : null;
                    notifyInteractionStart();
                    if (!target) {
                      panZoomInstance.fit();
                      panZoomInstance.center();
                      notifyInteractionEnd();
                      return;
                    }
                    zoomToNode(target);
                  });

                // 按节点类型定位并复用右键聚焦的放大逻辑。
                // C 解析器产出的是 decision + loop_end，Python/JS 才有 loop_start，
                // 所以 "loop" 这类别名要依次尝试多个类名，再退化到按标签文字匹配。
                const FOCUS_KIND_ALIASES = {
                    loop: {
                        // pivot 同时收/发 continue 边（如 for 的自增节点），两条 🔄 都在它旁边
                        kinds: ['loop-start', 'loop-pivot', 'loop-header', 'loop-end'],
                        text: ['for (', 'for(', 'while (', 'while(', 'do {'],
                    },
                };
                focusNodeKindHandler = (kind, attempt) => {
                    const alias = FOCUS_KIND_ALIASES[String(kind || '').toLowerCase()];
                    const kinds = alias ? alias.kinds : [String(kind || '').replace(/^node-/, '')];
                    const texts = alias ? alias.text || [] : [];
                    let target = null;
                    for (const name of kinds) {
                        target =
                            svgElement.querySelector('.node.node-' + name) ||
                            svgElement.querySelector('.node.' + name);
                        if (target) {
                            break;
                        }
                    }
                    if (!target && texts.length > 0) {
                        target = Array.from(svgElement.querySelectorAll('.node')).find((node) => {
                            const text = (node.textContent || '').replace(/\s+/g, ' ');
                            return texts.some((token) => text.indexOf(token) >= 0);
                        }) || null;
                    }
                    if (!target) {
                        // 图可能还在重渲染，短暂重试
                        const tries = (attempt || 0) + 1;
                        if (tries <= 20) {
                            setTimeout(() => focusNodeKindHandler(kind, tries), 100);
                        }
                        return;
                    }
                    // 直接复用双击节点的放大逻辑
                    notifyInteractionStart();
                    zoomToNode(target);
                };

                // Track mouse interactions for panning/dragging
                let isMouseDown = false;
                let isDragging = false;
                svgElement.addEventListener('mousedown', (e) => {
                    // Only track if not clicking on a node (nodes have their own click handlers)
                    if (!e.target.closest('.node')) {
                        isMouseDown = true;
                        notifyInteractionStart();
                    }
                });
                svgElement.addEventListener('mousemove', (e) => {
                    if (isMouseDown) {
                        isDragging = true;
                    }
                });
                svgElement.addEventListener('mouseup', () => {
                    if (isMouseDown) {
                        isMouseDown = false;
                        notifyInteractionEnd();
                        isDragging = false;
                    }
                });
                svgElement.addEventListener('mouseleave', () => {
                    if (isMouseDown) {
                        isMouseDown = false;
                        isDragging = false;
                        notifyInteractionEnd();
                    }
                });

                // Parse edge metadata from mermaid source comments
                function parseEdgeMetadata() {
                    const mermaidSource = document.getElementById('mermaid-source').textContent;
                    const edgeMetadata = new Map();
                    
                    const lines = mermaidSource.split('\\n');
                    for (const line of lines) {
                        const match = line.match(/%% EDGE_META:([^:]+):([^:]+)/);
                        if (match) {
                            const [, source, target] = match;
                            if (!edgeMetadata.has(source)) {
                                edgeMetadata.set(source, []);
                            }
                            edgeMetadata.get(source).push(target);
                        }
                    }
                    return edgeMetadata;
                }

                function extractBaseId(fullNodeId) {
                    if (!fullNodeId) return '';
                    // Remove flowchart prefix and suffix numbers
                    let base = fullNodeId.startsWith('flowchart-') 
                        ? fullNodeId.replace(/^flowchart-/, '') 
                        : fullNodeId;
                    base = base.replace(/-[\\d-]+$/, '');
                    return base;
                }

                function findOutgoingEdges(fullNodeId, edgeMetadata) {
                    const baseId = extractBaseId(fullNodeId);
                    if (!baseId) return [];

                    const outgoingEdges = [];
                    const targets = edgeMetadata.get(baseId) || [];
                    
                    // Look for edges with IDs that contain the source->target relationship
                    for (const target of targets) {
                        const edgePatterns = [
                            "L_" + baseId + "_" + target + "_",
                            baseId + "_" + target,
                            baseId + "-" + target,
                            "edge_" + baseId + "_" + target
                        ];
                        
                        for (const pattern of edgePatterns) {
                            const matchingEdge = document.querySelector('[id*="' + pattern + '"]');
                            if (matchingEdge) {
                                outgoingEdges.push(matchingEdge);
                                break;
                            }
                        }
                    }
                    return outgoingEdges;
                }

                function findConnectedNodes(baseId, edgeMetadata) {
                    const targets = edgeMetadata.get(baseId) || [];
                    const connectedNodes = [];
                    
                    for (const targetBaseId of targets) {
                        // Try multiple patterns to find target nodes
                        const patterns = [
                            '[id*="' + targetBaseId + '"]',
                            '#flowchart-' + targetBaseId + '-',
                            '[id^="flowchart-' + targetBaseId + '"]'
                        ];
                        
                        for (const pattern of patterns) {
                            const targetNode = document.querySelector(pattern);
                            if (targetNode && !connectedNodes.includes(targetNode)) {
                                connectedNodes.push(targetNode);
                                break;
                            }
                        }
                    }
                    return connectedNodes;
                }

                // Parse edge metadata once
                const edgeMetadata = parseEdgeMetadata();

                // 光晕：click 锁定一个节点直到点空白；光标也会驱动一个节点
                const glowState = {
                    cursorNodeId: null,
                    pinnedNodeId: null,
                };

                function findNodeElement(nodeId) {
                    if (!nodeId) {
                        return null;
                    }
                    // 一律查当前页面上的 SVG：重绘后旧引用会失效，光晕就永远清不掉了
                    const root = document.querySelector('.mermaid svg');
                    if (!root) {
                        return null;
                    }
                    return (
                        document.getElementById(nodeId) ||
                        root.querySelector('[data-id="' + nodeId + '"]') ||
                        root.querySelector('.node[id^="flowchart-' + nodeId + '-"]') ||
                        root.querySelector('#flowchart-' + nodeId + '-0')
                    );
                }

                function clearGlowClasses() {
                    document
                        .querySelectorAll('.mermaid .glow, .mermaid .glow-child')
                        .forEach((element) => {
                            element.classList.remove('glow', 'glow-child');
                        });
                }

                // 把光晕打到一个节点上，同时点亮它的出边与直接后继
                function paintGlow(targetNode) {
                    if (!targetNode) {
                        return;
                    }
                    targetNode.classList.add('glow');
                    const fullNodeId = targetNode.id;
                    if (!fullNodeId) {
                        return;
                    }
                    const baseId = extractBaseId(fullNodeId);
                    findOutgoingEdges(fullNodeId, edgeMetadata).forEach((edge) => {
                        edge.classList.add('glow');
                    });
                    findConnectedNodes(baseId, edgeMetadata).forEach((connectedNode) => {
                        connectedNode.classList.add('glow-child');
                    });
                }

                // 点击锁定的优先，没有锁定时用光标所在节点
                function refreshGlow() {
                    clearGlowClasses();
                    const activeId = glowState.pinnedNodeId || glowState.cursorNodeId;
                    paintGlow(findNodeElement(activeId));
                }

                glowRefresh = refreshGlow;
                setCursorGlow = (nodeId) => {
                    glowState.cursorNodeId = nodeId || null;
                    refreshGlow();
                };

                // 点击节点 → 持续光晕；点击空白 → 取消锁定（回到光标节点）
                svgElement.addEventListener('click', (event) => {
                    const target = event.target instanceof Element ? event.target : null;
                    if (!target) {
                        return;
                    }
                    if (target.closest('.fold-badge')) {
                        return;
                    }
                    const nodeElement = target.closest('g.node');
                    if (!nodeElement) {
                        glowState.pinnedNodeId = null;
                        refreshGlow();
                        return;
                    }
                    glowState.pinnedNodeId = nodeElement.id || null;
                    refreshGlow();
                });

                const allNodes = svgElement.querySelectorAll('.node');
                allNodes.forEach((node) => {
                    const fullNodeId = node.id;
                    if (!fullNodeId) return;
                    // 悬停不再触发光晕：点一下才亮，点空白才灭
                });

                // 合并块内的每个小节单独可点，点击定位到该语句本身
                svgElement.querySelectorAll('.code-cell[data-start]').forEach((cell) => {
                    const start = Number(cell.getAttribute('data-start'));
                    const end = Number(cell.getAttribute('data-end'));
                    if (!isFinite(start) || !isFinite(end)) {
                        return;
                    }
                    // 双击局部放大、右键编辑都由 svg 上的统一监听处理
                    cell.addEventListener('click', (event) => {
                        // 阻止事件冒泡到整个节点，避免选中整块范围
                        event.stopPropagation();
                        onNodeClick(start, end);
                    });
                });
            }

            function applySymbols(payload) {
                const select = document.getElementById('function-select');
                if (select) {
                    const current = payload.pinnedFunction || '';
                    const options = ['<option value="">Follow cursor</option>'];
                    (payload.functions || []).forEach((fn) => {
                        options.push('<option value="' + fn.name + '">' + fn.name + '</option>');
                    });
                    select.innerHTML = options.join('');
                    select.value = current;
                    if (!select.dataset.bound) {
                        select.dataset.bound = '1';
                        select.addEventListener('change', () => {
                            vscode.postMessage({ command: 'requestFunction', payload: { name: select.value || undefined } });
                        });
                    }
                }
                renderVariableList('globals-list', payload.globals);
                renderVariableList('locals-list', payload.locals);
            }

            function renderVariableList(elementId, items) {
                const host = document.getElementById(elementId);
                if (!host) {
                    return;
                }
                host.innerHTML = '';
                if (!items || items.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'var-empty';
                    empty.textContent = '(none)';
                    host.appendChild(empty);
                    return;
                }
                items.forEach((item) => {
                    const row = document.createElement('div');
                    row.className = 'var-item';
                    const label = (item.type ? item.type + ' ' : '') + item.name;
                    row.textContent = label;
                    row.title = label + (item.initializer ? ' = ' + item.initializer : '');
                    row.addEventListener('click', () => {
                        vscode.postMessage({ command: 'revealVariable', payload: { start: item.start, end: item.end } });
                    });
                    host.appendChild(row);
                });
            }

            // 用同字体的隐藏镜像量文本宽度，让编辑框的内容区宽度和原文本完全一致
            // 镜像必须挂到 body 上：代码行是 display:table，绝对定位子元素在里面量出来是 0
            function measureTextWidth(text, fontCss) {
                const mirror = document.createElement('span');
                mirror.style.cssText = 'position:absolute;left:-10000px;top:0;display:inline-block;visibility:hidden;white-space:pre;padding:0;margin:0;border:0;' + fontCss;
                mirror.textContent = text.length > 0 ? text : ' ';
                document.body.appendChild(mirror);
                const width = mirror.getBoundingClientRect().width;
                mirror.remove();
                return width;
            }

            // 双击进入行内编辑，提交后写回源码
            // 只有真实语句行可编辑：Start / End / Loop End 这类合成节点没有可写回的语句。
            // 合并块内传入的是 .code-cell-code，标记在父级 .code-cell 上，所以用 closest 判断
            function startCodeEdit(element, start, end) {
                if (!element || element.dataset.editing === '1' || !isFinite(start) || !isFinite(end)) {
                    return;
                }
                if (!element.closest('[data-editable="1"]')) {
                    return;
                }
                const original = element.textContent || '';
                const hostCell = element.closest('.code-cell') || element;
                const computed = window.getComputedStyle(element);
                const padLeft = parseFloat(computed.paddingLeft) || 0;
                const padRight = parseFloat(computed.paddingRight) || 0;
                const lineHeight = parseFloat(computed.lineHeight) || (parseFloat(computed.fontSize) || 12) * 1.4;
                // 原文本的排版参数逐条复制，父级（mermaid 标签壳）字体不同也不会跑偏
                const fontCss = [
                    'font-family:' + computed.fontFamily,
                    'font-size:' + computed.fontSize,
                    'font-weight:' + computed.fontWeight,
                    'font-style:' + computed.fontStyle,
                    'letter-spacing:' + computed.letterSpacing,
                    'line-height:' + computed.lineHeight,
                    'tab-size:' + computed.tabSize,
                ].join(';');
                const minHeight = Math.max(Math.ceil(lineHeight), element.offsetHeight || 0);

                element.dataset.editing = '1';
                element.style.display = 'none';
                hostCell.classList.add('is-editing');

                const editor = document.createElement('textarea');
                editor.className = 'code-cell-editor';
                editor.rows = 1;
                editor.spellcheck = false;
                editor.value = original;
                // 不用 border：描边改成内阴影，避免进入编辑时文本位置偏移
                editor.style.cssText = [
                    'display:block',
                    'box-sizing:border-box',
                    'margin:0',
                    'padding:' + computed.paddingTop + ' ' + padRight + 'px 0 ' + padLeft + 'px',
                    'color:var(--vscode-input-foreground,#cccccc)',
                    'background:var(--vscode-input-background,#1e1e1e)',
                    'border:0',
                    'box-shadow:inset 0 0 0 1px var(--vscode-focusBorder,#0a84ff)',
                    'outline:none',
                    'resize:none',
                    'overflow:hidden',
                    'appearance:none',
                    '-webkit-appearance:none',
                    'white-space:pre',
                    'text-align:left',
                    'flex:none',
                    fontCss,
                ].join(';');
                element.parentNode.insertBefore(editor, element.nextSibling);

                // 宽度跟着文本走，输入时同步变宽，始终与内容等宽
                const resize = () => {
                    const textWidth = measureTextWidth(editor.value, fontCss);
                    editor.style.width = (textWidth + padLeft + padRight) + 'px';
                    editor.style.height = 'auto';
                    editor.style.height = Math.max(minHeight, editor.scrollHeight) + 'px';
                };
                editor.addEventListener('input', resize);
                resize();

                // 编辑框内的鼠标事件一律不外传：否则拖动选字会变成平移画布
                ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove'].forEach((type) => {
                    editor.addEventListener(type, (event) => event.stopPropagation());
                });
                if (panZoomInstance) {
                    try {
                        panZoomInstance.disablePan();
                    } catch (error) {
                        console.warn('[CodeVisualizer] disable pan failed:', error);
                    }
                }

                editor.focus();
                // 未选状态：只放光标不选中，避免误输入直接覆盖原文
                const caret = editor.value.length;
                editor.setSelectionRange(caret, caret);

                let finished = false;
                const finish = (commit) => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    document.removeEventListener('mousedown', finishOnOutside, true);
                    document.removeEventListener('pointerdown', finishOnOutside, true);
                    document.removeEventListener('touchstart', finishOnOutside, true);
                    window.removeEventListener('blur', finishOnWindowBlur);
                    const value = editor.value;
                    editor.remove();
                    element.style.display = '';
                    delete element.dataset.editing;
                    hostCell.classList.remove('is-editing');
                    if (panZoomInstance) {
                        try {
                            panZoomInstance.enablePan();
                        } catch (error) {
                            console.warn('[CodeVisualizer] enable pan failed:', error);
                        }
                    }
                    if (commit && value !== original) {
                        vscode.postMessage({
                            command: 'editStatement',
                            payload: { start, end, text: value },
                        });
                    }
                };
                // 点击编辑框以外的任何地方都结束编辑：画布 mousedown 被 preventDefault，
                // 焦点不会离开 textarea，blur 不触发，所以必须在捕获阶段自己判断
                const finishOnOutside = (event) => {
                    const target = event.target;
                    if (target === editor || (target instanceof Node && editor.contains(target))) {
                        return;
                    }
                    finish(true);
                };
                const finishOnWindowBlur = () => finish(true);
                document.addEventListener('mousedown', finishOnOutside, true);
                document.addEventListener('pointerdown', finishOnOutside, true);
                document.addEventListener('touchstart', finishOnOutside, true);
                window.addEventListener('blur', finishOnWindowBlur);
                editor.addEventListener('keydown', (event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        finish(true);
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        finish(false);
                    }
                });
                editor.addEventListener('blur', () => finish(true));
            }

            window.addEventListener('load', () => {
                // 告知扩展宿主：脚本已就绪，后续更新可以走消息通道
                vscode.postMessage({ command: 'webviewReady', payload: {} });
                setTimeout(() => {
                    const svgElement = document.querySelector('.mermaid svg');
                    if (svgElement) {
                        setupInteractions(svgElement);
                        decorateFoldBadgesWithRetry(svgElement);
                        if (typeof setCursorGlow === 'function') {
                            setCursorGlow(highlightedNodeId);
                        }
                    } else {
                        console.error('[CodeVisualizer] SVG element for flowchart not found after initial load!');
                    }
                }, 200);

            });

            // Track user interaction for button clicks
            let buttonInteractionTimeout = null;
            function notifyButtonInteractionStart() {
                vscode.postMessage({ command: 'userInteractionStart', payload: {} });
                if (buttonInteractionTimeout) {
                    clearTimeout(buttonInteractionTimeout);
                }
            }
            function notifyButtonInteractionEnd() {
                if (buttonInteractionTimeout) {
                    clearTimeout(buttonInteractionTimeout);
                }
                // Delay end notification to avoid flickering during rapid interactions
                buttonInteractionTimeout = setTimeout(() => {
                    vscode.postMessage({ command: 'userInteractionEnd', payload: {} });
                }, 300);
            }

            function setupButtonHandlers() {
                // 顶部复选框：勾选 = 分支默认展开，取消 = 默认折叠
                const foldDefaultCheckbox = document.getElementById('fold-default-checkbox');
                if (foldDefaultCheckbox && !foldDefaultCheckbox.dataset.bound) {
                    foldDefaultCheckbox.dataset.bound = '1';
                    foldDefaultCheckbox.addEventListener('change', () => {
                        vscode.postMessage({
                            command: 'setFoldDefault',
                            payload: { expanded: foldDefaultCheckbox.checked },
                        });
                    });
                }
                const copyBtn = document.getElementById('copy-mermaid');
                if (copyBtn) {
                    copyBtn.addEventListener('click', () => {
                        notifyButtonInteractionStart();
                        const source = document.getElementById('mermaid-source').textContent;
                        vscode.postMessage({ command: 'copyMermaid', payload: { code: source } });
                        notifyButtonInteractionEnd();
                    });
                }
                const exportSvgBtn = document.getElementById('export-svg');
                if(exportSvgBtn) {
                    exportSvgBtn.addEventListener('click', () => {
                        notifyButtonInteractionStart();
                        exportFlowchart('svg').finally(() => notifyButtonInteractionEnd());
                    });
                }
                
                const exportPngBtn = document.getElementById('export-png');
                if(exportPngBtn) {
                    exportPngBtn.addEventListener('click', () => {
                        notifyButtonInteractionStart();
                        exportFlowchart('png').finally(() => notifyButtonInteractionEnd());
                    });
                }

                const openPanelBtn = document.getElementById('open-panel-btn');
                if (openPanelBtn) {
                    openPanelBtn.addEventListener('click', () => {
                        notifyButtonInteractionStart();
                        vscode.postMessage({ command: 'openInPanel', payload: {} });
                        notifyButtonInteractionEnd();
                    });
                }

                const toolbarToggle = document.getElementById('toolbar-toggle');
                const toolbarContainer = document.getElementById('toolbar-container');
                if (toolbarToggle && toolbarContainer) {
                    let isToolbarHidden = true;

                    function updateToolbarState() {
                    toolbarContainer.classList.toggle('hidden', isToolbarHidden);
                    document.body.classList.toggle('toolbar-hidden', isToolbarHidden);
                        toolbarToggle.title = isToolbarHidden ? 'Show toolbar' : 'Hide toolbar';
                        toolbarToggle.setAttribute('aria-label', toolbarToggle.title);
                    }

                    updateToolbarState();
                    toolbarToggle.addEventListener('click', () => {
                        isToolbarHidden = !isToolbarHidden;
                        updateToolbarState();
                    });
                }

                // Metrics toggle functionality
                const metricsToggle = document.getElementById('metrics-toggle');
                const metricsPanel = document.getElementById('metrics-panel');
                if (metricsToggle && metricsPanel) {
                  let isMetricsHidden = true;
                    
                    function updateMetricsToggleState() {
                        if (isMetricsHidden) {
                            metricsPanel.classList.add('hidden');
                            metricsToggle.textContent = 'Metrics';
                            metricsToggle.title = 'Show metrics display';
                        } else {
                            metricsPanel.classList.remove('hidden');
                            metricsToggle.textContent = 'Metrics';
                            metricsToggle.title = 'Hide metrics display';
                        }
                    }
                    
                    updateMetricsToggleState(); // Set initial state
                    
                    metricsToggle.addEventListener('click', () => {
                        isMetricsHidden = !isMetricsHidden;
                        updateMetricsToggleState();
                    });
                }

            }
            setupButtonHandlers();

            /**
             * Handles exporting the flowchart to SVG or PNG.
             * It generates a clean SVG from the source to ensure no UI controls are included.
             */
            async function exportFlowchart(fileType) {
                try {
                    const mermaidSourceElement = document.getElementById('mermaid-source');
                    if (!mermaidSourceElement || !mermaidSourceElement.textContent) {
                        throw new Error("Could not find Mermaid source code to export.");
                    }

                    const mermaidSource = mermaidSourceElement.textContent
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&amp;/g, '&')
                        .trim();
                    
                    const { svg } = await mermaid.render('export-svg-element', mermaidSource);
                    
                    const parser = new DOMParser();
                    const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
                    const cleanSvgElement = svgDoc.documentElement;

                    if (!cleanSvgElement || cleanSvgElement.tagName !== 'svg') {
                        throw new Error('Invalid SVG generated by Mermaid render');
                    }

                    // Temporarily add to DOM to calculate size
                    const tempDiv = document.createElement('div');
                    tempDiv.style.position = 'absolute';
                    tempDiv.style.visibility = 'hidden';
                    document.body.appendChild(tempDiv);
                    tempDiv.appendChild(cleanSvgElement);
                    const bbox = cleanSvgElement.getBBox();
                    document.body.removeChild(tempDiv);

                    const padding = 20;
                    const finalX = bbox.x - padding;
                    const finalY = bbox.y - padding;
                    const finalWidth = bbox.width + (padding * 2);
                    const finalHeight = bbox.height + (padding * 2);

                    cleanSvgElement.setAttribute('width', finalWidth.toString());
                    cleanSvgElement.setAttribute('height', finalHeight.toString());
                    cleanSvgElement.setAttribute('viewBox', \`\${finalX} \${finalY} \${finalWidth} \${finalHeight}\`);

                    const backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim() || '#ffffff';
                    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    rect.setAttribute('x', finalX.toString());
                    rect.setAttribute('y', finalY.toString());
                    rect.setAttribute('width', finalWidth.toString());
                    rect.setAttribute('height', finalHeight.toString());
                    rect.setAttribute('fill', backgroundColor);
                    cleanSvgElement.insertBefore(rect, cleanSvgElement.firstChild);

                    const finalSvgData = new XMLSerializer().serializeToString(cleanSvgElement);

                    if (fileType === 'svg') {
                        vscode.postMessage({
                            command: 'export',
                            payload: { fileType: 'svg', data: finalSvgData }
                        });
                    } else if (fileType === 'png') {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        if (!ctx) {
                            throw new Error("Could not get canvas 2D context.");
                        }

                        const scale = 2; // For higher DPI
                        canvas.width = finalWidth * scale;
                        canvas.height = finalHeight * scale;
                        ctx.scale(scale, scale);

                        const img = new Image();
                        img.onload = function() {
                            ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
                            const pngData = canvas.toDataURL('image/png').split(',')[1];
                            vscode.postMessage({
                                command: 'export',
                                payload: { fileType: 'png', data: pngData }
                            });
                        };
                        img.onerror = function() {
                            throw new Error("SVG to PNG conversion failed (image load error).");
                        };
                        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(finalSvgData);
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown export error';
                    vscode.postMessage({
                        command: 'exportError',
                        payload: { error: 'Export failed: ' + errorMessage }
                    });
                }
            }

            // LLM toggle functionality
            const llmToggle = document.getElementById('llm-toggle');
            function setLLMButton(availability) {
                if (!llmToggle) return;
                if (!availability || !availability.enabled) {
                    llmToggle.textContent = 'Enable LLM';
                    llmToggle.title = 'Enable LLM labels (configure provider and API key)';
                    llmToggle.onclick = () => {
                        notifyButtonInteractionStart();
                        vscode.postMessage({ command: 'setupLLM', payload: {} });
                        notifyButtonInteractionEnd();
                    };
                    return;
                }
                isLLMEnabled = localStorage.getItem('codevisualizer-llm-enabled') === 'true';
                llmToggle.textContent = isLLMEnabled ? '✓ LLM' : 'LLM';
                llmToggle.title = isLLMEnabled ? 'Disable LLM labels' : 'Enable LLM labels';

                llmToggle.onclick = () => {
                    notifyButtonInteractionStart();
                    if (isLLMEnabled) {
                        vscode.postMessage({ command: 'disableLLMLabels', payload: {} });
                    } else {
                        // Optimistically show progress
                        llmToggle.setAttribute('disabled', 'true');
                        llmToggle.textContent = '…';
                        vscode.postMessage({ command: 'requestLLMLabels', payload: {} });
                        // Re-enable after a short delay; final state will be set upon successful applyMermaid
                        setTimeout(() => llmToggle.removeAttribute('disabled'), 2000);
                    }
                    notifyButtonInteractionEnd();
                };
            }
            setLLMButton(INITIAL_LLM);

            // Auto-apply LLM labels if previously enabled and available
            try {
                const persistedLLM = localStorage.getItem('codevisualizer-llm-enabled') === 'true';
                if (INITIAL_LLM && INITIAL_LLM.enabled && persistedLLM) {
                    isLLMEnabled = true;
                    // Defer the request slightly to allow initial render to complete
                    setTimeout(() => {
                        vscode.postMessage({ command: 'requestLLMLabels', payload: {} });
                    }, 200);
                }
            } catch (err) {
                console.warn('[CodeVisualizer] Unable to read LLM persisted state:', err);
            }
        </script>
    </body>
    </html>`;
}

  /**
   * Helper to generate CSS for controls to keep getWebviewContent cleaner.
   */
  private getStylesForControls(context: any): string {
      return `
        #panel-controls {
            position: fixed; top: 10px; left: 10px; right: 10px; z-index: 1000;
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 16px; background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border); border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        #export-controls {
            position: ${context.isPanel ? "relative" : "absolute"};
            ${context.isPanel ? "" : "top: 10px; right: 10px;"}
            z-index: 1000; display: flex; gap: 10px;
        }
        #toolbar-container.hidden {
            display: none;
        }
        body.toolbar-hidden .svg-pan-zoom-control {
          display: none !important;
        }
        #export-controls button, #open-panel-btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border, transparent);
            padding: 5px 10px; cursor: pointer; border-radius: 4px; font-size: 11px;
        }
        #function-select {
            max-width: 190px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            font-size: 11px;
            padding: 3px 6px;
        }
        #vars-panel {
            position: fixed;
            top: 60px;
            left: 10px;
            bottom: 10px;
            width: 200px;
            z-index: 999;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 8px;
            overflow: auto;
            font-size: 11px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
        }
        #vars-panel h4 {
            margin: 2px 0 4px;
            font-size: 11px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
        }
        #vars-panel .var-item {
            padding: 2px 4px;
            border-radius: 3px;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-family: 'JetBrains Mono', Consolas, monospace !important;
        }
        #vars-panel .var-item:hover {
            background: var(--hover-fill);
        }
        #vars-panel .var-empty {
            padding: 2px 4px;
            color: var(--vscode-descriptionForeground);
        }
        body.vars-open #container {
            padding-left: 214px;
            box-sizing: border-box;
        }
        #export-controls button:hover, #open-panel-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        /* LLM toggle */
        #llm-toggle {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border, transparent);
            padding: 6px 10px; cursor: pointer; border-radius: 4px; font-size: 11px;
        }
        #llm-toggle[disabled] { opacity: 0.6; cursor: default; }

        #toolbar-toggle {
            width: 26px;
            height: 26px;
            padding: 0;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        #toolbar-toggle:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        #toolbar-toggle-container {
            position: fixed;
            top: 10px;
            left: 10px;
            display: flex;
            align-items: center;
            gap: 8px;
            z-index: 1002;
        }

        /* 默认展开/折叠复选框（常驻顶部） */
        #fold-default-toggle {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            border-radius: 4px;
            background: var(--vscode-editorWidget-background, rgba(0, 0, 0, 0.35));
            color: var(--vscode-editor-foreground);
            font-size: 11px;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
        }
        #fold-default-toggle input {
            margin: 0;
            cursor: pointer;
        }

        /* Metrics panel */
        #metrics-container {
            position: fixed;
            ${context.isPanel ? "top: 80px;" : "top: 50px;"}
            right: 10px;
            z-index: 1001;
            display: flex;
            align-items: flex-start;
            gap: 8px;
        }

        #metrics-panel {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 6px;
            padding: 10px 12px;
            font-size: 12px;
            color: var(--vscode-editor-foreground);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            min-width: 200px;
            max-width: 280px;
        }

        #metrics-panel.hidden {
            display: none;
        }

        #metrics-panel-title {
            font-weight: 600;
            margin-bottom: 8px;
            font-size: 13px;
            color: var(--vscode-textLink-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 4px;
        }

        .metrics-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .metrics-item:last-child {
            border-bottom: none;
        }

        .metrics-label {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }

        .metrics-value {
            font-weight: 600;
            color: var(--vscode-editor-foreground);
            font-size: 12px;
        }

        #metrics-toggle {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border, transparent);
            padding: 6px 10px;
            cursor: pointer;
            border-radius: 4px;
            font-size: 11px;
            flex-shrink: 0;
        }

        #metrics-toggle:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

      `;
  }

  /**
   * Helper to generate HTML for controls.
   */
  /**
   * 左侧变量面板：上面全局变量，下面当前函数局部变量。
   */
  private getHtmlForVarsPanel(): string {
    return `
        <aside id="vars-panel">
            <h4>Globals</h4>
            <div id="globals-list"></div>
            <h4>Locals</h4>
            <div id="locals-list"></div>
        </aside>
    `;
  }

  private getHtmlForControls(context: any, codeMetrics?: CodeMetrics): string {
    // 默认展开/折叠开关（勾选 = 默认展开），常驻顶部
    const defaultExpanded = vscode.workspace
      .getConfiguration("codevisualizer")
      .get<boolean>("defaultExpandBranches", false);
    const toolbarToggleButton = `
        <label id="fold-default-toggle" title="勾选：分支默认展开；取消：分支默认折叠">
            <input type="checkbox" id="fold-default-checkbox"${defaultExpanded ? " checked" : ""} />
            默认展开
        </label>
        <button id="toolbar-toggle" title="Show toolbar" aria-label="Show toolbar">☰</button>
    `;

    // Metrics toggle button - goes in the toolbar
    const metricsToggleButton = codeMetrics ? `
                <button id="metrics-toggle" title="Toggle metrics display">📈</button>
    ` : '';
    
    // Metrics panel - stays in original position
    const metricsPanel = codeMetrics ? `
        <div id="metrics-container">
            <div id="metrics-panel">
                <div id="metrics-panel-title">Code Metrics</div>
                <div class="metrics-item">
                    <span class="metrics-label">Lines of Code:</span>
                    <span class="metrics-value">${codeMetrics.linesOfCode}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Nodes:</span>
                    <span class="metrics-value">${codeMetrics.numberOfNodes}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Edges/Branches:</span>
                    <span class="metrics-value">${codeMetrics.numberOfEdges}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Decision Points:</span>
                    <span class="metrics-value">${codeMetrics.decisionPoints}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Return Statements:</span>
                    <span class="metrics-value">${codeMetrics.returnStatements}</span>
                </div>
                <div class="metrics-item">
                    <span class="metrics-label">Parameters:</span>
                    <span class="metrics-value">${codeMetrics.functionParameters}</span>
                </div>
            </div>
        </div>
    ` : '';

    const panelControls = `
        <div id="toolbar-toggle-container">${toolbarToggleButton}</div>
        <div id="toolbar-container" class="hidden">
            <div id="panel-controls">
                <div>Flowchart Viewer</div>
                <div id="export-controls">
                    <select id="function-select" title="Select function"></select>
                    <button id="copy-mermaid" title="Copy Mermaid Code">Copy Code</button>
                    <button id="export-svg" title="Export as SVG">SVG</button>
                    <button id="export-png" title="Export as PNG">PNG</button>
                    ${metricsToggleButton}
                    <button id="llm-toggle" title="Toggle human-friendly labels"></button>
                </div>
            </div>
        </div>
        ${metricsPanel}
    `;

    const sidebarControls = `
        <div id="toolbar-toggle-container">${toolbarToggleButton}</div>
        <div id="toolbar-container" class="hidden">
            <div id="export-controls">
                ${context.showPanelButton ? '<button id="open-panel-btn">Open in New Window</button>' : ''}
                <button id="copy-mermaid" title="Copy Mermaid Code">Copy Code</button>
                <button id="export-svg">Export as SVG</button>
                <button id="export-png">Export as PNG</button>
                ${metricsToggleButton}
                <button id="llm-toggle" title="Toggle human-friendly labels"></button>
            </div>
        </div>
        ${metricsPanel}
    `;
    
    return context.isPanel ? panelControls : sidebarControls;
  }

  /**
   * Generates a simple HTML page to show a loading or informational message.
   */
  protected getLoadingHtml(message: string): string {
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body, html {
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100%;
                    width: 100%;
                    margin: 0;
                    padding: 0;
                }
            </style>
        </head>
        <body>
            <p>${message}</p>
        </body>
        </html>`;
  }

  /**
   * Generates a random nonce for Content Security Policy.
   */
  protected getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Cleans up disposables when the provider is disposed.
   */
  public dispose(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._currentDocument = undefined;
    this._currentPosition = undefined;
    this._isUpdating = false;
    this._locationMap = [];
    this._currentFunctionRange = undefined;
    this._eventListenersSetup = false;

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}