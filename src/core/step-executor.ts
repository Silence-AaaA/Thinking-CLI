/**
 * Step Executor — 步骤执行器
 *
 * ============================================================
 * Phase 5：按 TaskPlan 逐步执行，每步调用 Agent.run()
 *
 * 【设计哲学】
 * StepExecutor 是 TaskPlanner 和 Agent 之间的桥梁：
 * - TaskPlanner 负责"做什么"（步骤分解）
 * - StepExecutor 负责"按什么顺序做"（依赖管理、状态传递）
 * - Agent.run() 负责"怎么做"（ReAct 循环执行）
 *
 * 【关键设计】每步执行前调用 agent.resetForStep()：
 * - 重置 StateMachine 到 planning（避免终态阻塞）
 * - 重置 Agent state（避免 step 计数累加、maxIterations 被绕过）
 * - 保留 Working Memory（跨步骤共享上下文）
 *
 * 【Token 控制】每步设置独立的 maxIterations（默认 10），
 * 避歄单步消耗过多 token。
 * ============================================================
 */

import { getLogger } from "../utils/logger.js";
import type { Agent } from "./agent.js";
import type { TaskPlan, TaskStep } from "./task-planner.js";
import type { WorkingMemory } from "./working-memory.js";

/** 步骤执行结果 */
export interface StepExecutionResult {
  stepId: number;
  status: "completed" | "failed";
  result: string;
  durationMs: number;
}

/** 执行计划的完整结果 */
export interface PlanExecutionResult {
  plan: TaskPlan;
  stepResults: StepExecutionResult[];
  finalStatus: "completed" | "failed" | "partial";
  completedSteps: number;
  totalSteps: number;
  durationMs: number;
}

/** StepExecutor 配置 */
export interface StepExecutorConfig {
  /** 每个 plan step 内 Agent.run() 的最大迭代数（默认 10） */
  maxIterationsPerStep?: number;
}

const DEFAULT_CONFIG: Required<StepExecutorConfig> = {
  maxIterationsPerStep: 10,
};

/**
 * Step Executor
 *
 * 按依赖顺序执行 TaskPlan 中的每个步骤。
 */
export class StepExecutor {
  private config: Required<StepExecutorConfig>;
  private logger = getLogger();

  constructor(config?: StepExecutorConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 执行整个计划（每步前重置执行状态）
   */
  async executeWithReset(plan: TaskPlan, agent: Agent, memory: WorkingMemory): Promise<PlanExecutionResult> {
    const startTime = Date.now();
    const stepResults: StepExecutionResult[] = [];

    this.logger.info(
      "StepExecutor",
      `Executing plan: ${plan.steps.length} steps, maxIterations/step=${this.config.maxIterationsPerStep}`,
    );

    while (true) {
      // 找下一个可执行的步骤（pending + 依赖都已完成）
      const nextStep = this.findNextStep(plan);
      if (!nextStep) break;

      // 关键：每步前重置执行状态，保留 Working Memory
      agent.resetForStep();

      // 设置每步的迭代上限
      agent.setMaxIterations(this.config.maxIterationsPerStep);

      // 执行步骤
      const result = await this.executeStep(nextStep, plan, agent);
      stepResults.push(result);

      // 更新步骤状态
      nextStep.status = result.status;
      nextStep.result = result.result;
      plan.updatedAt = Date.now();

      // 如果步骤失败，标记后续依赖步骤为 skipped
      if (result.status === "failed") {
        this.skipDependentSteps(plan, nextStep.id);
      }
    }

    const completedSteps = plan.steps.filter((s) => s.status === "completed").length;
    const failedSteps = plan.steps.filter((s) => s.status === "failed").length;

    const finalStatus = failedSteps === 0 ? "completed" : completedSteps === 0 ? "failed" : "partial";

    this.logger.info(
      "StepExecutor",
      `Plan finished: ${completedSteps}/${plan.steps.length} completed, ${failedSteps} failed, status=${finalStatus}`,
    );

    return {
      plan,
      stepResults,
      finalStatus,
      completedSteps,
      totalSteps: plan.steps.length,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(step: TaskStep, plan: TaskPlan, agent: Agent): Promise<StepExecutionResult> {
    const startTime = Date.now();
    step.status = "executing";

    this.logger.info("StepExecutor", `Step ${step.id}/${plan.steps.length}: ${step.description.slice(0, 60)}`);

    // 构造步骤级别的 goal
    const stepGoal = this.buildStepGoal(step, plan);

    try {
      const result = await agent.run(stepGoal);

      this.logger.info("StepExecutor", `Step ${step.id} completed: ${result.slice(0, 60)}`);

      return {
        stepId: step.id,
        status: "completed",
        result: result.slice(0, 200),
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      this.logger.warn("StepExecutor", `Step ${step.id} failed: ${errorMsg}`);

      return {
        stepId: step.id,
        status: "failed",
        result: errorMsg.slice(0, 200),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 构造步骤级别的 goal
   *
   * 第一行是简洁目标（传给 StateMachine.setGoal + WorkingMemory.setGoal），
   * 后面是详细上下文（LLM 通过 messages 看到）。
   */
  buildStepGoal(step: TaskStep, plan: TaskPlan): string {
    const lines: string[] = [];

    // 简洁目标：第一行
    lines.push(`[Step ${step.id}/${plan.steps.length}] ${step.description}`);
    lines.push("");

    // 前序已完成步骤的结果
    const completedSteps = plan.steps.filter((s) => s.status === "completed" && s.id < step.id);
    if (completedSteps.length > 0) {
      lines.push(`## Completed Steps`);
      for (const s of completedSteps) {
        lines.push(`- Step ${s.id}: ${s.description}`);
        if (s.result) {
          lines.push(`  Result: ${s.result}`);
        }
      }
      lines.push("");
    }

    lines.push(`Complete this step and provide a brief summary of what was done.`);

    return lines.join("\n");
  }

  /**
   * 找下一个可执行的步骤
   */
  private findNextStep(plan: TaskPlan): TaskStep | undefined {
    return plan.steps.find((step) => {
      if (step.status !== "pending") return false;
      return step.dependencies.every((depId) => {
        const dep = plan.steps.find((s) => s.id === depId);
        return dep?.status === "completed";
      });
    });
  }

  /**
   * 跳过依赖于失败步骤的后续步骤
   */
  private skipDependentSteps(plan: TaskPlan, failedStepId: number): void {
    const toSkip = new Set<number>();
    const queue = [failedStepId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      for (const step of plan.steps) {
        if (step.dependencies.includes(currentId) && step.status === "pending") {
          toSkip.add(step.id);
          queue.push(step.id);
        }
      }
    }

    for (const step of plan.steps) {
      if (toSkip.has(step.id)) {
        step.status = "skipped";
        this.logger.info("StepExecutor", `Step ${step.id} skipped (depends on failed step ${failedStepId})`);
      }
    }
  }
}
