import * as vscode from "vscode";
import { analyzeCode } from "../core/analyzer";
import { listCFunctions } from "../core/language-services/c";
import { NodeType } from "../ir/ir";

export type OutlineKind = "file" | "function" | "decision";

/**
 * 目录树节点：文件 → 函数 → 判断语句。
 */
export class OutlineItem extends vscode.TreeItem {
  constructor(
    public readonly kind: OutlineKind,
    label: string,
    public readonly uri: vscode.Uri,
    public readonly range?: vscode.Range
  ) {
    super(
      label,
      kind === "decision"
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    if (kind === "file") {
      this.iconPath = new vscode.ThemeIcon("file-code");
      this.resourceUri = uri;
      this.contextValue = "outlineFile";
    } else if (kind === "function") {
      this.iconPath = new vscode.ThemeIcon("symbol-function");
      this.contextValue = "outlineFunction";
    } else {
      this.iconPath = new vscode.ThemeIcon("git-branch");
      this.contextValue = "outlineDecision";
      if (range) {
        this.command = {
          command: "codevisualizer.revealOutlineNode",
          title: "Reveal",
          arguments: [uri, range],
        };
      }
    }
  }
}

/**
 * 项目级目录树：懒解析，展开时才分析对应文件/函数。
 */
export class OutlineProvider implements vscode.TreeDataProvider<OutlineItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<OutlineItem | undefined>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public getTreeItem(element: OutlineItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: OutlineItem): Promise<OutlineItem[]> {
    if (!element) {
      return this.getFileItems();
    }
    if (element.kind === "file") {
      return this.getFunctionItems(element.uri);
    }
    if (element.kind === "function") {
      return this.getDecisionItems(element.uri, String(element.label));
    }
    return [];
  }

  private async getFileItems(): Promise<OutlineItem[]> {
    const files = await vscode.workspace.findFiles(
      "**/*.{c,h,cpp,hpp,cc,py,ts,tsx,js,jsx,java,go,rs,php}",
      "**/{node_modules,out,dist,.git,vendor,target}/**",
      300
    );
    return files
      .map((uri) => ({
        uri,
        relative: vscode.workspace.asRelativePath(uri, false),
      }))
      .sort((left, right) => left.relative.localeCompare(right.relative))
      .map((entry) => new OutlineItem("file", entry.relative, entry.uri));
  }

  private async getFunctionItems(uri: vscode.Uri): Promise<OutlineItem[]> {
    let text: string;
    let languageId: string;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      text = document.getText();
      languageId = document.languageId;
    } catch {
      return [];
    }

    const names = this.listFunctions(text, languageId);
    return names.map((name) => {
      const offset = text.indexOf(name);
      const range =
        offset >= 0
          ? new vscode.Range(
              this.positionAt(text, offset),
              this.positionAt(text, offset + name.length)
            )
          : undefined;
      const item = new OutlineItem("function", name, uri, range);
      if (range) {
        item.command = {
          command: "codevisualizer.revealOutlineNode",
          title: "Reveal",
          arguments: [uri, range],
        };
      }
      return item;
    });
  }

  private async getDecisionItems(
    uri: vscode.Uri,
    functionName: string
  ): Promise<OutlineItem[]> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const ir = await analyzeCode(
        document.getText(),
        document.languageId,
        functionName,
        0
      );

      return ir.nodes
        .filter((node) => node.nodeType === NodeType.DECISION && node.location)
        .map((node) => {
          const range = new vscode.Range(
            document.positionAt(node.location!.start),
            document.positionAt(node.location!.end)
          );
          return new OutlineItem("decision", node.label, uri, range);
        });
    } catch {
      return [];
    }
  }

  private listFunctions(text: string, languageId: string): string[] {
    if (languageId === "c") {
      try {
        return listCFunctions(text);
      } catch {
        return [];
      }
    }

    // 其他语言先用轻量正则兜底，后续可接入各自解析器
    const names: string[] = [];
    const pattern = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      names.push(match[1]);
    }
    return names;
  }

  private positionAt(text: string, offset: number): vscode.Position {
    const before = text.slice(0, offset);
    const line = before.split(/\r?\n/).length - 1;
    const lastBreak = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
    return new vscode.Position(line, offset - lastBreak - 1);
  }
}
