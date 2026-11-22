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
  | RevealVariableMessage;

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
        if (event.textEditor === vscode.window.activeTextEditor) {
          const selection = event.selections[0];
          // If the cursor is still within the same function, just highlight the node
          if (
            this._currentFunctionRange &&
            this._currentFunctionRange.contains(selection)
          ) {
            const offset = event.textEditor.document.offsetAt(selection.active);
            const entry = this._locationMap.find(
              (e) => offset >= e.start && offset <= e.end
            );
            this.highlightNode(entry ? entry.nodeId : null);
          } else {
            // If the cursor moves out of the function, regenerate the flowchart
            await this.updateView(event.textEditor);
          }
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
      headerComment: ir.headerCommentRaw ?? ir.headerComment,
      symbols: collectSymbols(document.getText(), document.languageId, this._pinnedFunction),
      structureKey: buildStructureKey(ir),
    };
    this._documentModel.store(snapshot);
    return snapshot;
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
    if (this._userInteracting) {
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
    const shouldUpdate = this._shouldUpdate(document, position);
    if (!shouldUpdate) {
      // Just update highlighting if we're still in the same function
      if (
        this._currentFunctionRange &&
        this._currentFunctionRange.contains(editor.selection.active)
      ) {
        const entry = this._locationMap.find(
          (e) => position >= e.start && position <= e.end
        );
        this.highlightNode(entry ? entry.nodeId : null);
      }
      return;
    }

    this._isUpdating = true;
    if (!this._htmlRendered) {
      this.setWebviewHtml(this.getLoadingHtml("Generating flowchart..."));
    }

    try {
      const snapshot = await this.getSnapshot(document, position);

      this._locationMap = snapshot.ir.locationMap;
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

      const mermaidCode = this.generateMermaid(snapshot.ir);
      this._mermaidCodeOriginal = mermaidCode;
      this._mermaidCodeLLM = undefined;

      const ctx = getExtensionContext();
      const availability = ctx
        ? await LLMManager.getAvailability(ctx)
        : { enabled: false, provider: "openai", model: "" };

      const structureChanged = this._lastStructureKey !== snapshot.structureKey;
      const documentChanged = this._lastDocumentUri !== document.uri.toString();
      if (!this._htmlRendered || !this._webviewReady) {
        // 首次渲染（或 webview 重建）：整页加载一次
        this.setWebviewHtml(
          this.getWebviewContent(
            mermaidCode,
            this.getNonce(),
            availability,
            snapshot.metrics,
            snapshot.headerComment
          )
        );
        this._htmlRendered = true;
      } else {
        // 后续更新：不重建页面，只推送新的图与附带信息，并保留缩放/位置
        webview.postMessage({
          command: "applyGraph",
          payload: {
            mermaid: mermaidCode,
            preserveView: !documentChanged,
            structureChanged: structureChanged || documentChanged,
            metrics: snapshot.metrics,
            headerComment: snapshot.headerComment ?? "",
          },
        });
        webview.postMessage({ command: "llmAvailability", payload: availability });
      }
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

      // 挂起的聚焦请求（如图还没画出来时按下的“放大到循环”）在渲染后补发
      this.flushPendingFocus();

      // After updating the view, immediately highlight the node for the current cursor
      const offset = editor.document.offsetAt(editor.selection.active);
      const entry = this._locationMap.find(
        (e) => offset >= e.start && offset <= e.end
      );
      this.highlightNode(entry ? entry.nodeId : null);

    } catch (error) {
      console.error("Flowchart generation failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : "An unknown error occurred";
      this.setWebviewHtml(this.getLoadingHtml(`Error: ${errorMessage}`));
      this._htmlRendered = false;
      this._webviewReady = false;
      this._lastStructureKey = undefined;
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
    codeMetrics?: CodeMetrics,
    headerComment?: string
  ): string {
    const theme =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
        ? "dark"
        : "default";

    const context = this.getViewContext();

    const llm = llmAvailability || { enabled: false, provider: "openai", model: "" };
    const escapedHeaderComment = headerComment
      ? headerComment.replace(/[&<>"']/g, (character) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character]!)
      : "";
    // 容器常驻，后续通过消息更新内容与显隐
    const headerCommentPanel = `<div id="function-comment" tabindex="0"${escapedHeaderComment ? "" : ' style="display:none"'}>${escapedHeaderComment}</div>`;
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
              #function-comment {
                position: fixed;
                z-index: 5;
                top: 32px;
                left: 42px;
                right: 10px;
                max-height: 120px;
                overflow: auto;
                box-sizing: border-box;
                padding: 8px 10px;
                border: 1px solid var(--vscode-panel-border);
                background: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
                font-size: 12px;
                line-height: 1.45;
                opacity: 0.78;
                transition: opacity 0.18s ease;
                white-space: pre-wrap;
              }
              #function-comment:hover,
              #function-comment:focus {
                opacity: 1;
              }
            .mermaid { width: 100%; height: 100%; }
            .mermaid svg { width: 100%; height: 100%; }
            .mermaid .code-label {
              font-family: 'JetBrains Mono', Consolas, monospace !important;
            }
            .mermaid .code-comment {
              font-family: 'JetBrains Mono', Consolas, monospace !important;
              font-size: 0.85em !important;
            }
            /* 合并块内的行：只做行级反馈，整块轮廓交给节点外框 */
            .mermaid .code-cell {
              font-family: 'JetBrains Mono', Consolas, monospace !important;
            }
            .mermaid .code-cell:hover {
              background: rgba(255, 165, 0, 0.10) !important;
              box-shadow: inset 2px 0 0 var(--hover-stroke);
            }
            .mermaid .code-cell:hover .code-cell-code,
            .mermaid .code-cell:hover .code-cell-comment {
              filter: drop-shadow(0 0 6px var(--hover-stroke));
            }
            .mermaid .code-cell-comment {
              font-style: italic;
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


            
            /* Hovered node, child, or edge */
            .mermaid svg .node.hover-highlight > *,
            .mermaid svg .node.child-highlight > * {
                fill: var(--hover-fill) !important;
                stroke: var(--hover-stroke) !important;
                stroke-width: var(--hover-stroke-width) !important;
                filter: drop-shadow(0 0 8px var(--hover-stroke));
            }

            /* 合并块：外框保留背景光晕（A），文字层不加光晕，文字光晕只给悬停行（C） */
            .mermaid svg .node.hover-highlight:has(.code-stack) > g.label,
            .mermaid svg .node.child-highlight:has(.code-stack) > g.label {
                filter: none !important;
            }
            
            /* Enhanced edge highlighting that works with different Mermaid edge structures */
            .mermaid g[class*="edge"].hover-highlight > *,
            .mermaid g[id^="L_"].hover-highlight > *,
            .mermaid path[class*="edge"].hover-highlight,
            .mermaid g.hover-highlight > path,
            .mermaid g.edgePath.hover-highlight > path.path {
                stroke: var(--hover-edge-color) !important;
                stroke-width: var(--hover-edge-width) !important;
                filter: drop-shadow(0 0 2px var(--hover-edge-color));
            }

            /* Arrow markers for highlighted edges */
            .mermaid g[class*="edge"].hover-highlight polygon,
            .mermaid g[id^="L_"].hover-highlight polygon,
            .mermaid g.hover-highlight polygon,
            .mermaid g.edgePath.hover-highlight polygon {
                fill: var(--hover-edge-color) !important;
                stroke: var(--hover-edge-color) !important;
            }

            /* Edge labels */
            .mermaid g[class*="edge"].hover-highlight text,
            .mermaid g[id^="L_"].hover-highlight text,
            .mermaid g.hover-highlight text {
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
      ${headerCommentPanel}
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
            // 重渲染后复用的 pan/zoom 实例
            let panZoomInstance = null;
            // 由面板命令触发的节点聚焦处理（setupInteractions 里赋值）
            let focusNodeKindHandler = null;

            function applyHeaderComment(text) {
                const el = document.getElementById('function-comment');
                if (!el) {
                    return;
                }
                el.textContent = text || '';
                el.style.display = text ? '' : 'none';
            }

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

            // 统一的图渲染入口：先记录视口，重渲染后恢复
            function renderGraphSource(newSource, options) {
                const mermaidDiv = document.querySelector('.mermaid');
                const sourceDiv = document.getElementById('mermaid-source');
                if (!mermaidDiv || !sourceDiv) {
                    return;
                }
                const opts = options || {};
                const state = opts.preserveView ? captureViewState() : null;

                const idx = newSource.toLowerCase().indexOf('graph ');
                const finalSrc = idx >= 0 ? newSource.slice(idx) : newSource;

                const existingSvg = mermaidDiv.querySelector('svg');
                if (existingSvg) {
                    existingSvg.remove();
                }
                mermaidDiv.removeAttribute('data-processed');
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
                                if (highlightedNodeId) {
                                    const hl = document.getElementById(highlightedNodeId);
                                    if (hl) {
                                        hl.classList.add('highlighted');
                                    }
                                }
                                restoreViewState(state);
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

            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'highlightNode':
                        if (highlightedNodeId) {
                            const oldElem = document.getElementById(highlightedNodeId);
                            if (oldElem) oldElem.classList.remove('highlighted');
                        }

                        const newId = message.payload.nodeId;
                        if (newId) {
                            const newElem = document.getElementById(newId);
                            if (newElem) newElem.classList.add('highlighted');
                        }
                        highlightedNodeId = newId;
                        break;

                    case 'focusNodeKind':
                        if (typeof focusNodeKindHandler === 'function') {
                            focusNodeKindHandler(message.payload && message.payload.kind);
                        }
                        break;

                    case 'nodeZoomFontScale':
                        if (typeof message.payload.scale === 'number' && isFinite(message.payload.scale)) {
                            nodeZoomFontScale = Math.max(0.8, Math.min(0.8, message.payload.scale));
                        }
                        break;

                    case 'applyGraph':
                    case 'applyMermaid': {
                        renderGraphSource(message.payload.mermaid, {
                            preserveView: message.payload.preserveView !== false,
                            llmApplied: typeof message.payload.llmApplied === 'boolean' ? message.payload.llmApplied : undefined,
                        });
                        if (message.payload.metrics) {
                            applyMetricsToPanel(message.payload.metrics);
                        }
                        if (typeof message.payload.headerComment === 'string') {
                            applyHeaderComment(message.payload.headerComment);
                        }
                        break;
                    }
                    case 'applyHeaderComment': {
                        applyHeaderComment(message.payload.text || '');
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

                svgElement.querySelectorAll('.node').forEach((node) => {
                  node.querySelectorAll('.comment-divider').forEach((divider) => divider.remove());

                  const comment = node.querySelector('.code-comment');
                  const code = node.querySelector('.code-label');
                  const matrix = node.getScreenCTM();
                  if (!comment || !code || !matrix) return;

                  const commentRect = comment.getBoundingClientRect();
                  const codeRect = code.getBoundingClientRect();
                  const toNodePoint = (x, y) => {
                    const point = svgElement.createSVGPoint();
                    point.x = x;
                    point.y = y;
                    return point.matrixTransform(matrix.inverse());
                  };
                  const left = toNodePoint(commentRect.left, (commentRect.bottom + codeRect.top) / 2);
                  const right = toNodePoint(commentRect.right, (commentRect.bottom + codeRect.top) / 2);
                  const divider = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                  divider.classList.add('comment-divider');
                  divider.setAttribute('x1', left.x);
                  divider.setAttribute('y1', left.y);
                  divider.setAttribute('x2', right.x);
                  divider.setAttribute('y2', right.y);
                  divider.setAttribute('stroke', '#8a8a8a');
                  divider.setAttribute('stroke-width', '1');
                  divider.setAttribute('stroke-dasharray', '4 3');
                    divider.style.setProperty('stroke', '#8a8a8a', 'important');
                  divider.setAttribute('pointer-events', 'none');
                  node.appendChild(divider);
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

                  svgElement.addEventListener('contextmenu', (event) => {
                    event.preventDefault();
                    const target = event.target instanceof Element ? event.target.closest('.node') : null;

                    notifyInteractionStart();
                    if (!target) {
                      panZoomInstance.fit();
                      panZoomInstance.center();
                      notifyInteractionEnd();
                      return;
                    }

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
                    // 直接走已有的右键聚焦分支，避免重复实现一套缩放算法
                    try {
                        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));
                    } catch (error) {
                        console.warn('[CodeVisualizer] focus node failed:', error);
                    }
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

                const allNodes = svgElement.querySelectorAll('.node');
                allNodes.forEach((node) => {
                    const fullNodeId = node.id;
                    if (!fullNodeId) return;

                    node.addEventListener('mouseenter', (event) => {
                        event.stopPropagation();
                        node.classList.add('hover-highlight');

                        const baseId = extractBaseId(fullNodeId);
                        
                        const outgoingEdges = findOutgoingEdges(fullNodeId, edgeMetadata);
                        outgoingEdges.forEach(edge => {
                            edge.classList.add('hover-highlight');
                        });

                        const connectedNodes = findConnectedNodes(baseId, edgeMetadata);
                        connectedNodes.forEach(connectedNode => {
                            connectedNode.classList.add('child-highlight');
                        });
                    });

                    node.addEventListener('mouseleave', () => {
                        document.querySelectorAll('.hover-highlight, .child-highlight').forEach(el => {
                            el.classList.remove('hover-highlight', 'child-highlight');
                        });
                    });
                });

                // 合并块内的每个小节单独可点，点击定位到该语句本身
                svgElement.querySelectorAll('.code-cell[data-start]').forEach((cell) => {
                    const start = Number(cell.getAttribute('data-start'));
                    const end = Number(cell.getAttribute('data-end'));
                    if (!isFinite(start) || !isFinite(end)) {
                        return;
                    }
                    cell.addEventListener('click', (event) => {
                        // 阻止事件冒泡到整个节点，避免选中整块范围
                        event.stopPropagation();
                        onNodeClick(start, end);
                    });
                    cell.addEventListener('dblclick', (event) => {
                        event.stopPropagation();
                        startCodeEdit(cell.querySelector('.code-cell-code'), start, end);
                    });
                });

                // 单条语句节点：双击同样进入行内编辑
                svgElement.querySelectorAll('.code-label[data-start]').forEach((label) => {
                    const start = Number(label.getAttribute('data-start'));
                    const end = Number(label.getAttribute('data-end'));
                    if (!isFinite(start) || !isFinite(end)) {
                        return;
                    }
                    label.addEventListener('dblclick', (event) => {
                        event.stopPropagation();
                        startCodeEdit(label, start, end);
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
                ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'auxclick', 'wheel', 'touchstart', 'touchmove'].forEach((type) => {
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
          z-index: 1002;
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
    const toolbarToggleButton = `
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