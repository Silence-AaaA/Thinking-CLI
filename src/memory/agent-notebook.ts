/**
 * Agent Notebook — 运行时状态（Runtime State，不是 Summary）
 *
 * ============================================================
 * Phase 6 核心：信息生命周期第三层
 *
 * 【设计哲学】
 * Claude Code 的 Session Memory 是 "Summary" — 描述发生了什么
 * Agent Notebook 是 "Runtime State" — 描述现在是什么状态
 *
 * 【关键优势】
 * 1. 结构化数据 → 程序直接消费，不需要 LLM 解读
 * 2. Multi-Agent 可直接共享 → 其他 Agent 接手时无需翻译
 * 3. 每步自动更新字段 → 不依赖 LLM 填写模板
 *
 * 【数据模型】
 * Goal → Plan → Step → Blocked → Decision → Observation → Worklog
 * ============================================================
 */

import type { Observation, ObservationSeverity, ObservationStatus } from "../core/observation.js";
import type { ReflectionResult } from "../core/reflection.js";
import type { StateMachine, StateSnapshot } from "../core/state-machine.js";
import type { TaskPlan } from "../core/task-planner.js";
import { getLogger } from "../utils/logger.js";

// ============================================================
// 类型定义
// ============================================================

export type GoalStatus = "active" | "completed" | "failed" | "blocked";
export type StepOutcome = "success" | "failure" | "partial";

export interface GoalState {
  primary: string;
  subGoals: string[];
  status: GoalStatus;
}

export interface PlanStepSummary {
  id: number;
  description: string;
  status: "pending" | "active" | "completed" | "failed";
  result?: string;
}

export interface PlanState {
  steps: PlanStepSummary[];
  currentStepIndex: number;
  completedCount: number;
  failedCount: number;
}

export interface StepState {
  stepId: number;
  action: string;
  toolName?: string;
  startedAt: number;
}

export interface BlockedState {
  reason: string;
  since: number;
  attempts: number;
  suggestion?: string;
}

export interface Decision {
  id: string;
  decision: string;
  reason: string;
  alternatives?: string[];
  stepId: number;
  timestamp: number;
}

export interface NotebookObservation {
  stepId: number;
  summary: string;
  success: boolean;
  severity: ObservationSeverity;
  keyFindings: string[];
  timestamp: number;
}

export interface WorklogEntry {
  stepId: number;
  action: string;
  outcome: StepOutcome;
  summary: string;
  timestamp: number;
}

export interface AgentNotebookData {
  goal: GoalState;
  plan: PlanState | null;
  currentStep: StepState | null;
  blocked: BlockedState | null;
  decisions: Decision[];
  observations: NotebookObservation[];
  worklog: WorklogEntry[];
  version: number;
  updatedAt: number;
}

// ============================================================
// 配置
// ============================================================

export interface AgentNotebookConfig {
  maxObservations: number;
  maxWorklogEntries: number;
  maxDecisions: number;
}

const DEFAULT_CONFIG: AgentNotebookConfig = {
  maxObservations: 20,
  maxWorklogEntries: 50,
  maxDecisions: 30,
};

// ============================================================
// Agent Notebook Manager
// ============================================================

export class AgentNotebookManager {
  private notebook: AgentNotebookData;
  private config: AgentNotebookConfig;
  private logger = getLogger();

  constructor(config?: Partial<AgentNotebookConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.notebook = this.createEmpty();
  }

  // ============================================================
  // 公共接口
  // ============================================================

  /**
   * 设置顶层目标
   */
  setGoal(goal: string): void {
    this.notebook.goal.primary = goal;
    this.notebook.goal.status = "active";
    this.notebook.goal.subGoals = [];
    this.notebook.blocked = null;
    this.bumpVersion();
    this.logger.info("Notebook", `Goal set: ${goal.slice(0, 80)}`);
  }

  /**
   * 添加子目标
   */
  addSubGoal(subGoal: string): void {
    this.notebook.goal.subGoals.push(subGoal);
    this.bumpVersion();
  }

  /**
   * 更新规划状态
   */
  updatePlan(plan: TaskPlan): void {
    this.notebook.plan = {
      steps: plan.steps.map((s) => ({
        id: s.id,
        description: s.description,
        status: s.status as PlanStepSummary["status"],
        result: s.result,
      })),
      currentStepIndex: 0,
      completedCount: plan.steps.filter((s) => s.status === "completed").length,
      failedCount: plan.steps.filter((s) => s.status === "failed").length,
    };
    this.bumpVersion();
    this.logger.info("Notebook", `Plan updated: ${this.notebook.plan.steps.length} steps`);
  }

  /**
   * 标记当前步骤开始
   */
  beginStep(stepId: number, action: string, toolName?: string): void {
    this.notebook.currentStep = {
      stepId,
      action,
      toolName,
      startedAt: Date.now(),
    };

    // 更新 plan 中的 step 状态
    if (this.notebook.plan) {
      const step = this.notebook.plan.steps.find((s) => s.id === stepId);
      if (step) step.status = "active";
      this.notebook.plan.currentStepIndex = this.notebook.plan.steps.findIndex((s) => s.id === stepId);
    }

    // 清除 blocked 状态
    if (this.notebook.blocked) {
      this.notebook.blocked = null;
    }

    this.bumpVersion();
  }

  /**
   * 标记当前步骤完成
   */
  completeStep(stepId: number, outcome: StepOutcome, summary: string): void {
    // 更新 plan
    if (this.notebook.plan) {
      const step = this.notebook.plan.steps.find((s) => s.id === stepId);
      if (step) {
        step.status = outcome === "success" ? "completed" : outcome === "failure" ? "failed" : "active";
        step.result = summary.slice(0, 200);
      }
      this.notebook.plan.completedCount = this.notebook.plan.steps.filter((s) => s.status === "completed").length;
      this.notebook.plan.failedCount = this.notebook.plan.steps.filter((s) => s.status === "failed").length;
    }

    // 追加 worklog
    this.addWorklog(stepId, this.notebook.currentStep?.action ?? "unknown", outcome, summary);

    // 清除 currentStep
    this.notebook.currentStep = null;
    this.bumpVersion();
  }

  /**
   * 标记目标完成/失败
   */
  finishGoal(status: "completed" | "failed"): void {
    this.notebook.goal.status = status;
    this.notebook.currentStep = null;
    this.notebook.blocked = null;
    this.bumpVersion();
    this.logger.info("Notebook", `Goal ${status}: ${this.notebook.goal.primary.slice(0, 60)}`);
  }

  /**
   * 设置 blocked 状态
   */
  setBlocked(reason: string, suggestion?: string): void {
    this.notebook.blocked = {
      reason,
      since: Date.now(),
      attempts: this.notebook.blocked ? this.notebook.blocked.attempts + 1 : 1,
      suggestion,
    };
    this.notebook.goal.status = "blocked";
    this.bumpVersion();
    this.logger.info("Notebook", `Blocked: ${reason.slice(0, 80)}`);
  }

  /**
   * 记录决策
   */
  addDecision(decision: string, reason: string, alternatives?: string[]): void {
    this.notebook.decisions.push({
      id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      decision,
      reason,
      alternatives,
      stepId: this.notebook.currentStep?.stepId ?? 0,
      timestamp: Date.now(),
    });

    // 淘汰旧决策
    if (this.notebook.decisions.length > this.config.maxDecisions) {
      this.notebook.decisions = this.notebook.decisions.slice(-this.config.maxDecisions);
    }

    this.bumpVersion();
  }

  /**
   * 记录观察（从 Observation 层提取）
   */
  addObservation(obs: {
    stepId: number;
    summary: string;
    success: boolean;
    severity: ObservationSeverity;
    keyFindings: string[];
  }): void {
    this.notebook.observations.push({
      ...obs,
      timestamp: Date.now(),
    });

    if (this.notebook.observations.length > this.config.maxObservations) {
      this.notebook.observations = this.notebook.observations.slice(-this.config.maxObservations);
    }

    this.bumpVersion();
  }

  /**
   * 从反思结果更新状态
   */
  recordReflection(result: ReflectionResult): void {
    if (result.diagnosis) {
      this.setBlocked(result.diagnosis, result.newStrategy);
    }
    if (result.newStrategy) {
      this.addDecision(result.newStrategy, `Reflected: ${result.analysis ?? "strategy change"}`);
    }
  }

  /**
   * 从 StateMachine 同步状态
   */
  syncFromStateMachine(sm: StateMachine): void {
    const snap = sm.snapshot();

    // 同步 goal 状态
    switch (snap.status) {
      case "completed":
        this.notebook.goal.status = "completed";
        break;
      case "failed":
        this.notebook.goal.status = "failed";
        break;
      default:
        if (this.notebook.goal.status !== "blocked") {
          this.notebook.goal.status = "active";
        }
    }

    // 同步 goal 文本
    if (snap.currentGoal && !this.notebook.goal.primary) {
      this.notebook.goal.primary = snap.currentGoal;
    }

    this.bumpVersion();
  }

  // ============================================================
  // 输出
  // ============================================================

  /**
   * 获取当前 Notebook 数据（只读副本）
   */
  getData(): Readonly<AgentNotebookData> {
    return this.notebook;
  }

  /**
   * 序列化快照（用于 checkpoint / Multi-Agent 共享）
   */
  snapshot(): AgentNotebookData {
    return structuredClone(this.notebook);
  }

  /**
   * 从快照恢复
   */
  loadSnapshot(snap: AgentNotebookData): void {
    this.notebook = structuredClone(snap);
    this.logger.info("Notebook", `Loaded snapshot: version=${snap.version}, goal=${snap.goal.primary.slice(0, 60)}`);
  }

  /**
   * 格式化为 LLM 可读的文本
   */
  formatForLLM(): string {
    const lines: string[] = ["## Agent Runtime State"];
    const n = this.notebook;

    // Goal
    const statusIcon = {
      active: "🟢",
      completed: "✅",
      failed: "❌",
      blocked: "🚫",
    }[n.goal.status];
    lines.push(`**Goal**: ${n.goal.primary} ${statusIcon}`);
    if (n.goal.subGoals.length > 0) {
      lines.push(`  Sub-goals: ${n.goal.subGoals.join(" | ")}`);
    }

    // Plan
    if (n.plan) {
      lines.push(
        `**Plan**: ${n.plan.steps.length} steps | ` +
          `${n.plan.completedCount} completed | ${n.plan.failedCount} failed | ` +
          `current: step ${n.plan.currentStepIndex + 1}`,
      );
    }

    // Current Step
    if (n.currentStep) {
      const elapsed = Math.round((Date.now() - n.currentStep.startedAt) / 1000);
      lines.push(
        `**Current Step**: ${n.currentStep.action}${n.currentStep.toolName ? ` (${n.currentStep.toolName})` : ""} [${elapsed}s]`,
      );
    }

    // Blocked
    if (n.blocked) {
      lines.push(`**Blocked**: ${n.blocked.reason}`);
      if (n.blocked.suggestion) {
        lines.push(`  Suggestion: ${n.blocked.suggestion}`);
      }
    }

    // Decisions
    if (n.decisions.length > 0) {
      lines.push("**Decisions**:");
      for (const d of n.decisions.slice(-5)) {
        lines.push(`  - [step ${d.stepId}] ${d.decision} — ${d.reason}`);
      }
    }

    // Observations
    if (n.observations.length > 0) {
      lines.push("**Recent Observations**:");
      for (const o of n.observations.slice(-5)) {
        const icon = o.success ? "✅" : "❌";
        lines.push(`  - [step ${o.stepId}] ${icon} ${o.summary}`);
      }
    }

    // Worklog
    if (n.worklog.length > 0) {
      lines.push("**Worklog**:");
      for (const w of n.worklog.slice(-5)) {
        const icon = { success: "✅", failure: "❌", partial: "⚠️" }[w.outcome];
        lines.push(`  - step ${w.stepId}: ${w.action} → ${icon} ${w.summary}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 估算 token 数
   */
  estimateTokens(): number {
    return Math.ceil(this.formatForLLM().length / 4);
  }

  /**
   * 重置
   */
  reset(): void {
    this.notebook = this.createEmpty();
    this.logger.info("Notebook", "Reset");
  }

  // ============================================================
  // 内部方法
  // ============================================================

  private addWorklog(stepId: number, action: string, outcome: StepOutcome, summary: string): void {
    this.notebook.worklog.push({
      stepId,
      action,
      outcome,
      summary: summary.slice(0, 200),
      timestamp: Date.now(),
    });

    if (this.notebook.worklog.length > this.config.maxWorklogEntries) {
      this.notebook.worklog = this.notebook.worklog.slice(-this.config.maxWorklogEntries);
    }
  }

  private createEmpty(): AgentNotebookData {
    return {
      goal: { primary: "", subGoals: [], status: "active" },
      plan: null,
      currentStep: null,
      blocked: null,
      decisions: [],
      observations: [],
      worklog: [],
      version: 0,
      updatedAt: Date.now(),
    };
  }

  private bumpVersion(): void {
    this.notebook.version++;
    this.notebook.updatedAt = Date.now();
  }
}
