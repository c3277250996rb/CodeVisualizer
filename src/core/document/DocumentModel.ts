import { FlowchartIR } from "../../ir/ir";
import { CodeMetrics } from "../utils/MetricsAnalyzer";
import { SymbolSummary } from "./SymbolCatalog";

/**
 * 单个文档的分析快照：解析结果、指标与结构签名。
 * 只缓存“分析结果”，mermaid 文本按主题在渲染时生成。
 */
export interface DocumentSnapshot {
  uri: string;
  version: number;
  languageId: string;
  /** 当前分析的目标函数名，跟随光标时为空。 */
  functionName?: string;
  ir: FlowchartIR;
  metrics: CodeMetrics;
  headerComment?: string;
  /** 函数列表与变量汇总（左栏、函数下拉、目录树共用）。 */
  symbols: SymbolSummary;
  /** 节点/边集合签名，用于判断重新渲染是否会改变布局结构。 */
  structureKey: string;
}

/**
 * 生成结构签名：只关心节点 id 与边，不关心标签文本。
 */
export function buildStructureKey(ir: FlowchartIR): string {
  const nodes = ir.nodes
    .map((node) => node.id)
    .sort()
    .join(",");
  const edges = ir.edges
    .map((edge) => `${edge.from}>${edge.to}`)
    .sort()
    .join(",");
  return `${nodes}|${edges}`;
}

/**
 * 按文档缓存最新一次分析结果，避免同一版本重复解析。
 */
export class DocumentModel {
  private readonly snapshots = new Map<string, DocumentSnapshot>();

  /**
   * 取快照；版本、目标函数或光标所在函数不匹配时返回 undefined。
   * 跟随光标模式下必须传 position：同一版本文档里光标换到另一个函数也要重算，
   * 否则画布会一直停在第一次渲染的那个函数上。
   */
  public get(
    uri: string,
    version: number,
    functionName: string | undefined,
    position?: number
  ): DocumentSnapshot | undefined {
    const snapshot = this.snapshots.get(uri);
    if (!snapshot) {
      return undefined;
    }
    if (snapshot.version !== version) {
      return undefined;
    }
    const sameFunction = (snapshot.functionName ?? "") === (functionName ?? "");
    if (!sameFunction) {
      return undefined;
    }
    // 固定函数模式：目标函数由 functionName 决定，与光标无关
    if (functionName) {
      return snapshot;
    }
    // 跟随光标模式：缓存里的函数范围必须覆盖当前光标
    const range = snapshot.ir.functionRange;
    if (!range || position === undefined) {
      return undefined;
    }
    return position >= range.start && position <= range.end ? snapshot : undefined;
  }

  public store(snapshot: DocumentSnapshot): void {
    this.snapshots.set(snapshot.uri, snapshot);
  }

  /**
   * 失效缓存；不传 uri 时清空全部。
   */
  public invalidate(uri?: string): void {
    if (uri) {
      this.snapshots.delete(uri);
      return;
    }
    this.snapshots.clear();
  }

  public get size(): number {
    return this.snapshots.size;
  }
}
