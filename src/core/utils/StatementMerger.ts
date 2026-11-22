import {
  FlowchartEdge,
  FlowchartIR,
  FlowchartNode,
  NodeSegment,
  NodeType,
} from "../../ir/ir";

/**
 * 常规语句（赋值、普通处理、函数/方法/宏调用）在流程图中逐个成节点会让图过长，
 * 这里把同一条直线上的连续常规语句合并成一个节点；显示时按“无箭头的相邻小节”排布。
 */
export class StatementMerger {
  /** 单个合并节点最多容纳的语句行数，避免合并出超长的大块节点。 */
  public static maxStatementsPerBlock = 40;

  private static readonly MERGEABLE_TYPES = new Set<NodeType>([
    NodeType.ASSIGNMENT,
    NodeType.PROCESS,
    NodeType.FUNCTION_CALL,
    NodeType.METHOD_CALL,
    NodeType.MACRO_CALL,
  ]);

  /**
   * 合并连续常规语句，返回新的 IR（不修改入参对象）。
   */
  public static mergeOrdinaryStatements(ir: FlowchartIR): FlowchartIR {
    if (ir.nodes.length < 2 || ir.edges.length === 0) {
      return ir;
    }

    const nodes = ir.nodes.slice();
    const edges = ir.edges.slice();
    const locationMap = ir.locationMap.slice();
    let changed = true;

    while (changed) {
      changed = false;
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const outgoing = StatementMerger.buildEdgeMap(edges, "from");
      const incoming = StatementMerger.buildEdgeMap(edges, "to");

      for (const edge of edges) {
        if (edge.from === edge.to) {
          continue;
        }

        const from = nodesById.get(edge.from);
        const to = nodesById.get(edge.to);
        if (!from || !to || !StatementMerger.canMerge(from, to)) {
          continue;
        }

        // 只在直线路径上合并：两侧都不能有分支
        const isSingleOutgoing = (outgoing.get(from.id)?.length ?? 0) === 1;
        const isSingleIncoming = (incoming.get(to.id)?.length ?? 0) === 1;
        if (isSingleOutgoing && isSingleIncoming) {
          StatementMerger.applyMerge(from, to, nodes, edges, locationMap, edge);
          changed = true;
          break;
        }
      }
    }

    return {
      ...ir,
      nodes,
      edges,
      locationMap,
    };
  }

  private static canMerge(from: FlowchartNode, to: FlowchartNode): boolean {
    if (!StatementMerger.MERGEABLE_TYPES.has(from.nodeType as NodeType) ||
      !StatementMerger.MERGEABLE_TYPES.has(to.nodeType as NodeType)) {
      return false;
    }

    return StatementMerger.countStatements(from) + StatementMerger.countStatements(to) <=
      StatementMerger.maxStatementsPerBlock;
  }

  /** 统计节点中的语句条数（合并块按小节数计）。 */
  private static countStatements(node: FlowchartNode): number {
    return node.segments?.length ?? 1;
  }

  private static buildEdgeMap(
    edges: FlowchartEdge[],
    key: "from" | "to"
  ): Map<string, FlowchartEdge[]> {
    const map = new Map<string, FlowchartEdge[]>();
    for (const edge of edges) {
      const nodeId = edge[key];
      const list = map.get(nodeId);
      if (list) {
        list.push(edge);
      } else {
        map.set(nodeId, [edge]);
      }
    }
    return map;
  }

  /**
   * 把 to 合并进 from：拼接标签、扩展源码范围，并把 to 的出边改到 from 上。
   */
  private static applyMerge(
    from: FlowchartNode,
    to: FlowchartNode,
    nodes: FlowchartNode[],
    edges: FlowchartEdge[],
    locationMap: FlowchartIR["locationMap"],
    connectingEdge: FlowchartEdge
  ): void {
    // 逐条语句保留自己的源码范围与注释，小节才能各自点击跳转
    const fromSegments = StatementMerger.toSegments(from);
    const toSegments = StatementMerger.toSegments(to);
    from.segments = [...fromSegments, ...toSegments];
    from.comment = undefined;
    from.label = from.segments.map((segment) => segment.code).join("\n");

    if (from.location && to.location) {
      from.location = {
        start: Math.min(from.location.start, to.location.start),
        end: Math.max(from.location.end, to.location.end),
      };
    }

    // 删除被合并节点以及它们之间的连接边，其余边重定向到保留节点
    const remainingEdges: FlowchartEdge[] = [];
    for (const edge of edges) {
      if (edge === connectingEdge) {
        continue;
      }
      if (edge.from === to.id && edge.to === from.id) {
        continue;
      }
      if (edge.from === to.id) {
        edge.from = from.id;
      }
      if (edge.to === to.id) {
        edge.to = from.id;
      }
      if (edge.from === edge.to) {
        continue;
      }
      remainingEdges.push(edge);
    }
    edges.length = 0;
    edges.push(...remainingEdges);

    const nodeIndex = nodes.indexOf(to);
    if (nodeIndex >= 0) {
      nodes.splice(nodeIndex, 1);
    }

    StatementMerger.mergeLocationEntries(from, to, locationMap);
  }

  /**
   * 取出节点的语句片段；未合并节点转换成一个片段。
   */
  private static toSegments(node: FlowchartNode): NodeSegment[] {
    if (node.segments && node.segments.length > 0) {
      return node.segments;
    }
    return [{
      start: node.location?.start ?? 0,
      end: node.location?.end ?? 0,
      comment: node.comment ? StatementMerger.toSingleLine(node.comment) : undefined,
      code: StatementMerger.toSingleLine(node.label),
    }];
  }

  /** 把多行文本压成单行，供小节显示使用。 */
  private static toSingleLine(text: string): string {
    return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  }

  /**
   * 合并源码位置映射：点击合并后的节点时，选中整段连续语句。
   */
  private static mergeLocationEntries(
    from: FlowchartNode,
    to: FlowchartNode,
    locationMap: FlowchartIR["locationMap"]
  ): void {
    const fromEntry = locationMap.find((entry) => entry.nodeId === from.id);
    const toEntry = locationMap.find((entry) => entry.nodeId === to.id);

    if (fromEntry && toEntry) {
      fromEntry.start = Math.min(fromEntry.start, toEntry.start);
      fromEntry.end = Math.max(fromEntry.end, toEntry.end);
    }

    for (let index = locationMap.length - 1; index >= 0; index--) {
      if (locationMap[index].nodeId === to.id) {
        locationMap.splice(index, 1);
      }
    }
  }
}
