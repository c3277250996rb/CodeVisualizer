import { FlowchartIR, FlowchartNode, FlowchartEdge, NodeSegment, NodeType } from "../ir/ir";
import { StringProcessor } from "./utils/StringProcessor";
import { SubtleThemeManager, ThemeStyles } from "./utils/ThemeManager";

// Optimized string building
class StringBuilder {
  private parts: string[] = [];

  append(str: string): void {
    this.parts.push(str);
  }

  appendLine(str: string): void {
    this.parts.push(str, "\n");
  }

  toString(): string {
    return this.parts.join("");
  }

  clear(): void {
    this.parts.length = 0;
  }
}

export class EnhancedMermaidGenerator {
  /**
   * 合成节点：标签不是源码里的语句（Start / End / Loop End / break / continue），
   * 它们的 location 指向整段函数、循环头或语句本身，不能作为编辑目标，否则一次提交会把代码改坏。
   */
  private static readonly NON_EDITABLE_TYPES = new Set<NodeType>([
    NodeType.ENTRY,
    NodeType.EXIT,
    NodeType.LOOP_END,
    NodeType.BREAK_CONTINUE,
  ]);

  /** 边的布尔/分支标签：统一渲染成图形符号 */
  private static readonly EDGE_LABEL_GLYPHS: Record<string, string> = {
    true: "✔️",
    false: "✖",
    match: "✔️",
    "no match": "✖",
    continue: "🔄",
  };

  /**
   * 标签本身是合成文字（不是源码原文）的节点也不能编辑，
   * 例如 case 1: 覆盖整个 case 体、switch (x) 只包含条件、Python 的 match 只包含 subject。
   */
  private static isSyntheticLabel(label: string): boolean {
    const text = label.trim().toLowerCase();
    if (text === "default" || text === "break" || text === "continue") {
      return true;
    }
    if (text.startsWith("case ")) {
      return true;
    }
    if (text.startsWith("switch (") || text.startsWith("switch(")) {
      return true;
    }
    // match 后面没有 = 才是分支头，避免误伤名为 match 的赋值语句
    if (text.startsWith("match ") && text.indexOf("=") < 0) {
      return true;
    }
    return false;
  }

  private sb = new StringBuilder();
  private themeStyles: ThemeStyles;

  constructor(
    private themeKey: string = "monokai",
    private vsCodeTheme: "light" | "dark" = "dark"
  ) {
    this.themeStyles = SubtleThemeManager.getThemeStyles(themeKey, vsCodeTheme);
  }

  /**
   * Sanitizes an ID string to be Mermaid-compatible.
   * It replaces spaces with underscores and removes all non-alphanumeric characters.
   */
  private sanitizeId(id: string): string {
    return id
      .replace(/\s+/g, '_')
      .replace(/[^\w]/g, '') // Remove all non-alphanumeric characters
      .replace(/_+/g, '_');
  }

  /**
   * Generates a map of edge IDs to their source and target node IDs.
   * @param ir The flowchart intermediate representation.
   * @returns A map where the key is a generated edge ID and the value contains the source and target node IDs.
   */
  private generateEdgeMetadata(ir: FlowchartIR): Map<string, {source: string, target: string}> {
    const edgeMap = new Map<string, {source: string, target: string}>();
    const isHashedId = (id: string) => /^N[0-9A-Z]+$/.test(id);
    
    for (const edge of ir.edges) {
      // Use IDs as-is if already hashed, otherwise sanitize
      const sanitizedFrom = isHashedId(edge.from) ? edge.from : this.sanitizeId(edge.from);
      const sanitizedTo = isHashedId(edge.to) ? edge.to : this.sanitizeId(edge.to);
      const edgeId = `${sanitizedFrom}_${sanitizedTo}`;
      
      // Store both source and target
      edgeMap.set(edgeId, {
        source: sanitizedFrom,
        target: sanitizedTo
      });
    }
    
    return edgeMap;
  }

  public generate(ir: FlowchartIR): string {
    this.sb.clear();
    this.sb.appendLine("graph TD");
    
    // Add this line to avoid default node styling conflicts
    this.sb.appendLine("    classDef default fill:none,stroke:none");

    if (ir.title) {
      this.sb.appendLine(`%% ${ir.title}`);
    }

    // Apply sanitization to all IDs first to ensure consistency
    // BUT: If IDs are already hashed (like from CodebaseGraphBuilder), don't re-sanitize
    // Check if IDs look like hashed IDs (start with 'N' followed by base36 chars)
    const isHashedId = (id: string) => /^N[0-9A-Z]+$/.test(id);
    
    for (const node of ir.nodes) {
        // Only sanitize if not already hashed
        if (!isHashedId(node.id)) {
            node.id = this.sanitizeId(node.id);
        }
    }
    for (const edge of ir.edges) {
        if (!isHashedId(edge.from)) {
            edge.from = this.sanitizeId(edge.from);
        }
        if (!isHashedId(edge.to)) {
            edge.to = this.sanitizeId(edge.to);
        }
    }

    // Generate nodes efficiently
    for (const node of ir.nodes) {
      const shape = this.getShape(node);
      const segments = node.segments ?? [];
      const isMergedBlock = segments.length > 1;
      // 只有“标签就是源码原文”的语句节点才允许回写编辑
      const editable =
        node.location &&
        !EnhancedMermaidGenerator.NON_EDITABLE_TYPES.has(node.nodeType as NodeType) &&
        !EnhancedMermaidGenerator.isSyntheticLabel(node.label);
      const editAttrs = editable
        ? ` data-editable="1" data-start="${node.location!.start}" data-end="${node.location!.end}"`
        : "";
      const codeBlock = isMergedBlock
        ? this.renderSegmentStack(segments)
        : `<div class="code-label"${editAttrs} style="display:table;margin:0 auto;padding:2px 4px;text-align:left;white-space:nowrap">${this.escapeString(node.label)}</div>`;
      const label = node.comment
        ? `<div class="code-comment" style="display:table;max-width:100%;margin:0 auto;padding:2px 4px 5px;text-align:left">${this.renderCommentLines(node.commentRaw, node.comment)}</div>${codeBlock}`
        : codeBlock;

      this.sb.append("    ");
      this.sb.append(node.id);
      this.sb.append(shape[0]);
      this.sb.append('"');
      this.sb.append(label);
      this.sb.append('"');
      this.sb.append(shape[1]);
      this.sb.appendLine("");
    }

    // Generate edges efficiently
    // “循环继续”边的目标就是循环头；既收又发 continue 边的节点就是循环枢轴（如 for 的自增节点）
    const loopHeaderIds = new Set<string>();
    const continueSources = new Set<string>();
    for (const edge of ir.edges) {
      this.sb.append("    ");
      this.sb.append(edge.from);

      if (edge.label) {
        const normalizedLabel = edge.label.trim().toLowerCase();
        if (normalizedLabel === "continue") {
          loopHeaderIds.add(edge.to);
          continueSources.add(edge.from);
        }
        // if 的 true/false 与 switch 的 match/no match 统一成勾和叉
        const displayLabel =
          EnhancedMermaidGenerator.EDGE_LABEL_GLYPHS[normalizedLabel] ?? edge.label;
        const label = this.escapeString(displayLabel);
        this.sb.append(' -- "');
        this.sb.append(label);
        this.sb.append('" --> ');
      } else {
        this.sb.append(" --> ");
      }

      this.sb.append(edge.to);
      this.sb.appendLine("");
    }
    
    // Generate edge metadata as comments for JavaScript to parse
    this.sb.appendLine("");
    this.sb.appendLine("    %% Edge metadata for interaction");
    const edgeMetadata = this.generateEdgeMetadata(ir);
    for (const [edgeId, metadata] of edgeMetadata) {
      this.sb.appendLine(`    %% EDGE_META:${metadata.source}:${metadata.target}`);
    }

    // Generate enhanced styling class definitions
    this.generateClassDefinitions();

    // 循环头 / 循环枢轴标记：不挂样式，只作为前端定位循环的钩子。
    // 注意 mermaid 的 class 语句每行只能带一个类名（多类名会报 Syntax error），
    // 但同节点的多条 class 语句会累加，所以拆成两轮输出。
    for (const headerId of loopHeaderIds) {
      this.sb.append("    class ");
      this.sb.append(headerId);
      this.sb.append(" node-loop-header");
      this.sb.appendLine("");
    }
    for (const sourceId of continueSources) {
      if (!loopHeaderIds.has(sourceId)) {
        continue;
      }
      this.sb.append("    class ");
      this.sb.append(sourceId);
      this.sb.append(" node-loop-pivot");
      this.sb.appendLine("");
    }

    // Apply classes to nodes based on their semantic types
    for (const node of ir.nodes) {
      if (node.nodeType) {
        const className = SubtleThemeManager.getNodeClassName(node.nodeType);
        this.sb.append("    class ");
        this.sb.append(node.id);
        this.sb.append(" ");
        this.sb.append(className);
        this.sb.appendLine("");
      } else if (node.style) {
        // Fallback for nodes with old-style inline styling
        this.sb.append("    ");
        this.sb.append(node.id);
        this.sb.append(":::fallback_");
        this.sb.append(node.id);
        this.sb.appendLine("");

        // Generate inline class definition for this specific node
        this.sb.append("    classDef fallback_");
        this.sb.append(node.id);
        this.sb.append(" ");
        this.sb.append(node.style);
        this.sb.appendLine("");
      }
    }

    // Generate click handlers efficiently
    for (const entry of ir.locationMap) {
      // Use the already sanitized node ID
      const sanitizedNodeId = this.sanitizeId(entry.nodeId);
      this.sb.append("    click ");
      this.sb.append(sanitizedNodeId);
      this.sb.append(" call onNodeClick(");
      this.sb.append(entry.start.toString());
      this.sb.append(", ");
      this.sb.append(entry.end.toString());
      this.sb.appendLine(")");
    }

    return this.sb.toString();
  }

  /**
   * 把合并块内每条语句渲染成一行，行间只用细分隔线，块本身沿用节点外框。
   */
  private renderSegmentStack(segments: NodeSegment[]): string {
    const cells = segments.map((segment, index) => {
      const styles = [
        "margin:0",
        "padding:2px 4px",
        index === 0 ? "border-top:none" : "border-top:1px solid rgba(128,128,128,0.45)",
        "text-align:left",
        "white-space:nowrap",
        "cursor:pointer",
      ];
      const commentLines = (segment.commentRaw ?? segment.comment ?? "")
        .split(/\r?\n/)
        .map((line) => this.escapeString(line))
        .filter((line) => line.length > 0);
      const comment = commentLines.length > 0
        ? `<div class="code-cell-comment" style="padding-bottom:1px;margin-bottom:1px;border-bottom:1px dashed rgba(128,128,128,0.45);font-size:0.85em;font-style:italic;color:var(--vscode-descriptionForeground,#9aa0a6)">${commentLines.map((line) => `<div>${line}</div>`).join("")}</div>`
        : "";
      const code = `<div class="code-cell-code">${this.escapeString(segment.code)}</div>`;
      return `<div class="code-cell" data-editable="1" data-start="${segment.start}" data-end="${segment.end}" style="${styles.join(";")}">${comment}${code}</div>`;
    });
    return `<div class="code-stack" style="display:flex;flex-direction:column;align-items:stretch;margin:0;padding:0">${cells.join("")}</div>`;
  }

  /**
   * 按行渲染注释：优先使用原始文本，保留行注释或块注释的标记。
   */
  private renderCommentLines(raw: string | undefined, fallback: string): string {
    const text = raw ?? fallback;
    const lines = text
      .split(/\r?\n/)
      .map((line) => this.escapeString(line))
      .filter((line) => line.length > 0);
    return lines.map((line) => `<div>${line}</div>`).join("");
  }

  private generateClassDefinitions(): void {
    this.sb.appendLine("");
    this.sb.appendLine("    %% Enhanced node styling classes");

    // Generate class definitions for each node type
    const nodeTypes = Object.values(NodeType);

    for (const nodeType of nodeTypes) {
      const className = SubtleThemeManager.getNodeClassName(nodeType);
      const cssStyle = this.generateCSSStyle(nodeType);

      this.sb.append("    classDef ");
      this.sb.append(className);
      this.sb.append(" ");
      this.sb.append(cssStyle);
      this.sb.appendLine("");
    }
    this.sb.appendLine("");
  }

  private generateCSSStyle(nodeType: NodeType): string {
    const nodeStyle = SubtleThemeManager.getNodeStyle(nodeType);
    const themeColor = this.getThemeColorForNodeType(nodeType);

    let cssStyle = `fill:${themeColor.fill},stroke:${themeColor.stroke}`;

    // Add stroke width based on emphasis
    const strokeWidth = this.getStrokeWidthForEmphasis(nodeStyle.emphasis);
    cssStyle += `,stroke-width:${strokeWidth}px`;

    // Add dash array for border style
    const dashArray = SubtleThemeManager.getDashArrayForBorderStyle(
      nodeStyle.borderStyle
    );
    if (dashArray) {
      cssStyle += `,stroke-dasharray:${dashArray}`;
    }

    // Add text color if specified
    if (themeColor.textColor) {
      cssStyle += `,color:${themeColor.textColor}`;
    }

    return cssStyle;
  }

  private getThemeColorForNodeType(nodeType: NodeType) {
    switch (nodeType) {
      case NodeType.ENTRY:
        return this.themeStyles.entry;
      case NodeType.EXIT:
        return this.themeStyles.exit;
      case NodeType.DECISION:
      case NodeType.LOOP_START:
        return this.themeStyles.decision;
      case NodeType.LOOP_END:
        return this.themeStyles.loop;
      case NodeType.EXCEPTION:
        return this.themeStyles.exception;
      case NodeType.ASSIGNMENT:
        return this.themeStyles.assignment;
      case NodeType.FUNCTION_CALL:
        return this.themeStyles.functionCall;
      case NodeType.ASYNC_OPERATION:
        return this.themeStyles.asyncOperation;
      case NodeType.BREAK_CONTINUE:
        return this.themeStyles.breakContinue;
      case NodeType.RETURN:
        return this.themeStyles.returnNode;
      case NodeType.PROCESS:
      default:
        return this.themeStyles.process;
    }
  }

  private getStrokeWidthForEmphasis(emphasis: string): number {
    switch (emphasis) {
      case "high":
        return 2;
      case "medium":
        return 1.5;
      case "low":
      default:
        return 1;
    }
  }

  private getShape(node: FlowchartNode): [string, string] {
    if (node.nodeType) {
      if (node.nodeType === NodeType.DECISION) {
        return ["[", "]"];
      }
      const nodeStyle = SubtleThemeManager.getNodeStyle(node.nodeType);
      return this.getShapeMarkers(nodeStyle.shape);
    }

    // Fallback to original shape logic
    switch (node.shape) {
      case "diamond":
        return ["{", "}"];
      case "round":
        return ["((", "))"];
      case "stadium":
        return ["([", "])"];
      case "rect":
      default:
        return ["[", "]"];
    }
  }

  private getShapeMarkers(shape: string): [string, string] {
    switch (shape) {
      case "diamond":
        return ["{", "}"];
      case "round":
        return ["((", "))"];
      case "stadium":
        return ["([", "])"];
      case "rect":
      default:
        return ["[", "]"];
    }
  }

  private escapeString(str: string): string {
    return StringProcessor.escapeString(str);
  }

}
