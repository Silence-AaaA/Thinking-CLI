/**
 * Context Assembler v3 — 可解释 + 可回放 + 可追溯
 *
 * ============================================================
 * Phase 4.6 升级：
 * 1. 保留 v2 的 AssembleReport
 * 2. 新增 history checkpoint（重大压缩时保存摘要快照）
 * 3. 新增 context changelog（记录每次版本变化原因）
 * ============================================================
 */

import type { Message } from "../llm/types.js";
import { getLogger } from "../utils/logger.js";
import { type ContextChangeEntry, ContextChangelog } from "./context-changelog.js";
import { type HistoryCheckpoint, HistoryCheckpointManager } from "./history-checkpoints.js";
import { HistoryCompressor } from "./history-compressor.js";
import type { StateMachine } from "./state-machine.js";
import type { WorkingMemory } from "./working-memory.js";

export interface ContextAssemblerConfig {
  recentRounds: number;
  minRoundsToCompress: number;
  injectWorkingMemory: boolean;
  injectStateSnapshot: boolean;
  contextWindowTokens: number;
  reserveForResponse: number;
  maxHistoryCheckpoints?: number;
  maxContextChangelog?: number;
}

const DEFAULT_CONFIG: ContextAssemblerConfig = {
  recentRounds: 5,
  minRoundsToCompress: 8,
  injectWorkingMemory: true,
  injectStateSnapshot: true,
  contextWindowTokens: 128000,
  reserveForResponse: 4000,
  maxHistoryCheckpoints: 20,
  maxContextChangelog: 100,
};

export interface AssembleReportSection {
  name: string;
  messageCount: number;
  estimatedTokens: number;
  note?: string;
}

export interface AssembleReport {
  contextVersion: number;
  step: number;
  memoryVersion: number;
  totalMessages: number;
  estimatedTotalTokens: number;
  compressedMessages: number;
  droppedForBudget: number;
  injectedMemory: boolean;
  injectedState: boolean;
  maxAllowedTokens: number;
  sections: AssembleReportSection[];
  warnings: string[];
  changedBecause: string[];
  checkpointCreated: boolean;
}

export interface AssembledContext {
  messages: Message[];
  report: AssembleReport;
  checkpoint?: HistoryCheckpoint;
  changelogEntry?: ContextChangeEntry;
}

export class ContextAssembler {
  private config: ContextAssemblerConfig;
  private compressor: HistoryCompressor;
  private checkpoints = new HistoryCheckpointManager(DEFAULT_CONFIG.maxHistoryCheckpoints);
  private changelog = new ContextChangelog(DEFAULT_CONFIG.maxContextChangelog);
  private contextVersion = 0;
  private lastMemoryVersion = -1;
  private lastInjectedMemory = false;
  private lastInjectedState = false;
  private lastCompressedMessages = 0;
  private lastDroppedForBudget = 0;
  private logger = getLogger();

  constructor(config?: Partial<ContextAssemblerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compressor = new HistoryCompressor({
      recentRounds: this.config.recentRounds,
      minRoundsToCompress: this.config.minRoundsToCompress,
    });
    this.checkpoints = new HistoryCheckpointManager(
      this.config.maxHistoryCheckpoints ?? DEFAULT_CONFIG.maxHistoryCheckpoints,
    );
    this.changelog = new ContextChangelog(this.config.maxContextChangelog ?? DEFAULT_CONFIG.maxContextChangelog);
  }

  get currentContextVersion(): number {
    return this.contextVersion;
  }

  getCheckpointManager(): HistoryCheckpointManager {
    return this.checkpoints;
  }

  getContextChangelog(): ContextChangelog {
    return this.changelog;
  }

  assemble(
    rawMessages: Message[],
    workingMemory: WorkingMemory,
    stateMachine: StateMachine,
    step?: number,
  ): AssembledContext {
    const changedBecause: string[] = [];
    const sections: AssembleReportSection[] = [];
    const warnings: string[] = [];
    const parts: Message[] = [];
    let compressedCount = 0;
    let droppedForBudget = 0;
    let checkpointCreated = false;
    let checkpoint: HistoryCheckpoint | undefined;

    const systemMsgs = rawMessages.filter((m) => m.role === "system");
    const nonSystemMsgs = rawMessages.filter((m) => m.role !== "system");

    parts.push(...systemMsgs);
    sections.push({
      name: "system",
      messageCount: systemMsgs.length,
      estimatedTokens: this.estimateTokens(systemMsgs),
      note: "fixed system prompt",
    });

    let injectedMemory = false;
    if (this.config.injectWorkingMemory) {
      const wmText = workingMemory.formatForLLM();
      const wmTokens = Math.ceil(wmText.length / 4);
      if (wmText.length > 50) {
        parts.push({ role: "user", content: wmText });
        parts.push({ role: "assistant", content: "Working memory noted. Continuing with task." });
        injectedMemory = true;
        sections.push({
          name: "working_memory",
          messageCount: 2,
          estimatedTokens: wmTokens,
          note: `memory version=${workingMemory.version}`,
        });
      } else {
        sections.push({
          name: "working_memory",
          messageCount: 0,
          estimatedTokens: 0,
          note: "skipped: wm content too small",
        });
      }
    }

    let injectedState = false;
    if (this.config.injectStateSnapshot) {
      const snapshot = stateMachine.snapshot();
      const snapshotText = this.formatStateSnapshot(snapshot);
      const ssTokens = Math.ceil(snapshotText.length / 4);
      if (snapshotText.length > 30) {
        parts.push({ role: "user", content: snapshotText });
        parts.push({ role: "assistant", content: "State snapshot acknowledged." });
        injectedState = true;
        sections.push({
          name: "state_snapshot",
          messageCount: 2,
          estimatedTokens: ssTokens,
          note: `status=${snapshot.status}, steps=${snapshot.totalSteps}`,
        });
      } else {
        sections.push({
          name: "state_snapshot",
          messageCount: 0,
          estimatedTokens: 0,
          note: "skipped: snapshot content too small",
        });
      }
    }

    if (this.compressor.shouldCompress(rawMessages)) {
      const compressed = this.compressor.compress(rawMessages);
      const nonSystemRecent = compressed.recentMessages.filter((m) => m.role !== "system");
      parts.push(...nonSystemRecent);
      compressedCount = compressed.compressedCount;
      sections.push({
        name: "history",
        messageCount: nonSystemRecent.length,
        estimatedTokens: this.estimateTokens(nonSystemRecent),
        note: `compressed older messages; recent kept intact`,
      });

      if (compressed.summary) {
        const estimatedRounds = Math.floor(nonSystemMsgs.length / 4);
        checkpoint = this.checkpoints.addCheckpoint({
          step: step ?? 0,
          contextVersion: this.contextVersion + 1,
          summary: compressed.summary,
          compressedCount: compressed.compressedCount,
          sourceRoundCount: estimatedRounds,
        });
        checkpointCreated = true;
      }

      this.logger.info("ContextAssembler", `History compressed: ${compressedCount} messages`);
    } else {
      parts.push(...nonSystemMsgs);
      sections.push({
        name: "history",
        messageCount: nonSystemMsgs.length,
        estimatedTokens: this.estimateTokens(nonSystemMsgs),
        note: "no compression needed",
      });
    }

    const estimatedBefore = this.estimateTokens(parts);
    const maxAllowed = this.config.contextWindowTokens - this.config.reserveForResponse;

    if (estimatedBefore > maxAllowed) {
      warnings.push(`context exceeded before truncation: ${estimatedBefore} > ${maxAllowed}`);
      droppedForBudget = this.truncateToFit(parts, maxAllowed);
      warnings.push(`dropped ${droppedForBudget} messages to fit budget`);
    }

    const memoryVersion = workingMemory.version;
    if (memoryVersion !== this.lastMemoryVersion)
      changedBecause.push(`memory_version_changed:${this.lastMemoryVersion}->${memoryVersion}`);
    if (injectedMemory !== this.lastInjectedMemory)
      changedBecause.push(`injected_memory:${this.lastInjectedMemory}->${injectedMemory}`);
    if (injectedState !== this.lastInjectedState)
      changedBecause.push(`injected_state:${this.lastInjectedState}->${injectedState}`);
    if (compressedCount !== this.lastCompressedMessages)
      changedBecause.push(`compressed_messages:${this.lastCompressedMessages}->${compressedCount}`);
    if (droppedForBudget !== this.lastDroppedForBudget)
      changedBecause.push(`dropped_for_budget:${this.lastDroppedForBudget}->${droppedForBudget}`);
    if (changedBecause.length === 0 && this.contextVersion === 0) {
      changedBecause.push("initial_assembly");
    } else if (changedBecause.length === 0) {
      changedBecause.push("no_major_change");
    }

    this.contextVersion++;
    const finalTokens = this.estimateTokens(parts);

    const changelogEntry = this.changelog.addEntry({
      contextVersion: this.contextVersion,
      step: step ?? 0,
      memoryVersion,
      stateSnapshotStatus: stateMachine.snapshot().status,
      injectedMemory,
      injectedState,
      compressedMessages: compressedCount,
      droppedForBudget,
      estimatedTotalTokens: finalTokens,
      changedBecause,
    });

    this.lastMemoryVersion = memoryVersion;
    this.lastInjectedMemory = injectedMemory;
    this.lastInjectedState = injectedState;
    this.lastCompressedMessages = compressedCount;
    this.lastDroppedForBudget = droppedForBudget;

    return {
      messages: parts,
      report: {
        contextVersion: this.contextVersion,
        step: step ?? 0,
        memoryVersion,
        totalMessages: parts.length,
        estimatedTotalTokens: finalTokens,
        compressedMessages: compressedCount,
        droppedForBudget,
        injectedMemory,
        injectedState,
        maxAllowedTokens: maxAllowed,
        sections,
        warnings,
        changedBecause,
        checkpointCreated,
      },
      checkpoint,
      changelogEntry,
    };
  }

  private formatStateSnapshot(snapshot: ReturnType<StateMachine["snapshot"]>): string {
    const lines: string[] = ["## Execution State"];

    lines.push(`Status: ${snapshot.status}`);
    lines.push(
      `Steps: ${snapshot.totalSteps} (completed: ${snapshot.completedSteps.length}, failed: ${snapshot.failedSteps.length})`,
    );

    if (snapshot.retryCount > 0) {
      lines.push(`Retries: ${snapshot.retryCount}`);
    }

    if (snapshot.reflections.length > 0) {
      lines.push(
        `Reflections: ${snapshot.reflections.length} (last: ${snapshot.reflections[snapshot.reflections.length - 1].newStrategy})`,
      );
    }

    if (snapshot.failedSteps.length > 0) {
      const recent = snapshot.failedSteps.slice(-2);
      lines.push("Recent failures:");
      recent.forEach((f) => {
        lines.push(`  - ${f.toolName}: ${f.errorType ?? "unknown"}`);
      });
    }

    return lines.join("\n");
  }

  private estimateTokens(messages: Message[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += (msg.content ?? "").length;
      if ("tool_calls" in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalChars += JSON.stringify(tc).length;
        }
      }
    }
    return Math.ceil(totalChars / 4);
  }

  private truncateToFit(messages: Message[], maxTokens: number): number {
    let dropped = 0;

    while (this.estimateTokens(messages) > maxTokens && messages.length > 4) {
      const idx = messages.findIndex((m, i) => i >= 2 && m.role !== "system");
      if (idx >= 0 && idx < messages.length - 2) {
        messages.splice(idx, 1);
        dropped++;
      } else {
        break;
      }
    }

    return dropped;
  }
}
