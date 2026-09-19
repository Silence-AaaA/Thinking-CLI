/**
 * Reflection Engine — 反思机制
 *
 * ============================================================
 * Phase 3 核心：连续失败时停下来想一想
 *
 * 【设计哲学】
 * 人类遇到连续失败时会停下来反思："我是不是方向错了？"
 * Agent 也应该这样。
 *
 * 【触发条件】
 * 1. 同一目标连续失败 2 次 → 反思
 * 2. 总步数超过阈值但目标未完成 → 反思
 * 3. 恢复策略连续失败 → 强制反思
 *
 * 【反思输出】
 * - reflection: 对当前情况的分析
 * - diagnosis: 失败的根本原因
 * - newStrategy: 新的执行策略
 *
 * 这些信息会注入到下一轮 LLM 调用的 prompt 中，
 * 引导 LLM 换一种思路。
 * ============================================================
 */

import { getLogger } from "../utils/logger.js";
import type { ErrorType, RecoveryAction } from "./error-taxonomy.js";
import type { StateSnapshot, StepRecord } from "./state-machine.js";

/** 反思触发原因 */
export enum ReflectionTrigger {
  /** 同一目标连续失败 */
  CONSECUTIVE_FAILURES = "consecutive_failures",
  /** 步数过多 */
  TOO_MANY_STEPS = "too_many_steps",
  /** 恢复策略反复失败 */
  RECOVERY_EXHAUSTED = "recovery_exhausted",
  /** 死循环检测 */
  DOOM_LOOP = "doom_loop",
}

/** 反思结果 */
export interface ReflectionResult {
  /** 是否需要反思 */
  shouldReflect: boolean;
  /** 触发原因 */
  trigger?: ReflectionTrigger;
  /** 分析内容 */
  analysis?: string;
  /** 诊断 */
  diagnosis?: string;
  /** 新策略建议 */
  newStrategy?: string;
  /** 给 LLM 的完整反思提示 */
  promptForLLM?: string;
}

/** 反思配置 */
export interface ReflectionConfig {
  /** 连续失败阈值（默认 2） */
  consecutiveFailureThreshold: number;
  /** 步数阈值（默认 15） */
  maxStepsBeforeReflection: number;
  /** 恢复失败阈值（默认 3） */
  recoveryFailureThreshold: number;
}

const DEFAULT_CONFIG: ReflectionConfig = {
  consecutiveFailureThreshold: 2,
  maxStepsBeforeReflection: 15,
  recoveryFailureThreshold: 3,
};

/** Reflection Engine 序列化格式 */
export interface ReflectionJSON {
  consecutiveFailures: number;
  lastToolName: string;
  recoveryFailureCount: number;
}

/**
 * Reflection Engine
 *
 * 【学习要点】
 * 反思不是让 Agent "感觉" 失败了，而是用数据驱动判断。
 * 我们看：连续失败次数、总步数、恢复失败次数。
 * 触发后，生成结构化的反思 prompt 给 LLM。
 */
export class ReflectionEngine {
  private config: ReflectionConfig;
  private logger = getLogger();
  private consecutiveFailures: number = 0;
  private lastToolName: string = "";
  private recoveryFailureCount: number = 0;

  constructor(config?: Partial<ReflectionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 序列化为 JSON（用于 Runtime Snapshot） */
  toJSON(): ReflectionJSON {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastToolName: this.lastToolName,
      recoveryFailureCount: this.recoveryFailureCount,
    };
  }

  /** 从 JSON 恢复状态（用于 Runtime Snapshot restore） */
  loadJSON(data: ReflectionJSON): void {
    this.consecutiveFailures = data.consecutiveFailures;
    this.lastToolName = data.lastToolName;
    this.recoveryFailureCount = data.recoveryFailureCount;
  }

  /**
   * 检查是否需要反思
   */
  check(snapshot: StateSnapshot, lastError?: { type: ErrorType; recovery: RecoveryAction }): ReflectionResult {
    // 条件 1: 连续失败
    const consecutiveCheck = this.checkConsecutiveFailures(snapshot);
    if (consecutiveCheck.shouldReflect) return consecutiveCheck;

    // 条件 2: 步数过多
    const stepsCheck = this.checkTooManySteps(snapshot);
    if (stepsCheck.shouldReflect) return stepsCheck;

    // 条件 3: 恢复策略耗尽
    const recoveryCheck = this.checkRecoveryExhausted();
    if (recoveryCheck.shouldReflect) return recoveryCheck;

    return { shouldReflect: false };
  }

  /**
   * 记录一次工具调用的结果（成功或失败）
   */
  recordOutcome(toolName: string, success: boolean): void {
    if (success) {
      this.consecutiveFailures = 0;
      this.recoveryFailureCount = 0;
    } else {
      // 只有同一工具连续失败才累加
      if (toolName === this.lastToolName) {
        this.consecutiveFailures++;
      } else {
        this.consecutiveFailures = 1;
      }
    }
    this.lastToolName = toolName;
  }

  /**
   * 记录一次恢复失败
   */
  recordRecoveryFailure(): void {
    this.recoveryFailureCount++;
  }

  /**
   * 生成反思 prompt（注入到 LLM 消息中）
   */
  generateReflectionPrompt(snapshot: StateSnapshot, trigger: ReflectionTrigger, recentFailures: StepRecord[]): string {
    const failureSummary = recentFailures
      .slice(-5)
      .map((f) => `  - Step ${f.id}: ${f.toolName} -> ${f.errorType ?? "unknown error"}`)
      .join("\n");

    const strategy = this.inferNewStrategy(snapshot, recentFailures);

    return [
      "## REFLECTION REQUIRED",
      "",
      "You have been failing repeatedly. Stop and think before continuing.",
      "",
      `**Trigger**: ${trigger}`,
      `**Current goal**: ${snapshot.currentGoal}`,
      `**Total steps**: ${snapshot.totalSteps}`,
      `**Failed steps**: ${snapshot.failedSteps.length}`,
      `**Consecutive failures**: ${this.consecutiveFailures}`,
      "",
      "**Recent failures**:",
      failureSummary || "  (none)",
      "",
      "**You MUST respond with a reflection in this format**:",
      "",
      "```",
      "REFLECTION:",
      "  Analysis: <what went wrong and why>",
      "  Diagnosis: <root cause>",
      "  New Strategy: <what you will do differently>",
      "```",
      "",
      `**Suggested direction**: ${strategy}`,
      "",
      "After your reflection, execute the new strategy. Do NOT retry the same approach that failed.",
    ].join("\n");
  }

  /** 重置 */
  reset(): void {
    this.consecutiveFailures = 0;
    this.lastToolName = "";
    this.recoveryFailureCount = 0;
  }

  // ---- 内部方法 ----

  private checkConsecutiveFailures(snapshot: StateSnapshot): ReflectionResult {
    if (this.consecutiveFailures >= this.config.consecutiveFailureThreshold) {
      return {
        shouldReflect: true,
        trigger: ReflectionTrigger.CONSECUTIVE_FAILURES,
        analysis: `Tool "${this.lastToolName}" failed ${this.consecutiveFailures} times in a row`,
        diagnosis: this.diagnoseConsecutiveFailure(snapshot),
        newStrategy: this.inferNewStrategy(snapshot, snapshot.failedSteps),
        promptForLLM: this.generateReflectionPrompt(
          snapshot,
          ReflectionTrigger.CONSECUTIVE_FAILURES,
          snapshot.failedSteps,
        ),
      };
    }
    return { shouldReflect: false };
  }

  private checkTooManySteps(snapshot: StateSnapshot): ReflectionResult {
    if (snapshot.totalSteps >= this.config.maxStepsBeforeReflection && snapshot.status !== "completed") {
      return {
        shouldReflect: true,
        trigger: ReflectionTrigger.TOO_MANY_STEPS,
        analysis: `${snapshot.totalSteps} steps taken but goal not completed`,
        diagnosis: "The approach may be too broad or inefficient",
        newStrategy: "Focus on the core requirement and avoid unnecessary exploration",
        promptForLLM: this.generateReflectionPrompt(snapshot, ReflectionTrigger.TOO_MANY_STEPS, snapshot.failedSteps),
      };
    }
    return { shouldReflect: false };
  }

  private checkRecoveryExhausted(): ReflectionResult {
    if (this.recoveryFailureCount >= this.config.recoveryFailureThreshold) {
      return {
        shouldReflect: true,
        trigger: ReflectionTrigger.RECOVERY_EXHAUSTED,
        analysis: `Recovery strategies failed ${this.recoveryFailureCount} times`,
        diagnosis: "The current recovery approach is not working",
        newStrategy: "Try a fundamentally different approach or ask the user for help",
        promptForLLM: "",
      };
    }
    return { shouldReflect: false };
  }

  private diagnoseConsecutiveFailure(snapshot: StateSnapshot): string {
    const recentFailed = snapshot.failedSteps.slice(-3);
    const allSameTool = recentFailed.every((s) => s.toolName === recentFailed[0]?.toolName);
    const allSameError = recentFailed.every((s) => s.errorType === recentFailed[0]?.errorType);

    if (allSameTool && allSameError) {
      return `Repeated "${recentFailed[0].errorType}" on "${recentFailed[0].toolName}" — same approach each time`;
    }
    if (allSameTool) {
      return `Tool "${recentFailed[0].toolName}" keeps failing with different errors — the tool may not be suitable`;
    }
    return "Multiple tools failing — the goal may require a different approach";
  }

  private inferNewStrategy(snapshot: StateSnapshot, failures: StepRecord[]): string {
    if (failures.length === 0) return "Continue with current approach";

    const lastFailure = failures[failures.length - 1];
    const errorType = lastFailure.errorType ?? "";

    if (errorType.includes("file_not_found") || errorType.includes("enoent")) {
      return "Try listing the directory first to find the correct file path, or use grep to search";
    }
    if (errorType.includes("permission")) {
      return "Ask the user for help with permissions, or try a different file/directory";
    }
    if (errorType.includes("timeout")) {
      return "Reduce the scope of the operation — read fewer lines, search in specific directories";
    }
    if (snapshot.failedSteps.length > snapshot.completedSteps.length) {
      return "Step back and reconsider the approach. Perhaps break the task into smaller pieces";
    }
    return "Try a different tool or approach for this step";
  }
}
