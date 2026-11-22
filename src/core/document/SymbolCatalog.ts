import { collectCVariables, listCFunctions } from "../language-services/c";

/** 变量种类：全局、函数内局部变量、函数参数。 */
export type VariableKind = "global" | "local" | "parameter";

export interface VariableInfo {
  name: string;
  type: string;
  kind: VariableKind;
  /** 初始化表达式（如果有）。 */
  initializer?: string;
  /** 声明在源码中的起止偏移。 */
  start: number;
  end: number;
}

export interface FunctionInfo {
  name: string;
  start: number;
  end: number;
  /** 函数签名文本（用于下拉框展示）。 */
  signature?: string;
}

export interface SymbolSummary {
  functions: FunctionInfo[];
  globals: VariableInfo[];
  locals: VariableInfo[];
}

/**
 * 按语言汇总函数、全局变量与当前函数局部变量。
 * 目前只有 C 语言有完整解析；其他语言先返回空集合，后续再逐个补齐。
 */
export function collectSymbols(
  sourceCode: string,
  languageId: string,
  functionName?: string
): SymbolSummary {
  const summary: SymbolSummary = { functions: [], globals: [], locals: [] };

  if (languageId === "c") {
    try {
      summary.functions = listCFunctions(sourceCode).map((name) => {
        const start = sourceCode.indexOf(name);
        return {
          name,
          start: start >= 0 ? start : 0,
          end: start >= 0 ? start + name.length : 0,
        };
      });
    } catch {
      summary.functions = [];
    }

    try {
      const variables = collectCVariables(sourceCode, functionName);
      summary.globals = variables.globals;
      summary.locals = variables.locals;
    } catch {
      summary.globals = [];
      summary.locals = [];
    }
  }

  return summary;
}
