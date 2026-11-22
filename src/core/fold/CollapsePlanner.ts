import {
  FlowchartEdge,
  FlowchartIR,
  FlowchartNode,
  LocationMapEntry,
  NodeType,
} from "../../ir/ir";

/** 一个可折叠区域：折叠锚点（判断节点）、被隐藏的成员、区域唯一出口。 */
export interface FoldRegion {
  anchorId: string;
  memberIds: string[];
  /** 区域里被藏住的语句条数（合并块按 segments 计数，比节点数更准确）。 */
  statementCount: number;
  exitTargets: string[];
}

/** 第一版只折 if 的 ??（then）分支。 */
const ANCHOR_TYPES = new Set<NodeType | undefined>([NodeType.DECISION]);
/** 起止节点永远不参与折叠。 */
const FORBIDDEN_MEMBER_TYPES = new Set<NodeType | undefined>([
  NodeType.ENTRY,
  NodeType.EXIT,
]);
/** 区域至少藏住 2 条语句（合并块会把连续语句并成一个节点，所以按语句数算）。 */
const MIN_STATEMENT_COUNT = 2;

function countStatements(nodes: FlowchartNode[]): number {
  return nodes.reduce(
    (total, node) => total + Math.max(1, node.segments?.length ?? 0),
    0
  );
}

const SUMMARY_SUFFIX = "__fold";
const TRUE_LABELS = new Set(["true", "??", "?"]);
const FALSE_LABELS = new Set(["false", "✖", "✗"]);
/** switch / case 的合并语义比较绕，第一版不折；循环体则按 ✔️ 分支折叠。 */
const NON_IF_ID_PREFIX = /^(switch|case|for_init|for_update|for_exit|while_exit|do_while_exit)/;

function isTrueLabel(label?: string): boolean {
  const normalized = (label ?? "").trim().toLowerCase();
  return normalized.length > 0 && TRUE_LABELS.has(normalized);
}

function isFalseLabel(label?: string): boolean {
  const normalized = (label ?? "").trim().toLowerCase();
  return normalized.length > 0 && FALSE_LABELS.has(normalized);
}

/** if 条件与循环条件都能当折叠锚点。 */
function isFoldAnchor(node: FlowchartNode): boolean {
  if (!ANCHOR_TYPES.has(node.nodeType)) {
    return false;
  }
  if (NON_IF_ID_PREFIX.test(node.id)) {
    return false;
  }
  const label = (node.label ?? "").trim().toLowerCase();
  return !(label.startsWith("case") || label.startsWith("switch") || label.startsWith("match"));
}

function buildEdgeIndex(edges: FlowchartEdge[]): {
  outgoing: Map<string, FlowchartEdge[]>;
  incoming: Map<string, FlowchartEdge[]>;
} {
  const outgoing = new Map<string, FlowchartEdge[]>();
  const incoming = new Map<string, FlowchartEdge[]>();
  for (const edge of edges) {
    const outs = outgoing.get(edge.from);
    if (outs) {
      outs.push(edge);
    } else {
      outgoing.set(edge.from, [edge]);
    }
    const ins = incoming.get(edge.to);
    if (ins) {
      ins.push(edge);
    } else {
      incoming.set(edge.to, [edge]);
    }
  }
  return { outgoing, incoming };
}

function collectReachable(
  startId: string,
  stopId: string,
  outgoing: Map<string, FlowchartEdge[]>
): Set<string> {
  const reachable = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reachable.has(id) || id === stopId) {
      continue;
    }
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (!reachable.has(edge.to) && edge.to !== stopId) {
        stack.push(edge.to);
      }
    }
  }
  return reachable;
}

/**
 * 从 then 分支入口收集「单入口」区域：
 * 1) 先做一次可达性收集；
 * 2) 反复剔除「有区域外入边」或「类型禁用」的节点，直到稳定——
 *    这样汇合点（同时被 else 分支指向）以及汇合点之后的节点都会自动退出区域。
 */
function collectThenRegion(
  anchorId: string,
  startId: string,
  falseStartId: string | undefined,
  outgoing: Map<string, FlowchartEdge[]>,
  incoming: Map<string, FlowchartEdge[]>,
  nodeById: Map<string, FlowchartNode>
): FoldRegion | undefined {
  const reachable = collectReachable(startId, anchorId, outgoing);
  // 从 else / 汇合点能到达的节点全部不属于 then 区域，
  // 否则 if 后面的顺序代码会被一起吞掉
  if (falseStartId) {
    for (const id of collectReachable(falseStartId, anchorId, outgoing)) {
      reachable.delete(id);
    }
  }

  const members = new Set(reachable);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Array.from(members)) {
      const node = nodeById.get(id);
      if (!node || FORBIDDEN_MEMBER_TYPES.has(node.nodeType)) {
        members.delete(id);
        changed = true;
        break;
      }
      const hasExternalEntry = (incoming.get(id) ?? []).some(
        (edge) =>
          edge.from !== id && edge.from !== anchorId && !members.has(edge.from)
      );
      if (hasExternalEntry) {
        members.delete(id);
        changed = true;
        break;
      }
    }
  }

  const memberNodes = Array.from(members)
    .map((id) => nodeById.get(id))
    .filter((node): node is FlowchartNode => Boolean(node));
  const statementCount = countStatements(memberNodes);
  if (statementCount < MIN_STATEMENT_COUNT) {
    return undefined;
  }

  const exitTargets = new Set<string>();
  let loopsBack = false;
  for (const id of members) {
    for (const edge of outgoing.get(id) ?? []) {
      if (edge.to === id || members.has(edge.to)) {
        continue;
      }
      if (edge.to === anchorId) {
        loopsBack = true;
        continue;
      }
      exitTargets.add(edge.to);
    }
  }
  // 出口不唯一（例如 then 里既有 return 又有 break）就不折，宁可不折也别画错。
  // 循环体没有外部出口、只回边到条件本身，也允许折叠。
  if (exitTargets.size > 1 || (exitTargets.size === 0 && !loopsBack)) {
    return undefined;
  }

  return {
    anchorId,
    memberIds: Array.from(members),
    statementCount,
    exitTargets: Array.from(exitTargets),
  };
}

/**
 * 规划可折叠区域。第一版只处理 if 的 ??（then）分支。
 * 规则：单入口、单出口、成员至少 2 个、不含 Start/End。
 */
export function planFoldRegions(ir: FlowchartIR): FoldRegion[] {
  const { outgoing, incoming } = buildEdgeIndex(ir.edges);
  const nodeById = new Map(ir.nodes.map((node) => [node.id, node] as const));
  const regions: FoldRegion[] = [];

  for (const node of ir.nodes) {
    if (!isFoldAnchor(node)) {
      continue;
    }
    const trueEdge = (outgoing.get(node.id) ?? []).find((edge) =>
      isTrueLabel(edge.label)
    );
    if (!trueEdge) {
      continue;
    }
    const falseEdge = (outgoing.get(node.id) ?? []).find((edge) =>
      isFalseLabel(edge.label)
    );
    const region = collectThenRegion(
      node.id,
      trueEdge.to,
      falseEdge?.to,
      outgoing,
      incoming,
      nodeById
    );
    if (region) {
      regions.push(region);
    }
  }

  return regions;
}

function mergeRange(
  ir: FlowchartIR,
  memberIds: string[]
): { start: number; end: number } | undefined {
  const ranges = memberIds
    .map((id) => ir.nodes.find((node) => node.id === id)?.location)
    .filter((location): location is { start: number; end: number } =>
      Boolean(location)
    );
  if (ranges.length === 0) {
    return undefined;
  }
  return {
    start: Math.min(...ranges.map((range) => range.start)),
    end: Math.max(...ranges.map((range) => range.end)),
  };
}

/**
 * 把已折叠的区域替换成摘要节点，其余原样保留。
 * 锚点始终带上 fold 信息（用于画 ?/? 折叠钮），只有折叠时才真正隐藏成员。
 */
export function applyFolds(
  ir: FlowchartIR,
  collapsedAnchors: Set<string>
): FlowchartIR {
  const regions = planFoldRegions(ir);
  if (regions.length === 0) {
    return ir;
  }

  const regionByAnchor = new Map<string, FoldRegion>();
  for (const region of regions) {
    regionByAnchor.set(region.anchorId, region);
  }

  const hiddenBySummary = new Map<string, string>();
  const summaryNodes = new Map<string, FlowchartNode>();
  const summaryRanges = new Map<string, { start: number; end: number }>();
  const regionRangeByAnchor = new Map<string, { start: number; end: number }>();
  const hiddenIds = new Set<string>();

  for (const region of regions) {
    const collapsed = collapsedAnchors.has(region.anchorId);
    if (!collapsed) {
      continue;
    }
    // 已经被外层区域吞掉的成员不再重复处理
    const members = region.memberIds.filter((id) => !hiddenIds.has(id));
    if (members.length === 0) {
      continue;
    }
    const summaryId = `${region.anchorId}${SUMMARY_SUFFIX}`;
    const range = mergeRange(ir, members);
    for (const id of members) {
      hiddenIds.add(id);
      hiddenBySummary.set(id, summaryId);
    }
    const anchor = ir.nodes.find((node) => node.id === region.anchorId);
    summaryNodes.set(summaryId, {
      id: summaryId,
      label: `… 共 ${region.statementCount} 步`,
      nodeType: NodeType.PROCESS,
      location: range ?? anchor?.location,
      fold: {
        count: region.statementCount,
        collapsed: true,
        anchorId: region.anchorId,
        summary: true,
      },
    });
    if (range) {
      summaryRanges.set(summaryId, range);
      regionRangeByAnchor.set(region.anchorId, range);
    }
  }

  // 节点：隐藏成员 → 加摘要 → 给锚点补 fold 信息
  const nodes: FlowchartNode[] = [];
  for (const node of ir.nodes) {
    if (hiddenIds.has(node.id)) {
      continue;
    }
    const region = regionByAnchor.get(node.id);
    if (region) {
      nodes.push({
        ...node,
        fold: {
          count: region.statementCount,
          collapsed: collapsedAnchors.has(node.id),
        },
      });
    } else {
      nodes.push(node);
    }
  }
  nodes.push(...summaryNodes.values());

  // 边：成员之间的边丢弃，跨边界的边改接到摘要节点
  const edges: FlowchartEdge[] = [];
  const edgeKeys = new Set<string>();
  const pushEdge = (edge: FlowchartEdge): void => {
    const key = `${edge.from}|${edge.to}|${edge.label ?? ""}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    edges.push(edge);
  };
  for (const edge of ir.edges) {
    const fromHidden = hiddenBySummary.get(edge.from);
    const toHidden = hiddenBySummary.get(edge.to);
    if (fromHidden && toHidden) {
      if (fromHidden === toHidden) {
        continue;
      }
      // 两个不同区域之间的边：两端都换成摘要
      pushEdge({ from: fromHidden, to: toHidden, label: edge.label });
      continue;
    }
    if (fromHidden) {
      pushEdge({ from: fromHidden, to: edge.to, label: edge.label });
      continue;
    }
    if (toHidden) {
      pushEdge({ from: edge.from, to: toHidden, label: edge.label });
      continue;
    }
    pushEdge(edge);
  }

  // locationMap：隐藏节点不再单独可点；摘要可点回原范围；锚点补一条整段范围
  const locationMap: LocationMapEntry[] = ir.locationMap.filter(
    (entry) => !hiddenIds.has(entry.nodeId)
  );
  for (const [summaryId, range] of summaryRanges) {
    locationMap.push({ start: range.start, end: range.end, nodeId: summaryId });
  }
  for (const [anchorId, range] of regionRangeByAnchor) {
    locationMap.push({ start: range.start, end: range.end, nodeId: anchorId });
  }

  return {
    ...ir,
    nodes,
    edges,
    locationMap,
  };
}
