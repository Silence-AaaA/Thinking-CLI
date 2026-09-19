/**
 * Context Changelog — 上下文变化日志
 *
 * ============================================================
 * Phase 4.6：
 * 记录每次 assemble 发生了什么变化，方便：
 * - 比较 v12 和 v13 为什么不同
 * - 诊断“LLM 为什么突然换策略”
 * - 未来做 context diff / replay
 * ============================================================
 */

export interface ContextChangeEntry {
  contextVersion: number;
  step: number;
  memoryVersion: number;
  stateSnapshotStatus: string;
  injectedMemory: boolean;
  injectedState: boolean;
  compressedMessages: number;
  droppedForBudget: number;
  estimatedTotalTokens: number;
  changedBecause: string[];
  timestamp: number;
}

export class ContextChangelog {
  private entries: ContextChangeEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  addEntry(entry: Omit<ContextChangeEntry, "timestamp">): ContextChangeEntry {
    const full: ContextChangeEntry = { ...entry, timestamp: Date.now() };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    return full;
  }

  list(): ContextChangeEntry[] {
    return [...this.entries];
  }

  latest(): ContextChangeEntry | undefined {
    return this.entries.at(-1);
  }

  findByVersion(contextVersion: number): ContextChangeEntry | undefined {
    return this.entries.find((e) => e.contextVersion === contextVersion);
  }

  diffVersions(
    v1: number,
    v2: number,
  ): {
    from?: ContextChangeEntry;
    to?: ContextChangeEntry;
    tokenDelta?: number;
    compressedDelta?: number;
    droppedDelta?: number;
    memoryDelta?: number;
    changedBecause?: string[];
  } {
    const from = this.findByVersion(v1);
    const to = this.findByVersion(v2);
    if (!from || !to) return { from, to };

    return {
      from,
      to,
      tokenDelta: to.estimatedTotalTokens - from.estimatedTotalTokens,
      compressedDelta: to.compressedMessages - from.compressedMessages,
      droppedDelta: to.droppedForBudget - from.droppedForBudget,
      memoryDelta: to.memoryVersion - from.memoryVersion,
      changedBecause: to.changedBecause,
    };
  }

  reset(): void {
    this.entries = [];
  }
}
