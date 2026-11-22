export interface Location {
  start: number;
  end: number;
}

export enum NodeType {
  ENTRY = "entry",
  EXIT = "exit",
  PROCESS = "process",
  DECISION = "decision",
  MERGE = "merge", 
  LOOP_START = "loop_start",
  LOOP_END = "loop_end",
  EXCEPTION = "exception",
  BREAK_CONTINUE = "break_continue",
  FUNCTION_CALL = "function_call",
  ASSIGNMENT = "assignment",
  RETURN = "return",
  ASYNC_OPERATION = "async_operation",
  AWAIT = "await",
  PANIC = "panic",
  EARLY_RETURN_ERROR = "early_return_error",
  METHOD_CALL = "method_call",
  MACRO_CALL = "macro_call",
  SUBROUTINE = "subroutine",
}

export enum NodeCategory {
  CONTROL_FLOW = "control_flow",
  DATA_OPERATION = "data_operation",
  FUNCTION_BOUNDARY = "function_boundary",
  EXCEPTION_HANDLING = "exception_handling",
  LOOP_CONTROL = "loop_control",
  ASYNC_CONTROL = "async_control",
}

export interface SemanticNodeInfo {
  complexity?: "low" | "medium" | "high";
  importance?: "low" | "medium" | "high";
  codeType?: "synchronous" | "asynchronous" | "callback";
  language?: string;
}

export interface NodeSegment {
  /** 该语句在源码中的起止偏移。 */
  start: number;
  end: number;
  /** 该语句的展示文本（已拼成单行）。 */
  code: string;
}

/** 折叠信息：挂在锚点（判断节点）与折叠后的摘要节点上。 */
export interface FoldInfo {
  /** 被折叠的语句节点个数。 */
  count: number;
  /** 当前是否为折叠状态。 */
  collapsed: boolean;
  /** 摘要节点指回它的锚点；锚点自己不带这个字段。 */
  anchorId?: string;
  /** 标记这是折叠后生成的摘要节点（不可行内编辑）。 */
  summary?: boolean;
}

export interface FlowchartNode {
  id: string;
  label: string;
  location?: Location;
  shape?: "rect" | "diamond" | "round" | "stadium";
  style?: string;

  nodeType?: NodeType;
  nodeCategory?: NodeCategory;

  semanticInfo?: SemanticNodeInfo;

  /** 合并块内逐条语句的源码范围，用于每个小节单独点击跳转。 */
  segments?: NodeSegment[];

  /** 折叠信息；有值才渲染折叠钮。 */
  fold?: FoldInfo;
}

export interface FlowchartEdge {
  from: string;
  to: string;
  label?: string;
}

export interface LocationMapEntry {
  start: number;
  end: number;
  nodeId: string;
}

export interface FlowchartIR {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  entryNodeId?: string;
  exitNodeId?: string;
  locationMap: LocationMapEntry[];
  functionRange?: { start: number; end: number };
  /** 本次分析的函数名（固定或跟随光标选中的那个），用于变量面板取局部变量。 */
  functionName?: string;
  title?: string;
}