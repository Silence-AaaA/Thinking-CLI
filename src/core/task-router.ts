/**
 * Task Router — 任务路由器
 *
 * ============================================================
 * 职责：判断任务应该走 DIRECT 还是 PLAN 路径
 *
 * 【设计哲学】
 * TaskRouter 只负责"走哪条路"，不负责"如何规划"：
 * - DIRECT: 一次 Agent.run() 可以完成
 * - PLAN: 需要多个阶段，产生中间产物
 *
 * 【判断标准】
 * 让 LLM 判断任务能否在一次自主执行中完成：
 * - 如果能 → DIRECT
 * - 如果不能 → PLAN
 *
 * 【与 TaskPlanner 的关系】
 * - TaskRouter: 判断是否需要 Planning
 * - TaskPlanner: 只在 PLAN 后运行，负责生成 stages
 * ============================================================
 */

import type { LLMAdapter, Message } from "../llm/types.js";
import { getLogger } from "../utils/logger.js";
import type { WorkingMemory } from "./working-memory.js";

/** 路由结果 */
export type RouteResult = "direct" | "planner";

/** 路由分析结果 */
export interface RouteAnalysis {
  /** 执行模式：DIRECT 或 PLAN */
  execution_mode: "DIRECT" | "PLAN";
  /** 判断原因 */
  reason: string;
}

/** TaskRouter 配置 */
export interface TaskRouterConfig {
  /** 强制使用 Planning（忽略 LLM 判断） */
  forcePlan?: boolean;
}

const DEFAULT_CONFIG: Required<TaskRouterConfig> = {
  forcePlan: false,
};

/** Router Prompt — 只判断走哪条路，不拆分任务 */
const ROUTER_PROMPT = `You are a task routing engine. Analyze the user's goal and determine the execution mode.

## Your Task
Determine whether this goal can be completed within ONE autonomous execution, or requires multiple stages with intermediate artifacts.

## DIRECT Mode
Choose DIRECT if the goal can be completed in a single execution:
- Explain something
- Read a file
- Search for something
- Fix a simple bug
- Update a single value
- Answer a question

## PLAN Mode
Choose PLAN if the goal requires multiple stages:
- Analysis before implementation
- Design before coding
- Testing after implementation
- Multiple dependent steps
- Complex refactoring

## Examples
- "Explain working-memory.ts" → DIRECT (single execution)
- "Read the README" → DIRECT (single execution)
- "Fix typo in line 42" → DIRECT (single execution)
- "Add unit tests for working-memory" → PLAN (analyze → design → implement → verify)
- "Refactor state-machine" → PLAN (analyze → design → implement → test)
- "Implement OAuth login" → PLAN (design → implement → test → integrate)

## Output Format (JSON only)
\`\`\`json
{
  "execution_mode": "DIRECT | PLAN",
  "reason": "brief explanation of the decision"
}
\`\`\`

Output ONLY the JSON object.`;

/**
 * Task Router
 *
 * 判断任务应该走 DIRECT 还是 PLAN 路径
 */
export class TaskRouter {
  private llm: LLMAdapter;
  private config: Required<TaskRouterConfig>;
  private logger = getLogger();

  constructor(llm: LLMAdapter, config?: TaskRouterConfig) {
    this.llm = llm;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 判断任务应该走哪条路径
   *
   * @param goal 用户目标
   * @param memory 工作记忆
   * @returns "direct" | "planner"
   */
  async route(goal: string, memory: WorkingMemory): Promise<RouteResult> {
    this.logger.info("TaskRouter", `Routing: ${goal.slice(0, 80)}`);

    // 强制 Planning 模式
    if (this.config.forcePlan) {
      this.logger.info("TaskRouter", "Force plan mode enabled");
      return "planner";
    }

    // 调用 LLM 判断
    const analysis = await this.analyzeGoal(goal, memory);

    this.logger.info("TaskRouter", `Decision: ${analysis.execution_mode} - ${analysis.reason}`);

    return analysis.execution_mode === "PLAN" ? "planner" : "direct";
  }

  /**
   * 分析目标，返回执行模式
   */
  private async analyzeGoal(goal: string, memory: WorkingMemory): Promise<RouteAnalysis> {
    const context = memory.formatForPlanning();

    const messages: Message[] = [
      { role: "system", content: ROUTER_PROMPT },
      { role: "user", content: context },
      { role: "assistant", content: "Context noted. I will analyze the goal." },
      {
        role: "user",
        content: `## Goal\n${goal}\n\nDetermine the execution mode and output the JSON.`,
      },
    ];

    const response = await this.llm.chat(messages, []);
    return this.parseAnalysis(response.content);
  }

  /**
   * 解析 LLM 返回的分析结果
   */
  private parseAnalysis(content: string): RouteAnalysis {
    const jsonStr = this.extractJSON(content);
    if (!jsonStr) {
      this.logger.warn("TaskRouter", "Failed to parse analysis, defaulting to PLAN");
      return {
        execution_mode: "PLAN",
        reason: "Failed to parse analysis, defaulting to PLAN for safety",
      };
    }

    try {
      const parsed = JSON.parse(jsonStr);
      const mode = parsed.execution_mode === "DIRECT" ? "DIRECT" : "PLAN";
      return {
        execution_mode: mode,
        reason: parsed.reason ?? "No reason provided",
      };
    } catch (e) {
      this.logger.warn("TaskRouter", `Parse error: ${e}, defaulting to PLAN`);
      return {
        execution_mode: "PLAN",
        reason: "Parse error, defaulting to PLAN for safety",
      };
    }
  }

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
}
