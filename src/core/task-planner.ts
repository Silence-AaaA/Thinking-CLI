/**
 * Task Planner — 任务分解器（重构版）
 *
 * ============================================================
 * Phase 5 核心：把复杂任务分解为可执行的树形结构
 *
 * 【设计哲学】
 * 采用四阶段规划流程：
 * 1. Goal Analysis — 理解目标，识别未知信息
 * 2. Dependency Discovery — 发现依赖关系
 * 3. Task Decomposition — 递归拆解为树形结构
 * 4. Execution Plan — 展平为执行序列
 *
 * 【核心改进】
 * - 从"一次性拆分"改为"递归拆解"
 * - 从"线性列表"改为"树形结构"
 * - 停止标准：叶子任务是"一次执行即可完成的原子操作"
 *
 * 【Working Memory 注入】
 * 使用 formatForPlanning()（精简版），不是 formatForLLM()（全量版）。
 * ============================================================
 */

import type { LLMAdapter, Message } from "../llm/types.js";
import { getLogger } from "../utils/logger.js";
import type { WorkingMemory } from "./working-memory.js";

// ============================================================
// 数据结构
// ============================================================

/** 目标分析结果 */
export interface GoalAnalysis {
  /** 目标对象（如 "working-memory"） */
  target: string;
  /** 执行动作（如 "添加单元测试"） */
  action: string;
  /** 最终产物（如 "test file"） */
  deliverable: string;
  /** 识别出的未知信息 */
  unknowns: string[];
  /** 需要收集的信息 */
  requiredInfo: string[];
}

/** 任务树节点 */
export interface TaskNode {
  /** 唯一标识（路径形式，如 "1", "1.2", "1.2.3"） */
  id: string;
  /** 任务标题 */
  title: string;
  /** 任务描述 */
  description: string;
  /** 子任务 */
  children: TaskNode[];
  /** 是否是原子任务（叶子节点，可一次执行完成） */
  isAtomic: boolean;
  /** 执行状态 */
  status: "pending" | "executing" | "completed" | "failed" | "skipped";
  /** 执行结果 */
  result?: string;
  /** 依赖的任务 ID 列表 */
  dependencies: string[];
  /** 重试次数 */
  retryCount: number;
}

/** 展平后的执行步骤（保持向后兼容） */
export interface TaskStep {
  id: number;
  description: string;
  status: "pending" | "executing" | "completed" | "failed" | "skipped";
  dependencies: number[];
  result?: string;
  retryCount: number;
  /** 对应的任务树节点 ID（用于追踪） */
  nodeId?: string;
}

/** 任务计划（保持向后兼容） */
export interface TaskPlan {
  goal: string;
  /** 目标分析结果 */
  goalAnalysis: GoalAnalysis;
  /** 任务树（完整结构） */
  taskTree: TaskNode;
  /** 展平的执行步骤（用于 StepExecutor） */
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** TaskPlanner 配置 */
export interface TaskPlannerConfig {
  /** 最大执行步骤数（展平后的步骤数） */
  maxSteps?: number;
  /** 每步最大重试次数 */
  maxRetriesPerStep?: number;
  /** 每个 plan step 内 Agent.run() 的最大迭代数 */
  maxIterationsPerStep?: number;
  /** 递归拆解的最大深度 */
  maxDecompositionDepth?: number;
  /** 叶子任务的最大数量 */
  maxLeafTasks?: number;
}

const DEFAULT_CONFIG: Required<TaskPlannerConfig> = {
  maxSteps: 8,
  maxRetriesPerStep: 2,
  maxIterationsPerStep: 8,
  maxDecompositionDepth: 4,
  maxLeafTasks: 12,
};

// ============================================================
// Prompt 模板
// ============================================================

/** Phase 1: 目标分析 Prompt */
const GOAL_ANALYSIS_PROMPT = `You are a goal analysis engine. Your job is to understand the task before planning.

## Your Task
Analyze the given goal and extract structured information.

## Output Format (JSON only)
\`\`\`json
{
  "target": "the main object/module/component",
  "action": "what needs to be done",
  "deliverable": "the final concrete output",
  "unknowns": ["things we don't know yet"],
  "requiredInfo": ["information we need to gather"]
}
\`\`\`

## Rules
1. Be SPECIFIC about the target (e.g., "src/working-memory.ts" not "the module")
2. Unknowns should be things that BLOCK planning (e.g., "what test framework is used")
3. Required info should be CONCRETE (e.g., "list of exported functions")
4. Output ONLY the JSON object`;

/** Phase 2: 依赖发现 Prompt */
const DEPENDENCY_DISCOVERY_PROMPT = `You are a dependency discovery engine. Given a goal analysis, identify what information and resources are needed.

## Your Task
Based on the goal analysis, list concrete dependencies that must be resolved before execution.

## Output Format (JSON only)
\`\`\`json
{
  "fileDependencies": ["src/foo.ts", "src/bar.ts"],
  "knowledgeDependencies": ["test framework used", "existing test patterns"],
  "toolDependencies": ["npm test", "typescript compiler"]
}
\`\`\`

## Rules
1. File dependencies: exact paths that will be read or modified
2. Knowledge dependencies: things to discover (not assumptions)
3. Tool dependencies: commands or tools needed
4. Output ONLY the JSON object`;

/** Phase 3: 递归拆解 Prompt */
const DECOMPOSITION_PROMPT = `You are a task decomposition engine. Decide if a task needs decomposition.

## CRITICAL: When to mark as ATOMIC (isAtomic=true)
Mark a task as ATOMIC if it matches ANY of these:
1. It involves reading a single file (e.g., "Read src/foo.ts")
2. It involves writing a single file (e.g., "Write tests in src/foo.test.ts")
3. It involves running a single command (e.g., "Run npm test")
4. It involves analyzing a single file (e.g., "Analyze exported functions of src/foo.ts")
5. The task description is already specific enough to execute directly

## When to decompose (isAtomic=false)
Only decompose if the task requires MULTIPLE INDEPENDENT actions that can be done in parallel or sequence, AND each action is substantial enough to warrant its own step.

## Examples of ATOMIC tasks (DO NOT decompose these):
- "Read src/working-memory.ts and identify exported functions"
- "Write unit tests for WorkingMemory class in src/working-memory.test.ts"
- "Run npm test and check results"
- "Analyze the public API of working-memory module"

## Examples of tasks that SHOULD be decomposed:
- "Add unit tests AND integration tests AND e2e tests" (multiple independent test types)
- "Refactor module A AND update module B AND migrate database" (multiple independent modules)

## Output Format (JSON only)
If ATOMIC:
\`\`\`json
{"isAtomic": true, "subtasks": []}
\`\`\`

If needs decomposition:
\`\`\`json
{
  "isAtomic": false,
  "subtasks": [
    {"title": "short title", "description": "specific action", "dependencies": []}
  ]
}
\`\`\`

## Rules
1. DEFAULT to atomic (isAtomic=true) unless clearly needs decomposition
2. Each subtask must be a SINGLE, INDEPENDENT action
3. Prefer 2-3 larger subtasks over many tiny ones
4. Output ONLY the JSON`;

/** Replan 专用 Prompt */
const REPLAN_PROMPT = `You are a task replanning engine. A step failed. Adjust the remaining plan.

## Your Task
Given the failed step and current progress, revise the plan.

## Rules
1. Keep completed steps as-is
2. For the failed step: retry differently, skip, or replace
3. Be SPECIFIC — exact file paths and commands
4. Each step must produce a deliverable
5. MAX 8 STEPS total (including completed ones)

## Output Format (JSON array only)
\`\`\`json
[
  { "id": 1, "title": "completed step", "description": "what was done", "dependencies": [] },
  { "id": 2, "title": "revised step", "description": "what to do", "dependencies": [1] }
]
\`\`\``;

// ============================================================
// TaskPlanner 主类
// ============================================================

/**
 * Task Planner（重构版）
 *
 * 四阶段规划：Goal Analysis → Dependency Discovery → Task Decomposition → Execution Plan
 * 递归拆解：大任务 → 子任务 → 子任务 → ... → 原子任务
 */
export class TaskPlanner {
  private llm: LLMAdapter;
  private config: Required<TaskPlannerConfig>;
  private logger = getLogger();
  private decompositionCallCount = 0;
  private readonly MAX_DECOMPOSITION_CALLS = 10;

  constructor(llm: LLMAdapter, config?: TaskPlannerConfig) {
    this.llm = llm;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 获取每步最大迭代数 */
  get maxIterationsPerStep(): number {
    return this.config.maxIterationsPerStep;
  }

  // ============================================================
  // JSON 提取工具
  // ============================================================

  /**
   * 从内容中提取第一个完整的 JSON 对象
   */
  private extractJSON(content: string): string | null {
    // 尝试直接解析整个内容
    try {
      JSON.parse(content);
      return content;
    } catch {}

    // 尝试找到第一个 { 开始的完整 JSON 对象
    let depth = 0;
    let start = -1;

    for (let i = 0; i < content.length; i++) {
      if (content[i] === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (content[i] === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = content.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            start = -1;
          }
        }
      }
    }

    return null;
  }

  /**
   * 从内容中提取第一个完整的 JSON 数组
   */
  private extractJSONArray(content: string): string | null {
    // 尝试直接解析整个内容
    try {
      JSON.parse(content);
      return content;
    } catch {}

    // 尝试找到第一个 [ 开始的完整 JSON 数组
    let depth = 0;
    let start = -1;

    for (let i = 0; i < content.length; i++) {
      if (content[i] === "[") {
        if (depth === 0) start = i;
        depth++;
      } else if (content[i] === "]") {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = content.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            start = -1;
          }
        }
      }
    }

    return null;
  }

  // ============================================================
  // 主入口：四阶段规划
  // ============================================================

  /**
   * 分解任务为计划（四阶段）
   */
  async plan(goal: string, memory: WorkingMemory): Promise<TaskPlan> {
    this.logger.info("TaskPlanner", `Planning: ${goal.slice(0, 80)}`);
    this.decompositionCallCount = 0; // Reset counter
    const context = memory.formatForPlanning();

    // Phase 1: Goal Analysis（目标分析）
    this.logger.info("TaskPlanner", "Phase 1: Goal Analysis");
    const goalAnalysis = await this.analyzeGoal(goal, context);

    // Phase 2: Dependency Discovery（依赖发现）
    this.logger.info("TaskPlanner", "Phase 2: Dependency Discovery");
    const dependencies = await this.discoverDependencies(goalAnalysis, context);

    // Phase 3: Task Decomposition（递归拆解）
    this.logger.info("TaskPlanner", "Phase 3: Task Decomposition");
    const taskTree = await this.decomposeTask(goal, goalAnalysis, dependencies, context, 0);

    // Phase 4: Execution Plan（展平为执行序列）
    this.logger.info("TaskPlanner", "Phase 4: Execution Plan");
    const steps = this.flattenTree(taskTree);

    this.logger.info("TaskPlanner", `Plan created: ${steps.length} steps, tree depth=${this.getTreeDepth(taskTree)}`);

    return {
      goal,
      goalAnalysis,
      taskTree,
      steps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    };
  }

  // ============================================================
  // Phase 1: Goal Analysis
  // ============================================================

  private async analyzeGoal(goal: string, context: string): Promise<GoalAnalysis> {
    const messages: Message[] = [
      { role: "system", content: GOAL_ANALYSIS_PROMPT },
      { role: "user", content: context },
      { role: "assistant", content: "Context noted. I will analyze the goal." },
      {
        role: "user",
        content: `## Goal\n${goal}\n\nAnalyze this goal and output the JSON.`,
      },
    ];

    const response = await this.llm.chat(messages, []);
    return this.parseGoalAnalysis(response.content, goal);
  }

  private parseGoalAnalysis(content: string, goal: string): GoalAnalysis {
    const jsonStr = this.extractJSON(content);
    if (!jsonStr) {
      this.logger.warn("TaskPlanner", "Failed to parse goal analysis, using defaults");
      return {
        target: goal,
        action: goal,
        deliverable: "completed task",
        unknowns: [],
        requiredInfo: [],
      };
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        target: parsed.target ?? goal,
        action: parsed.action ?? goal,
        deliverable: parsed.deliverable ?? "completed task",
        unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns : [],
        requiredInfo: Array.isArray(parsed.requiredInfo) ? parsed.requiredInfo : [],
      };
    } catch (e) {
      this.logger.warn("TaskPlanner", `Goal analysis parse error: ${e}`);
      return {
        target: goal,
        action: goal,
        deliverable: "completed task",
        unknowns: [],
        requiredInfo: [],
      };
    }
  }

  // ============================================================
  // Phase 2: Dependency Discovery
  // ============================================================

  private async discoverDependencies(
    goalAnalysis: GoalAnalysis,
    context: string,
  ): Promise<{
    fileDependencies: string[];
    knowledgeDependencies: string[];
    toolDependencies: string[];
  }> {
    const messages: Message[] = [
      { role: "system", content: DEPENDENCY_DISCOVERY_PROMPT },
      { role: "user", content: context },
      { role: "assistant", content: "Context noted. I will identify dependencies." },
      {
        role: "user",
        content: [
          `## Goal Analysis`,
          `- Target: ${goalAnalysis.target}`,
          `- Action: ${goalAnalysis.action}`,
          `- Deliverable: ${goalAnalysis.deliverable}`,
          `- Unknowns: ${goalAnalysis.unknowns.join(", ") || "none"}`,
          `- Required Info: ${goalAnalysis.requiredInfo.join(", ") || "none"}`,
          "",
          `Identify dependencies and output the JSON.`,
        ].join("\n"),
      },
    ];

    const response = await this.llm.chat(messages, []);
    return this.parseDependencies(response.content);
  }

  private parseDependencies(content: string): {
    fileDependencies: string[];
    knowledgeDependencies: string[];
    toolDependencies: string[];
  } {
    const jsonStr = this.extractJSON(content);
    if (!jsonStr) {
      return {
        fileDependencies: [],
        knowledgeDependencies: [],
        toolDependencies: [],
      };
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        fileDependencies: Array.isArray(parsed.fileDependencies) ? parsed.fileDependencies : [],
        knowledgeDependencies: Array.isArray(parsed.knowledgeDependencies) ? parsed.knowledgeDependencies : [],
        toolDependencies: Array.isArray(parsed.toolDependencies) ? parsed.toolDependencies : [],
      };
    } catch (e) {
      this.logger.warn("TaskPlanner", `Dependencies parse error: ${e}`);
      return {
        fileDependencies: [],
        knowledgeDependencies: [],
        toolDependencies: [],
      };
    }
  }

  // ============================================================
  // Phase 3: Recursive Decomposition（递归拆解）
  // ============================================================

  /**
   * 递归拆解任务为树形结构
   *
   * 核心算法：
   * 1. 判断当前任务是否是原子任务（可一次执行完成）
   * 2. 如果是原子任务，返回叶子节点
   * 3. 如果不是，拆解为子任务，递归处理每个子任务
   */
  private async decomposeTask(
    title: string,
    goalAnalysis: GoalAnalysis,
    dependencies: { fileDependencies: string[]; knowledgeDependencies: string[]; toolDependencies: string[] },
    context: string,
    depth: number,
    parentId: string = "",
  ): Promise<TaskNode> {
    // 停止条件1：达到最大深度
    if (depth >= this.config.maxDecompositionDepth) {
      this.logger.info("TaskPlanner", `Max depth reached for "${title}", making atomic`);
      return this.createAtomicNode(parentId || "1", title, `Execute: ${title}`);
    }

    // 停止条件2：递归调用次数超限
    this.decompositionCallCount++;
    if (this.decompositionCallCount > this.MAX_DECOMPOSITION_CALLS) {
      this.logger.warn(
        "TaskPlanner",
        `Max decomposition calls reached (${this.MAX_DECOMPOSITION_CALLS}), making "${title}" atomic`,
      );
      return this.createAtomicNode(parentId || "1", title, `Execute: ${title}`);
    }

    // 调用 LLM 判断是否需要拆解
    const messages: Message[] = [
      { role: "system", content: DECOMPOSITION_PROMPT },
      { role: "user", content: context },
      { role: "assistant", content: "Context noted. I will analyze the task." },
      {
        role: "user",
        content: [
          `## Task to Analyze`,
          `Title: ${title}`,
          `Goal: ${goalAnalysis.action} ${goalAnalysis.target}`,
          `Deliverable: ${goalAnalysis.deliverable}`,
          "",
          `## Context`,
          `File dependencies: ${dependencies.fileDependencies.join(", ") || "none"}`,
          `Knowledge dependencies: ${dependencies.knowledgeDependencies.join(", ") || "none"}`,
          `Tool dependencies: ${dependencies.toolDependencies.join(", ") || "none"}`,
          "",
          `Should this task be decomposed? If yes, provide subtasks. If no, mark as atomic.`,
          `Output ONLY the JSON.`,
        ].join("\n"),
      },
    ];

    const response = await this.llm.chat(messages, []);
    const decomposition = this.parseDecomposition(response.content);

    // 如果是原子任务，返回叶子节点
    if (decomposition.isAtomic || decomposition.subtasks.length === 0) {
      return this.createAtomicNode(parentId || "1", title, `Execute: ${title}`);
    }

    // 递归拆解子任务
    const children: TaskNode[] = [];
    for (let i = 0; i < decomposition.subtasks.length; i++) {
      const subtask = decomposition.subtasks[i];
      const childId = parentId ? `${parentId}.${i + 1}` : `${i + 1}`;

      const child = await this.decomposeTask(subtask.title, goalAnalysis, dependencies, context, depth + 1, childId);

      // 设置依赖关系
      child.dependencies = subtask.dependencies
        .map((depTitle) => {
          const depIndex = decomposition.subtasks.findIndex((s) => s.title === depTitle);
          return depIndex >= 0 ? (parentId ? `${parentId}.${depIndex + 1}` : `${depIndex + 1}`) : "";
        })
        .filter(Boolean);

      children.push(child);
    }

    // 停止条件2：叶子任务数量超过限制
    const totalLeafTasks = this.countLeafTasks(children);
    if (totalLeafTasks > this.config.maxLeafTasks) {
      this.logger.info("TaskPlanner", `Too many leaf tasks (${totalLeafTasks}), making atomic`);
      return this.createAtomicNode(parentId || "1", title, `Execute: ${title}`);
    }

    return {
      id: parentId || "1",
      title,
      description: `Decompose: ${title}`,
      children,
      isAtomic: false,
      status: "pending",
      dependencies: [],
      retryCount: 0,
    };
  }

  private parseDecomposition(content: string): {
    isAtomic: boolean;
    subtasks: Array<{ title: string; description: string; dependencies: string[] }>;
  } {
    const jsonStr = this.extractJSON(content);
    if (!jsonStr) {
      return { isAtomic: true, subtasks: [] };
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        isAtomic: Boolean(parsed.isAtomic),
        subtasks: Array.isArray(parsed.subtasks)
          ? parsed.subtasks.map((s: any) => ({
              title: s.title ?? "Subtask",
              description: s.description ?? s.title ?? "Subtask",
              dependencies: Array.isArray(s.dependencies) ? s.dependencies : [],
            }))
          : [],
      };
    } catch (e) {
      this.logger.warn("TaskPlanner", `Decomposition parse error: ${e}`);
      return { isAtomic: true, subtasks: [] };
    }
  }

  private createAtomicNode(id: string, title: string, description: string): TaskNode {
    return {
      id,
      title,
      description,
      children: [],
      isAtomic: true,
      status: "pending",
      dependencies: [],
      retryCount: 0,
    };
  }

  // ============================================================
  // Phase 4: Flatten Tree（展平为执行序列）
  // ============================================================

  /**
   * 将任务树展平为执行步骤列表
   *
   * 策略：深度优先遍历，只收集叶子节点（原子任务）
   */
  private flattenTree(root: TaskNode): TaskStep[] {
    const leafNodes: TaskNode[] = [];
    this.collectLeafNodes(root, leafNodes);

    // 分配顺序 ID 并构建依赖关系
    const steps: TaskStep[] = leafNodes.map((node, index) => ({
      id: index + 1,
      description: node.description,
      status: "pending",
      dependencies: this.resolveLeafDependencies(node, leafNodes),
      retryCount: 0,
      nodeId: node.id,
    }));

    return steps;
  }

  /**
   * 收集所有叶子节点（深度优先）
   */
  private collectLeafNodes(node: TaskNode, result: TaskNode[]): void {
    if (node.isAtomic || node.children.length === 0) {
      result.push(node);
    } else {
      for (const child of node.children) {
        this.collectLeafNodes(child, result);
      }
    }
  }

  /**
   * 解析叶子节点的依赖关系（转换为步骤 ID）
   */
  private resolveLeafDependencies(node: TaskNode, allLeaves: TaskNode[]): number[] {
    if (!node.dependencies || node.dependencies.length === 0) {
      return [];
    }

    return node.dependencies
      .map((depId) => {
        const depIndex = allLeaves.findIndex((leaf) => leaf.id === depId);
        return depIndex >= 0 ? depIndex + 1 : -1;
      })
      .filter((id) => id > 0);
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 计算树的深度
   */
  private getTreeDepth(node: TaskNode): number {
    if (node.children.length === 0) return 0;
    return 1 + Math.max(...node.children.map((child) => this.getTreeDepth(child)));
  }

  /**
   * 计算叶子节点数量
   */
  private countLeafTasks(nodes: TaskNode[]): number {
    let count = 0;
    for (const node of nodes) {
      if (node.isAtomic || node.children.length === 0) {
        count++;
      } else {
        count += this.countLeafTasks(node.children);
      }
    }
    return count;
  }

  // ============================================================
  // Replan（重规划）
  // ============================================================

  /**
   * 重新规划（某步失败后）
   */
  async replan(plan: TaskPlan, failedStep: TaskStep, failureReason: string, memory: WorkingMemory): Promise<TaskPlan> {
    this.logger.info("TaskPlanner", `Replanning after step ${failedStep.id} failed: ${failureReason.slice(0, 80)}`);

    const stepsSummary = plan.steps
      .map((s) => {
        const status =
          s.status === "completed"
            ? "DONE"
            : s.status === "failed"
              ? "FAILED"
              : s.status === "skipped"
                ? "SKIPPED"
                : "PENDING";
        return `  Step ${s.id} [${status}]: ${s.description}${s.result ? ` -> ${s.result}` : ""}`;
      })
      .join("\n");

    const messages: Message[] = [
      { role: "system", content: REPLAN_PROMPT },
      { role: "user", content: memory.formatForPlanning() },
      { role: "assistant", content: "Context noted. I will revise the plan." },
      {
        role: "user",
        content: [
          `## Original Goal`,
          plan.goal,
          "",
          `## Current Progress`,
          stepsSummary,
          "",
          `## Failed Step`,
          `Step ${failedStep.id}: ${failedStep.description}`,
          `Failure: ${failureReason}`,
          "",
          `Revise the remaining steps. Keep completed steps. Fix or replace the failed step.`,
          `Be SPECIFIC. No exploration steps.`,
          `Output ONLY the JSON array.`,
        ].join("\n"),
      },
    ];

    const response = await this.llm.chat(messages, []);
    const newSteps = this.parseReplanSteps(response.content);

    // 保留已完成步骤的结果
    for (const newStep of newSteps) {
      const oldStep = plan.steps.find((s) => s.id === newStep.id && s.status === "completed");
      if (oldStep) {
        newStep.status = "completed";
        newStep.result = oldStep.result;
      }
    }

    // 构建新的计划（保留原有的 goalAnalysis 和 taskTree）
    const newPlan: TaskPlan = {
      ...plan,
      steps: newSteps,
      updatedAt: Date.now(),
      version: plan.version + 1,
    };

    this.logger.info("TaskPlanner", `Replan v${newPlan.version}: ${newSteps.length} steps`);

    return newPlan;
  }

  private parseReplanSteps(content: string): TaskStep[] {
    const jsonStr = this.extractJSONArray(content);
    if (!jsonStr) {
      this.logger.warn("TaskPlanner", "Failed to parse replan steps");
      return [];
    }

    try {
      const parsed = JSON.parse(jsonStr) as Array<{
        id: number;
        title?: string;
        description: string;
        dependencies?: number[];
      }>;

      return parsed.map((item) => ({
        id: item.id,
        description: item.description || item.title || "Step",
        status: "pending" as const,
        dependencies: item.dependencies ?? [],
        retryCount: 0,
      }));
    } catch (e) {
      this.logger.warn("TaskPlanner", `Replan parse error: ${e}`);
      return [];
    }
  }
}
