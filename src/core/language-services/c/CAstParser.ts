import Parser from "web-tree-sitter";
import { AbstractParser } from "../../common/AbstractParser";
import {
  FlowchartIR,
  FlowchartNode,
  FlowchartEdge,
  NodeType,
} from "../../../ir/ir";
import { ProcessResult, LoopContext } from "../../common/AstParserTypes";
import { ensureParserInit } from "../common/ParserInit";
import type { VariableInfo } from "../../document/SymbolCatalog";

export class CAstParser extends AbstractParser {
  private constructor(parser: Parser) {
    super(parser, "c");
  }

  /**
   * Asynchronously creates and initializes an instance of CAstParser.
   * This is the required entry point for creating a parser instance.
   * @param wasmPath The file path to the tree-sitter-c.wasm file.
   * @returns A promise that resolves to a new CAstParser instance.
   */
  public static async create(wasmPath: string): Promise<CAstParser> {
    await ensureParserInit();
    const language = await Parser.Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(language);
    return new CAstParser(parser);
  }

  public listFunctions(sourceCode: string): string[] {
    return this.measurePerformance("listFunctions", () => {
      const tree = this.parser.parse(sourceCode);

      // Get function definitions
      const funcNames = tree.rootNode
        .descendantsOfType("function_definition")
        .map((f: Parser.SyntaxNode) => {
          const declarator = f.childForFieldName("declarator");
          return this.extractFunctionName(declarator) || "[anonymous]";
        });

      return funcNames;
    });
  }

  public findFunctionAtPosition(
    sourceCode: string,
    position: number
  ): string | undefined {
    const tree = this.parser.parse(sourceCode);

    // Check function definitions
    const func = tree.rootNode
      .descendantsOfType("function_definition")
      .find((f) => position >= f.startIndex && position <= f.endIndex);

    if (func) {
      const declarator = func.childForFieldName("declarator");
      return this.extractFunctionName(declarator) || "[anonymous]";
    }

    return undefined;
  }

  /**
   * 收集全局变量与目标函数内的局部变量/参数。
   */
  public collectVariables(
    sourceCode: string,
    functionName?: string
  ): { globals: VariableInfo[]; locals: VariableInfo[] } {
    const tree = this.parser.parse(sourceCode);
    const globals: VariableInfo[] = [];
    const locals: VariableInfo[] = [];

    for (const child of tree.rootNode.namedChildren) {
      if (child.type === "declaration") {
        this.collectDeclarationVariables(child, "global", globals);
      }
    }

    const functions = tree.rootNode.descendantsOfType("function_definition");
    const target = functionName
      ? functions.find((f) => {
          const declarator = f.childForFieldName("declarator");
          return this.extractFunctionName(declarator) === functionName;
        })
      : functions[0];

    if (target) {
      const declarator = target.childForFieldName("declarator");
      const parameters = declarator
        ? declarator.descendantsOfType("parameter_declaration")
        : [];
      for (const parameter of parameters) {
        const type = parameter.childForFieldName("type")?.text ?? "";
        const parameterDeclarator = parameter.childForFieldName("declarator");
        const name = parameterDeclarator
          ? this.extractDeclaratorName(parameterDeclarator)
          : undefined;
        if (name) {
          locals.push({
            name,
            type,
            kind: "parameter",
            start: parameter.startIndex,
            end: parameter.endIndex,
          });
        }
      }

      const body = target.childForFieldName("body");
      if (body) {
        for (const declaration of body.descendantsOfType("declaration")) {
          this.collectDeclarationVariables(declaration, "local", locals);
        }
      }
    }

    return { globals, locals };
  }

  private collectDeclarationVariables(
    declaration: Parser.SyntaxNode,
    kind: VariableInfo["kind"],
    out: VariableInfo[]
  ): void {
    const type = declaration.childForFieldName("type")?.text ?? "";
    for (const child of declaration.namedChildren) {
      if (child.type === "identifier") {
        out.push({
          name: child.text,
          type,
          kind,
          start: child.startIndex,
          end: child.endIndex,
        });
        continue;
      }
      if (!["init_declarator", "pointer_declarator", "array_declarator"].includes(child.type)) {
        continue;
      }
      const nameNode =
        child.type === "init_declarator"
          ? child.childForFieldName("declarator")
          : child;
      const name = nameNode ? this.extractDeclaratorName(nameNode) : undefined;
      if (!name) {
        continue;
      }
      out.push({
        name,
        type,
        kind,
        initializer:
          child.type === "init_declarator"
            ? child.childForFieldName("value")?.text
            : undefined,
        start: child.startIndex,
        end: child.endIndex,
      });
    }
  }

  private extractDeclaratorName(declarator: Parser.SyntaxNode): string | undefined {
    if (declarator.type === "identifier") {
      return declarator.text;
    }
    const anonymous = declarator.childForFieldName("declarator");
    if (anonymous) {
      return this.extractDeclaratorName(anonymous);
    }
    const identifier = declarator.children.find((child) => child.type === "identifier");
    return identifier?.text;
  }

  public generateFlowchart(
    sourceCode: string,
    functionName?: string,
    position?: number
  ): FlowchartIR {
    const tree = this.parser.parse(sourceCode);
    this.resetState();

    let targetNode: Parser.SyntaxNode | undefined;

    if (position !== undefined) {
      targetNode = tree.rootNode
        .descendantsOfType("function_definition")
        .find((f) => position >= f.startIndex && position <= f.endIndex);
    } else if (functionName) {
      targetNode = tree.rootNode
        .descendantsOfType("function_definition")
        .find((f) => {
          const declarator = f.childForFieldName("declarator");
          const extractedName = this.extractFunctionName(declarator);
          return extractedName === functionName;
        });
    } else {
      targetNode = tree.rootNode.descendantsOfType("function_definition")[0];
    }

    if (!targetNode) {
      return {
        nodes: [
          this.createSemanticNode(
            "A",
            "Place cursor inside a function to generate a flowchart.",
            NodeType.PROCESS
          ),
        ],
        edges: [],
        locationMap: [],
      };
    }

    const bodyToProcess = targetNode.childForFieldName("body");
    const declarator = targetNode.childForFieldName("declarator");
    const funcNameStr = this.escapeString(
      this.extractFunctionName(declarator) || "[anonymous]"
    );
    // 未转义的函数名，供变量面板定位局部变量
    const rawFunctionName = this.extractFunctionName(declarator) || "[anonymous]";
    const title = `Flowchart for function: ${funcNameStr}`;

    if (!bodyToProcess) {
      return {
        nodes: [
          this.createSemanticNode(
            "A",
            "Function has no body.",
            NodeType.PROCESS
          ),
        ],
        edges: [],
        locationMap: [],
      };
    }

    const nodes: FlowchartNode[] = [];
    const edges: FlowchartEdge[] = [];
    const entryId = this.generateNodeId("start");
    const exitId = this.generateNodeId("end");

    // Create semantic entry and exit nodes
    nodes.push(
      this.createSemanticNode(entryId, "Start", NodeType.ENTRY, targetNode)
    );
    nodes.push(
      this.createSemanticNode(exitId, "End", NodeType.EXIT, targetNode)
    );

    const bodyResult = this.processBlock(bodyToProcess, exitId);
    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);

    edges.push(
      bodyResult.entryNodeId
        ? { from: entryId, to: bodyResult.entryNodeId }
        : { from: entryId, to: exitId }
    );

    bodyResult.exitPoints.forEach((ep) => {
      if (!bodyResult.nodesConnectedToExit.has(ep.id)) {
        edges.push({ from: ep.id, to: exitId, label: ep.label });
      }
    });

    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const validEdges = edges.filter(
      (e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to)
    );

    const ir: FlowchartIR = {
      nodes,
      edges: validEdges,
      locationMap: this.locationMap,
      functionRange: { start: targetNode.startIndex, end: targetNode.endIndex },
      functionName: rawFunctionName,
      title,
      entryNodeId: entryId,
      exitNodeId: exitId,
    };


    return ir;
  }

  protected processStatement(
    statement: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    // Handle parenthesized expressions
    if (
      statement.type === "parenthesized_expression" &&
      statement.namedChild(0)
    ) {
      return this.processStatement(
        statement.namedChild(0)!,
        exitId,
        loopContext,
        finallyContext
      );
    }

    switch (statement.type) {
      case "compound_statement":
        // 循环体、else 分支这类位置拿到的是 { } 块：
        // 必须逐条展开成节点，不能把整块当成一条语句
        return this.processBlock(
          statement,
          exitId,
          loopContext,
          finallyContext
        );
      case "if_statement":
        return this.processIfStatement(
          statement,
          exitId,
          loopContext,
          finallyContext
        );
      case "for_statement":
        return this.processForStatement(statement, exitId, finallyContext);
      case "while_statement":
        return this.processWhileStatement(statement, exitId, finallyContext);
      case "do_statement":
        return this.processDoWhileStatement(statement, exitId, finallyContext);
      case "switch_statement":
        return this.processSwitchStatement(
          statement,
          exitId,
          loopContext,
          finallyContext
        );
      case "return_statement":
        return this.processReturnStatement(statement, exitId, finallyContext);
      case "break_statement":
        return loopContext
          ? this.processBreakStatement(statement, loopContext)
          : this.processDefaultStatement(statement);
      case "continue_statement":
        return loopContext
          ? this.processContinueStatement(statement, loopContext)
          : this.processDefaultStatement(statement);
      case "goto_statement":
        return this.processGotoStatement(statement, exitId);
      case "labeled_statement":
        return this.processLabeledStatement(
          statement,
          exitId,
          loopContext,
          finallyContext
        );
      default:
        return this.processDefaultStatement(statement);
    }
  }

  // --- PRIVATE HELPER AND PROCESSING METHODS --- //

  /**
   * Process either a single statement or a compound statement (block)
   * This handles both single statements and blocks properly for conditionals
   */
  private processStatementOrBlock(
    statementOrBlock: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    // If it's a compound statement (block), process it as a block
    if (statementOrBlock.type === "compound_statement") {
      return this.processBlock(
        statementOrBlock,
        exitId,
        loopContext,
        finallyContext
      );
    }

    // Otherwise, process it as a single statement
    return this.processStatement(
      statementOrBlock,
      exitId,
      loopContext,
      finallyContext
    );
  }

  private extractFunctionName(
    declarator: Parser.SyntaxNode | null
  ): string | null {
    if (!declarator) return null;

    // Handle different declarator types
    if (declarator.type === "function_declarator") {
      const identifier = declarator.childForFieldName("declarator");
      return identifier?.text || null;
    } else if (declarator.type === "identifier") {
      return declarator.text;
    } else if (declarator.type === "pointer_declarator") {
      // Handle function pointers: int (*func)()
      return this.extractFunctionName(
        declarator.childForFieldName("declarator")
      );
    }

    // Try to find identifier in children
    const identifierChild = declarator.children.find(
      (child) => child.type === "identifier"
    );
    return identifierChild?.text || null;
  }

  private processIfStatement(
    ifNode: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const ifConditionNode = ifNode.childForFieldName("condition");
    const ifConsequenceNode = ifNode.childForFieldName("consequence");

    if (!ifConditionNode || !ifConsequenceNode) {
      return this.createProcessResult();
    }

    const ifConditionId = this.generateNodeId("cond");
    const nodes: FlowchartNode[] = [
      this.createSemanticNode(
        ifConditionId,
        this.escapeString(ifConditionNode.text),
        NodeType.DECISION,
        ifConditionNode
      ),
    ];

    this.locationMap.push({
      start: ifConditionNode.startIndex,
      end: ifConditionNode.endIndex,
      nodeId: ifConditionId,
    });

    // Process the consequence (then branch) - handle both blocks and single statements
    const ifConsequenceResult = this.processStatementOrBlock(
      ifConsequenceNode,
      exitId,
      loopContext,
      finallyContext
    );

    nodes.push(...ifConsequenceResult.nodes);
    const edges: FlowchartEdge[] = [...ifConsequenceResult.edges];
    const nodesConnectedToExit = new Set<string>(
      ifConsequenceResult.nodesConnectedToExit
    );
    const allExitPoints: { id: string; label?: string }[] = [
      ...ifConsequenceResult.exitPoints,
    ];

    if (ifConsequenceResult.entryNodeId) {
      edges.push({
        from: ifConditionId,
        to: ifConsequenceResult.entryNodeId,
        label: "True",
      });
    } else {
      allExitPoints.push({ id: ifConditionId, label: "True" });
    }

    // Handle else clause - could be another if statement (else if) or a block.
    // tree-sitter-c 把 else 包在 else_clause 里，必须先拆一层，
    // 否则整段 "else if (...) {...}" 会被当成一条普通语句。
    const alternative = ifNode.childForFieldName("alternative");
    const elseNode = alternative
      ? this.unwrapElseClause(alternative)
      : undefined;
    if (elseNode) {
      const elseResult = this.processStatementOrBlock(
        elseNode,
        exitId,
        loopContext,
        finallyContext
      );

      nodes.push(...elseResult.nodes);
      edges.push(...elseResult.edges);
      elseResult.nodesConnectedToExit.forEach((n: string) =>
        nodesConnectedToExit.add(n)
      );

      if (elseResult.entryNodeId) {
        edges.push({
          from: ifConditionId,
          to: elseResult.entryNodeId,
          label: "False",
        });
      } else {
        allExitPoints.push({ id: ifConditionId, label: "False" });
      }

      allExitPoints.push(...elseResult.exitPoints);
    } else {
      allExitPoints.push({ id: ifConditionId, label: "False" });
    }

    return this.createProcessResult(
      nodes,
      edges,
      ifConditionId,
      allExitPoints,
      nodesConnectedToExit
    );
  }

  /**
   * tree-sitter-c 把 else 整体包在 else_clause 节点里：
   * `else { ... }` 里面是 compound_statement，`else if (...)` 里面是 if_statement。
   * 这里取出真正承载逻辑的那条语句，注释等额外节点跳过。
   */
  private unwrapElseClause(
    node: Parser.SyntaxNode
  ): Parser.SyntaxNode | undefined {
    if (node.type !== "else_clause") {
      return node;
    }
    const body = node.namedChildren.find((child) => child.type !== "comment");
    return body ? this.unwrapElseClause(body) : undefined;
  }

  private processForStatement(
    forNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const initNode = forNode.childForFieldName("initializer");
    const conditionNode = forNode.childForFieldName("condition");
    const updateNode = forNode.childForFieldName("update");
    const bodyNode = forNode.childForFieldName("body");

    const nodes: FlowchartNode[] = [];
    const edges: FlowchartEdge[] = [];
    const loopExitId = this.generateNodeId("for_exit");

    nodes.push(
      this.createSemanticNode(
        loopExitId,
        "end loop",
        NodeType.LOOP_END,
        forNode
      )
    );

    let currentId: string;

    // Handle initialization
    if (initNode) {
      const initId = this.generateNodeId("for_init");
      nodes.push(
        this.createSemanticNode(
          initId,
          this.escapeString(initNode.text),
          NodeType.ASSIGNMENT,
          initNode
        )
      );
      this.locationMap.push({
        start: initNode.startIndex,
        end: initNode.endIndex,
        nodeId: initId,
      });
      currentId = initId;
    } else {
      const startId = this.generateNodeId("for_start");
      nodes.push(
        this.createSemanticNode(
          startId,
          "for loop start",
          NodeType.LOOP_START,
          forNode
        )
      );
      currentId = startId;
    }

    // Handle condition
    let conditionId: string;
    if (conditionNode) {
      conditionId = this.generateNodeId("for_cond");
      nodes.push(
        this.createSemanticNode(
          conditionId,
          this.escapeString(conditionNode.text),
          NodeType.DECISION,
          conditionNode
        )
      );
      this.locationMap.push({
        start: conditionNode.startIndex,
        end: conditionNode.endIndex,
        nodeId: conditionId,
      });
      edges.push({ from: currentId, to: conditionId });
    } else {
      conditionId = currentId;
    }

    // Handle update
    let updateId: string | undefined;
    if (updateNode) {
      updateId = this.generateNodeId("for_update");
      nodes.push(
        this.createSemanticNode(
          updateId,
          this.escapeString(updateNode.text),
          NodeType.ASSIGNMENT,
          updateNode
        )
      );
      this.locationMap.push({
        start: updateNode.startIndex,
        end: updateNode.endIndex,
        nodeId: updateId,
      });
    }

    const loopContext: LoopContext = {
      breakTargetId: loopExitId,
      continueTargetId: updateId || conditionId,
    };

    // Handle body
    if (bodyNode) {
      const bodyResult = this.processStatementOrBlock(
        bodyNode,
        exitId,
        loopContext,
        finallyContext
      );

      nodes.push(...bodyResult.nodes);
      edges.push(...bodyResult.edges);

      if (bodyResult.entryNodeId) {
        edges.push({
          from: conditionId,
          to: bodyResult.entryNodeId,
          label: conditionNode ? "True" : "Loop",
        });
      }

      // Connect body exit to update or condition（这条就是循环继续的那条线）
      const nextId = updateId || conditionId;
      bodyResult.exitPoints.forEach((ep) => {
        edges.push({ from: ep.id, to: nextId, label: ep.label ? undefined : "continue" });
      });

      if (updateId) {
        // for 的循环继续线：自增/更新之后回到条件
        edges.push({ from: updateId, to: conditionId, label: "continue" });
      }
    }

    edges.push({
      from: conditionId,
      to: loopExitId,
      label: conditionNode ? "False" : "End",
    });

    return this.createProcessResult(nodes, edges, currentId, [
      { id: loopExitId },
    ]);
  }

  private processWhileStatement(
    whileNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const conditionNode = whileNode.childForFieldName("condition")!;
    const bodyNode = whileNode.childForFieldName("body");

    const conditionText = this.escapeString(conditionNode.text);
    const conditionId = this.generateNodeId("while_cond");
    const loopExitId = this.generateNodeId("while_exit");

    const nodes: FlowchartNode[] = [
      this.createSemanticNode(
        conditionId,
        conditionText,
        NodeType.DECISION,
        conditionNode
      ),
      this.createSemanticNode(
        loopExitId,
        "end loop",
        NodeType.LOOP_END,
        whileNode
      ),
    ];

    this.locationMap.push({
      start: conditionNode.startIndex,
      end: conditionNode.endIndex,
      nodeId: conditionId,
    });

    const edges: FlowchartEdge[] = [];
    const loopContext: LoopContext = {
      breakTargetId: loopExitId,
      continueTargetId: conditionId,
    };

    if (bodyNode) {
      const bodyResult = this.processStatement(
        bodyNode,
        exitId,
        loopContext,
        finallyContext
      );

      nodes.push(...bodyResult.nodes);
      edges.push(...bodyResult.edges);

      if (bodyResult.entryNodeId) {
        edges.push({
          from: conditionId,
          to: bodyResult.entryNodeId,
          label: "True",
        });
      }

      bodyResult.exitPoints.forEach((ep) => {
        edges.push({ from: ep.id, to: conditionId, label: ep.label ? undefined : "continue" });
      });
    }

    edges.push({ from: conditionId, to: loopExitId, label: "False" });

    return this.createProcessResult(nodes, edges, conditionId, [
      { id: loopExitId },
    ]);
  }

  private processDoWhileStatement(
    doNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const bodyNode = doNode.childForFieldName("body");
    const conditionNode = doNode.childForFieldName("condition");

    if (!bodyNode || !conditionNode) {
      return this.createProcessResult();
    }

    const conditionId = this.generateNodeId("do_while_cond");
    const loopExitId = this.generateNodeId("do_while_exit");

    const nodes: FlowchartNode[] = [
      this.createSemanticNode(
        conditionId,
        this.escapeString(conditionNode.text),
        NodeType.DECISION,
        conditionNode
      ),
      this.createSemanticNode(
        loopExitId,
        "end loop",
        NodeType.LOOP_END,
        doNode
      ),
    ];

    this.locationMap.push({
      start: conditionNode.startIndex,
      end: conditionNode.endIndex,
      nodeId: conditionId,
    });

    const edges: FlowchartEdge[] = [];
    const loopContext: LoopContext = {
      breakTargetId: loopExitId,
      continueTargetId: conditionId,
    };

    const bodyResult = this.processStatement(
      bodyNode,
      exitId,
      loopContext,
      finallyContext
    );

    nodes.push(...bodyResult.nodes);
    edges.push(...bodyResult.edges);

    // Connect body to condition（do/while 的循环继续线）
    bodyResult.exitPoints.forEach((ep) => {
      edges.push({ from: ep.id, to: conditionId, label: ep.label ? undefined : "continue" });
    });

    // Connect condition back to body or to exit
    if (bodyResult.entryNodeId) {
      edges.push({
        from: conditionId,
        to: bodyResult.entryNodeId,
        label: "True",
      });
    }

    edges.push({ from: conditionId, to: loopExitId, label: "False" });

    return this.createProcessResult(nodes, edges, bodyResult.entryNodeId, [
      { id: loopExitId },
    ]);
  }

  private processSwitchStatement(
    switchNode: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const conditionNode = switchNode.childForFieldName("condition");
    const bodyNode = switchNode.childForFieldName("body");

    if (!conditionNode || !bodyNode) {
      return this.createProcessResult();
    }

    const switchId = this.generateNodeId("switch");
    const nodes: FlowchartNode[] = [
      this.createSemanticNode(
        switchId,
        `switch (${this.escapeString(conditionNode.text)})`,
        NodeType.DECISION,
        conditionNode
      ),
    ];

    this.locationMap.push({
      start: conditionNode.startIndex,
      end: conditionNode.endIndex,
      nodeId: switchId,
    });

    const edges: FlowchartEdge[] = [];
    const nodesConnectedToExit = new Set<string>();
    const allExitPoints: { id: string; label?: string }[] = [];

    // Get case statements from the switch body
    const cases = bodyNode.namedChildren.filter(
      (child) => child.type === "case_statement" || child.type === "default"
    );

    let lastCaseExitPoints: { id: string; label?: string }[] = [
      { id: switchId },
    ];

    for (const caseNode of cases) {
      const isDefault = caseNode.type === "default";
      const valueNode = caseNode.childForFieldName("value");
      const caseLabel = isDefault
        ? "default"
        : `case ${this.escapeString(valueNode?.text || "")}`;

      const caseId = this.generateNodeId("case");
      nodes.push(
        this.createSemanticNode(caseId, caseLabel, NodeType.DECISION, caseNode)
      );

      this.locationMap.push({
        start: caseNode.startIndex,
        end: caseNode.endIndex,
        nodeId: caseId,
      });

      // Connect from previous case or switch
      lastCaseExitPoints.forEach((ep) => {
        edges.push({ from: ep.id, to: caseId, label: ep.label || "no match" });
      });

      // Process case body - get all statements that belong to this case
      const caseBody = caseNode.namedChildren.filter(
        (child) => child.type !== "case_statement" && child.type !== "default"
      );

      if (caseBody.length > 0) {
        let caseExitPoints: { id: string; label?: string }[] = [
          { id: caseId, label: "match" },
        ];

        for (const stmt of caseBody) {
          // Handle break statements specially in switch context
          if (stmt.type === "break_statement") {
            const breakResult = this.processBreakStatement(stmt, {
              breakTargetId: exitId,
              continueTargetId: loopContext?.continueTargetId || exitId,
            });
            nodes.push(...breakResult.nodes);
            edges.push(...breakResult.edges);
            caseExitPoints.forEach((ep) => {
              if (breakResult.entryNodeId) {
                edges.push({
                  from: ep.id,
                  to: breakResult.entryNodeId,
                  label: ep.label,
                });
              }
            });
            caseExitPoints = [];
            breakResult.nodesConnectedToExit.forEach((n) =>
              nodesConnectedToExit.add(n)
            );
            break; // No more statements after break
          }

          const stmtResult = this.processStatementOrBlock(
            stmt,
            exitId,
            loopContext,
            finallyContext
          );
          nodes.push(...stmtResult.nodes);
          edges.push(...stmtResult.edges);
          stmtResult.nodesConnectedToExit.forEach((n) =>
            nodesConnectedToExit.add(n)
          );

          if (stmtResult.entryNodeId) {
            caseExitPoints.forEach((ep) => {
              edges.push({
                from: ep.id,
                to: stmtResult.entryNodeId!,
                label: ep.label,
              });
            });
            caseExitPoints = stmtResult.exitPoints;
          }
        }

        allExitPoints.push(...caseExitPoints);
        lastCaseExitPoints =
          caseExitPoints.length > 0 ? [] : [{ id: caseId, label: "no match" }];
      } else {
        lastCaseExitPoints = [{ id: caseId, label: "no match" }];
        allExitPoints.push({ id: caseId, label: "match" });
      }
    }

    // Handle cases with no match
    allExitPoints.push(...lastCaseExitPoints);

    return this.createProcessResult(
      nodes,
      edges,
      switchId,
      allExitPoints,
      nodesConnectedToExit
    );
  }

  private processReturnStatement(
    returnNode: Parser.SyntaxNode,
    exitId: string,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const valueNode = returnNode.namedChild(0);
    const nodeId = this.generateNodeId("return");
    const labelText = valueNode
      ? `return ${this.escapeString(valueNode.text)}`
      : "return";

    const node: FlowchartNode = this.createSemanticNode(
      nodeId,
      labelText,
      NodeType.RETURN,
      returnNode
    );

    const edges: FlowchartEdge[] = [
      {
        from: nodeId,
        to: finallyContext ? finallyContext.finallyEntryId : exitId,
      },
    ];

    this.locationMap.push({
      start: returnNode.startIndex,
      end: returnNode.endIndex,
      nodeId,
    });

    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }

  private processBreakStatement(
    breakNode: Parser.SyntaxNode,
    loopContext: LoopContext
  ): ProcessResult {
    const nodeId = this.generateNodeId("break");
    const node: FlowchartNode = this.createSemanticNode(
      nodeId,
      "break",
      NodeType.BREAK_CONTINUE,
      breakNode
    );

    const edges: FlowchartEdge[] = [
      { from: nodeId, to: loopContext.breakTargetId },
    ];

    this.locationMap.push({
      start: breakNode.startIndex,
      end: breakNode.endIndex,
      nodeId,
    });

    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }

  private processContinueStatement(
    continueNode: Parser.SyntaxNode,
    loopContext: LoopContext
  ): ProcessResult {
    const nodeId = this.generateNodeId("continue");
    const node: FlowchartNode = this.createSemanticNode(
      nodeId,
      "continue",
      NodeType.BREAK_CONTINUE,
      continueNode
    );

    const edges: FlowchartEdge[] = [
      { from: nodeId, to: loopContext.continueTargetId, label: "continue" },
    ];

    this.locationMap.push({
      start: continueNode.startIndex,
      end: continueNode.endIndex,
      nodeId,
    });

    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }

  private processGotoStatement(
    gotoNode: Parser.SyntaxNode,
    exitId: string
  ): ProcessResult {
    const labelNode = gotoNode.namedChild(0);
    const nodeId = this.generateNodeId("goto");
    const labelText = labelNode
      ? `goto ${this.escapeString(labelNode.text)}`
      : "goto";

    const node: FlowchartNode = this.createSemanticNode(
      nodeId,
      labelText,
      NodeType.BREAK_CONTINUE,
      gotoNode
    );

    // For now, connect goto to exit (proper label handling would require more complex analysis)
    const edges: FlowchartEdge[] = [{ from: nodeId, to: exitId }];

    this.locationMap.push({
      start: gotoNode.startIndex,
      end: gotoNode.endIndex,
      nodeId,
    });

    return this.createProcessResult(
      [node],
      edges,
      nodeId,
      [],
      new Set([nodeId])
    );
  }

  private processLabeledStatement(
    labeledNode: Parser.SyntaxNode,
    exitId: string,
    loopContext?: LoopContext,
    finallyContext?: { finallyEntryId: string }
  ): ProcessResult {
    const labelName = labeledNode.childForFieldName("label");
    const statement = labeledNode.childForFieldName("statement");

    if (!statement) {
      return this.createProcessResult();
    }

    const labelId = this.generateNodeId("label");
    const labelText = labelName
      ? `${this.escapeString(labelName.text)}:`
      : "label:";

    const labelNodeItem = this.createSemanticNode(
      labelId,
      labelText,
      NodeType.PROCESS,
      labeledNode
    );

    this.locationMap.push({
      start: labeledNode.startIndex,
      end: labelName ? labelName.endIndex : labeledNode.endIndex,
      nodeId: labelId,
    });

    const stmtResult = this.processStatement(
      statement,
      exitId,
      loopContext,
      finallyContext
    );

    const nodes = [labelNodeItem, ...stmtResult.nodes];
    const edges = [...stmtResult.edges];

    if (stmtResult.entryNodeId) {
      edges.unshift({ from: labelId, to: stmtResult.entryNodeId });
    }

    return this.createProcessResult(
      nodes,
      edges,
      labelId,
      stmtResult.exitPoints.length > 0
        ? stmtResult.exitPoints
        : [{ id: labelId }],
      stmtResult.nodesConnectedToExit
    );
  }
}
