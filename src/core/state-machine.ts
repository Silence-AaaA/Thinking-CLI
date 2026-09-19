/**
 * State Machine — 运行时状态管理
 *
 * ============================================================
 * Phase 3 核心：Agent 的运行时状态不进 Prompt
 *
 * 【设计哲学】
 * Agent 在执行过程中需要追踪"做了什么、做到哪了、还有多少预算"。
 * 这些信息不应该塞进 LLM 的对话历史（太浪费 token），
 * 而是用一个独立的状态机来管理。
 *
 * 【状态模型】
 * - planning: 任务刚开始，还在分解
 * - executing: 正在执行步骤
 * - reflecting: 连续失败，停下来想一想
 * - recovering: 正在执行恢复策略
 * - completed: 任务完成
 * - failed: 任务彻底失败
 *
 * Phase 4.7:
 * - 新增 loadSnapshot 方法，支持从快照恢复状态
 * ============================================================
 */

import { getLogger } from "../utils/logger.js";

/** 执行状态 */
export enum ExecutionStatus {
  PLANNING = "planning",
  EXECUTING = "executing",
  REFLECTING = "reflecting",
  RECOVERING = "recovering",
  COMPLETED = "completed",
  FAILED = "failed",
}

/** 一个执行步骤的记录 */
export interface StepRecord {
  id: number;
  toolName: string;
  arguments: Record<string, unknown>;
  success: boolean;
  errorType?: string;
  timestamp: number;
  durationMs: number;
}

/** 反思记录 */
export interface ReflectionRecord {
  stepId: number;
  trigger: string;
  diagnosis: string;
  newStrategy: string;
  timestamp: number;
}

/** 状态机快照（只读，供外部查看） */
export interface StateSnapshot {
  status: ExecutionStatus;
  currentGoal: string;
  completedSteps: StepRecord[];
  failedSteps: StepRecord[];
  retryCount: number;
  totalSteps: number;
  reflections: ReflectionRecord[];
  activeFiles: string[];
  budgetUsed: { tokens: number; toolCalls: number };
}

/**
 * Agent 状态机
 *
 * 【学习要点】
 * 状态机是管理复杂行为的经典模式。
 * 每个状态有明确的进入条件和退出条件。
 * 状态转换是受控的 — 不允许非法跳转。
 */
export class StateMachine {
  private _status: ExecutionStatus = ExecutionStatus.PLANNING;
  private _currentGoal: string = "";
  private _completedSteps: StepRecord[] = [];
  private _failedSteps: StepRecord[] = [];
  private _retryCount: number = 0;
  private _stepCounter: number = 0;
  private _reflections: ReflectionRecord[] = [];
  private _activeFiles: Set<string> = new Set();
  private _budgetUsed = { tokens: 0, toolCalls: 0 };
  private logger = getLogger();

  // 合法的状态转换表
  private static TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
    [ExecutionStatus.PLANNING]: [ExecutionStatus.EXECUTING, ExecutionStatus.FAILED],
    [ExecutionStatus.EXECUTING]: [
      ExecutionStatus.REFLECTING,
      ExecutionStatus.RECOVERING,
      ExecutionStatus.COMPLETED,
      ExecutionStatus.FAILED,
    ],
    [ExecutionStatus.REFLECTING]: [ExecutionStatus.EXECUTING, ExecutionStatus.RECOVERING, ExecutionStatus.FAILED],
    [ExecutionStatus.RECOVERING]: [ExecutionStatus.EXECUTING, ExecutionStatus.REFLECTING, ExecutionStatus.FAILED],
    [ExecutionStatus.COMPLETED]: [],
    [ExecutionStatus.FAILED]: [],
  };

  /** 设置当前目标 */
  setGoal(goal: string): void {
    this._currentGoal = goal;
    this.logger.info("StateMachine", `Goal set: ${goal}`);
  }

  /** 获取当前状态 */
  get status(): ExecutionStatus {
    return this._status;
  }

  /** 获取当前目标 */
  get currentGoal(): string {
    return this._currentGoal;
  }

  /** 状态转换（带校验） */
  transition(newStatus: ExecutionStatus): boolean {
    const allowed = StateMachine.TRANSITIONS[this._status];
    if (!allowed.includes(newStatus)) {
      this.logger.warn(
        "StateMachine",
        `Illegal transition: ${this._status} -> ${newStatus}. Allowed: [${allowed.join(", ")}]`,
      );
      return false;
    }
    this.logger.info("StateMachine", `Transition: ${this._status} -> ${newStatus}`);
    this._status = newStatus;
    return true;
  }

  /** 记录一个成功的步骤 */
  recordStep(record: Omit<StepRecord, "id" | "timestamp">): StepRecord {
    const step: StepRecord = {
      ...record,
      id: ++this._stepCounter,
      timestamp: Date.now(),
    };
    this._completedSteps.push(step);
    this._budgetUsed.toolCalls++;

    // 如果跟踪到文件路径，记录到 activeFiles
    const path = record.arguments.path as string | undefined;
    if (path) this._activeFiles.add(path);

    this.logger.info("StateMachine", `Step ${step.id}: ${step.toolName} -> ${step.success ? "OK" : "FAIL"}`);
    return step;
  }

  /** 记录一个失败的步骤 */
  recordFailure(record: Omit<StepRecord, "id" | "timestamp">): StepRecord {
    const step: StepRecord = {
      ...record,
      id: ++this._stepCounter,
      timestamp: Date.now(),
    };
    this._failedSteps.push(step);
    this._budgetUsed.toolCalls++;
    this.logger.info("StateMachine", `Step ${step.id} FAILED: ${step.toolName} (${step.errorType ?? "unknown"})`);
    return step;
  }

  /** 增加重试计数 */
  incrementRetry(): number {
    return ++this._retryCount;
  }

  /** 重置重试计数 */
  resetRetry(): void {
    this._retryCount = 0;
  }

  /** 记录 token 消耗 */
  addTokens(tokens: number): void {
    this._budgetUsed.tokens += tokens;
  }

  /** 记录一次反思 */
  addReflection(record: Omit<ReflectionRecord, "timestamp">): void {
    const entry: ReflectionRecord = { ...record, timestamp: Date.now() };
    this._reflections.push(entry);
    this.logger.info("StateMachine", `Reflection: ${entry.trigger} -> ${entry.newStrategy}`);
  }

  /** 获取快照（只读） */
  snapshot(): StateSnapshot {
    return {
      status: this._status,
      currentGoal: this._currentGoal,
      completedSteps: [...this._completedSteps],
      failedSteps: [...this._failedSteps],
      retryCount: this._retryCount,
      totalSteps: this._stepCounter,
      reflections: [...this._reflections],
      activeFiles: [...this._activeFiles],
      budgetUsed: { ...this._budgetUsed },
    };
  }

  /** 从快照恢复状态（用于 checkpoint/resume） */
  loadSnapshot(snap: StateSnapshot): void {
    this._status = snap.status;
    this._currentGoal = snap.currentGoal;
    this._completedSteps = snap.completedSteps.map((s) => ({ ...s }));
    this._failedSteps = snap.failedSteps.map((s) => ({ ...s }));
    this._retryCount = snap.retryCount;
    this._stepCounter = snap.totalSteps;
    this._reflections = snap.reflections.map((r) => ({ ...r }));
    this._activeFiles = new Set(snap.activeFiles);
    this._budgetUsed = { ...snap.budgetUsed };
    this.logger.info("StateMachine", `Loaded snapshot: ${snap.status}, step=${snap.totalSteps}`);
  }

  /** 重置（新一轮对话） */
  reset(): void {
    this._status = ExecutionStatus.PLANNING;
    this._currentGoal = "";
    this._completedSteps = [];
    this._failedSteps = [];
    this._retryCount = 0;
    this._stepCounter = 0;
    this._reflections = [];
    this._activeFiles.clear();
    this._budgetUsed = { tokens: 0, toolCalls: 0 };
    this.logger.info("StateMachine", "Reset");
  }
}
