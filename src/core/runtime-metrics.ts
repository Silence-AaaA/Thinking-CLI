/**
 * Runtime Metrics — 运行时度量采集
 *
 * ============================================================
 * Phase 4.6：
 * 每次 Agent.run() 采集一份 run-level metrics，方便：
 * - 对比不同策略效果
 * - 看哪类错误最贵
 * - 看 compression / context droppings 发生了多少次
 * ============================================================
 */

export interface RunMetricsSnapshot {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;

  goal: string;
  finalStatus: string;

  loops: number;
  toolCalls: number;
  retries: number;
  reflections: number;

  compressions: number;
  contextDroppedMessages: number;
  contextVersions: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;

  workingMemoryVersionStart: number;
  workingMemoryVersionEnd: number;
  stateMachineVersionLike_totalSteps: number;

  failureCategories: Record<string, number>;
  toolUsage: Record<string, number>;
  warnings: string[];
}

export class RuntimeMetrics {
  private snapshot: RunMetricsSnapshot;

  constructor(goal: string, initialMemoryVersion: number) {
    this.snapshot = {
      runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      startedAt: Date.now(),
      goal,
      finalStatus: "running",

      loops: 0,
      toolCalls: 0,
      retries: 0,
      reflections: 0,

      compressions: 0,
      contextDroppedMessages: 0,
      contextVersions: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,

      workingMemoryVersionStart: initialMemoryVersion,
      workingMemoryVersionEnd: initialMemoryVersion,
      stateMachineVersionLike_totalSteps: 0,

      failureCategories: {},
      toolUsage: {},
      warnings: [],
    };
  }

  markLoop(): void {
    this.snapshot.loops++;
  }

  recordToolCall(toolName: string): void {
    this.snapshot.toolCalls++;
    this.snapshot.toolUsage[toolName] = (this.snapshot.toolUsage[toolName] ?? 0) + 1;
  }

  recordFailureCategory(category: string): void {
    if (!category) return;
    this.snapshot.failureCategories[category] = (this.snapshot.failureCategories[category] ?? 0) + 1;
  }

  recordRetry(): void {
    this.snapshot.retries++;
  }

  recordReflection(): void {
    this.snapshot.reflections++;
  }

  recordContextReport(input: {
    compressedMessages?: number;
    droppedForBudget?: number;
    contextVersion?: number;
  }): void {
    if (input.compressedMessages && input.compressedMessages > 0) {
      this.snapshot.compressions += input.compressedMessages;
    }
    if (input.droppedForBudget && input.droppedForBudget > 0) {
      this.snapshot.contextDroppedMessages += input.droppedForBudget;
    }
    if (input.contextVersion && input.contextVersion > 0) {
      this.snapshot.contextVersions = input.contextVersion;
    }
  }

  recordUsage(promptTokens: number, completionTokens: number, totalTokens: number): void {
    this.snapshot.promptTokens += promptTokens;
    this.snapshot.completionTokens += completionTokens;
    this.snapshot.totalTokens += totalTokens;
  }

  setTotalSteps(totalSteps: number): void {
    this.snapshot.stateMachineVersionLike_totalSteps = totalSteps;
  }

  setWorkingMemoryVersion(version: number): void {
    this.snapshot.workingMemoryVersionEnd = version;
  }

  setFinalStatus(status: string): void {
    this.snapshot.finalStatus = status;
  }

  addWarning(warning: string): void {
    this.snapshot.warnings.push(warning);
  }

  finish(finalStatus?: string): RunMetricsSnapshot {
    if (finalStatus) this.snapshot.finalStatus = finalStatus;
    this.snapshot.finishedAt = Date.now();
    this.snapshot.durationMs = this.snapshot.finishedAt - this.snapshot.startedAt;
    return this.snapshot;
  }

  currentSnapshot(): RunMetricsSnapshot {
    return { ...this.snapshot };
  }
}
