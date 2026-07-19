/**
 * History Checkpoints — 历史摘要版本化
 *
 * ============================================================
 * Phase 4.6：
 * 不再只保留一个 currentSummary。
 * 每次重大压缩时，顺手保留一个 checkpoint：
 * - step
 * - contextVersion
 * - summary
 * - compressedCount
 * - sourceRoundCount
 *
 * 这样未来可以做到：
 * - Replay 某个历史版本
 * - 对比 summary 变化
 * - 回滚到某个 checkpoint 重新解释
 *
 * Phase 4.7:
 * - 新增 diff 方法，比较两个 checkpoint 的 summary 变化
 * ============================================================
 */

export interface HistoryCheckpoint {
  id: string;
  step: number;
  contextVersion: number;
  summary: string;
  compressedCount: number;
  sourceRoundCount: number;
  createdAt: number;
}

export interface CheckpointDiff {
  id1: string;
  id2: string;
  stepDelta: number;
  contextVersionDelta: number;
  summaryDiff: string;
  summary1: string;
  summary2: string;
  timestamp: number;
}

export class HistoryCheckpointManager {
  private checkpoints: HistoryCheckpoint[] = [];
  private maxCheckpoints: number;

  constructor(maxCheckpoints = 20) {
    this.maxCheckpoints = maxCheckpoints;
  }

  addCheckpoint(input: {
    step: number;
    contextVersion: number;
    summary: string;
    compressedCount: number;
    sourceRoundCount: number;
  }): HistoryCheckpoint {
    const checkpoint: HistoryCheckpoint = {
      id: `ckpt_${input.step}_${Date.now()}`,
      step: input.step,
      contextVersion: input.contextVersion,
      summary: input.summary,
      compressedCount: input.compressedCount,
      sourceRoundCount: input.sourceRoundCount,
      createdAt: Date.now(),
    };

    this.checkpoints.push(checkpoint);
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }

    return checkpoint;
  }

  latest(): HistoryCheckpoint | undefined {
    return this.checkpoints.at(-1);
  }

  list(): HistoryCheckpoint[] {
    return [...this.checkpoints];
  }

  findByStep(step: number): HistoryCheckpoint | undefined {
    return this.checkpoints.find((c) => c.step === step);
  }

  findByContextVersion(contextVersion: number): HistoryCheckpoint | undefined {
    return this.checkpoints.find((c) => c.contextVersion === contextVersion);
  }

  reset(): void {
    this.checkpoints = [];
  }

  diff(ckpt1: HistoryCheckpoint, ckpt2: HistoryCheckpoint): CheckpointDiff {
    const summaryDiff = this.computeSummaryDiff(ckpt1.summary, ckpt2.summary);
    return {
      id1: ckpt1.id,
      id2: ckpt2.id,
      stepDelta: ckpt2.step - ckpt1.step,
      contextVersionDelta: ckpt2.contextVersion - ckpt1.contextVersion,
      summaryDiff,
      summary1: ckpt1.summary,
      summary2: ckpt2.summary,
      timestamp: Date.now(),
    };
  }

  diffWithLatest(ckpt: HistoryCheckpoint): CheckpointDiff | undefined {
    const latest = this.latest();
    if (!latest) return undefined;
    return this.diff(ckpt, latest);
  }

  private computeSummaryDiff(s1: string, s2: string): string {
    if (s1 === s2) return "No change";
    const l1 = s1.split("\n");
    const l2 = s2.split("\n");
    const changes: string[] = [];
    const maxLen = Math.max(l1.length, l2.length);
    for (let i = 0; i < maxLen; i++) {
      const line1 = l1[i] ?? "";
      const line2 = l2[i] ?? "";
      if (line1 !== line2) {
        if (line1) changes.push(`- ${line1}`);
        if (line2) changes.push(`+ ${line2}`);
      }
    }
    return changes.join("\n");
  }
}
