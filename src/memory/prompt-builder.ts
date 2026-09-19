/**
 * Prompt Builder — 从 ContextAssembler 重构
 *
 * ============================================================
 * Phase 6 核心：信息生命周期第五层
 *
 * 【设计哲学】
 * ContextAssembler 同时承担了"组装上下文"和"构建 prompt"两个职责
 * Prompt Builder 拆分出"构建 prompt"这个职责，按 Agent 类型差异化
 *
 * 【输入】
 * - Instruction Layer → system prompt
 * - Agent Notebook → 运行时状态
 * - Knowledge Retrieval → 相关知识
 * - History → 压缩摘要 + 最近对话
 *
 * 【输出】
 * - 最终 Message[] 送给 LLM
 * - AssembleReport（保留 ContextAssembler 的可解释性）
 * ============================================================
 */

import type { ContextChangeEntry } from "../core/context-changelog.js";
import { ContextChangelog } from "../core/context-changelog.js";
import type { HistoryCheckpoint } from "../core/history-checkpoints.js";
import { HistoryCheckpointManager } from "../core/history-checkpoints.js";
import { HistoryCompressor } from "../core/history-compressor.js";
import type { StateMachine } from "../core/state-machine.js";
import type { Message } from "../llm/types.js";
import type { AgentNotebookData } from "./agent-notebook.js";
import type { InstructionContext } from "./instruction-layer.js";
import type { RetrievalResult } from "./retrieval-engine.js";

// ============================================================
// 类型定义
// ============================================================

export type AgentType = "coding" | "research" | "general";

export interface PromptBuilderConfig {
  agentType: AgentType;
  contextWindowTokens: number;
  reserveForResponse: number;
  recentRounds: number;
  minRoundsToCompress: number;
  maxHistoryCheckpoints?: number;
  maxContextChangelog?: number;
}

const DEFAULT_CONFIG: PromptBuilderConfig = {
  agentType: "coding",
  contextWindowTokens: 128000,
  reserveForResponse: 4000,
  recentRounds: 5,
  minRoundsToCompress: 8,
  maxHistoryCheckpoints: 20,
  maxContextChangelog: 100,
};

export interface PromptComponents {
  instruction: InstructionContext;
  notebook: AgentNotebookData;
  knowledge: RetrievalResult;
  state: StateMachine;
  rawMessages: Message[];
}

export interface AssembleReportSection {
  name: string;
  messageCount: number;
  estimatedTokens: number;
  note?: string;
}

export interface AssembleReport {
  contextVersion: number;
  step: number;
  agentType: AgentType;
  totalMessages: number;
  estimatedTotalTokens: number;
  compressedMessages: number;
  droppedForBudget: number;
  maxAllowedTokens: number;
  sections: AssembleReportSection[];
  warnings: string[];
  changedBecause: string[];
  checkpointCreated: boolean;
  retrievalStrategy: string;
  retrievalCount: number;
}

export interface AssembledPrompt {
  messages: Message[];
  report: AssembleReport;
  checkpoint?: HistoryCheckpoint;
  changelogEntry?: ContextChangeEntry;
}

// ============================================================
// Agent 类型附加指令
// ============================================================

const CODING_ADDENDUM = `
## Coding Agent Context
- Use \`git_diff\` to understand current changes before committing
- Prefer specific file paths over broad searches
- Run tests after modifications
- Check for TypeScript errors before declaring done`;

const RESEARCH_ADDENDUM = `
## Research Agent Context
- Cite sources when presenting facts
- Prefer breadth before depth — scan multiple sources first
- Distinguish between verified facts and inferences
- Summarize findings in structured format`;

// ============================================================
// Prompt Builder
// ============================================================

export class PromptBuilder {
  private config: PromptBuilderConfig;
  private compressor: HistoryCompressor;
  private checkpoints: HistoryCheckpointManager;
  private changelog: ContextChangelog;
  private contextVersion = 0;
  private lastInjectedNotebook = false;
  private lastInjectedKnowledge = false;
  private lastCompressedMessages = 0;
  private lastDroppedForBudget = 0;

  constructor(config?: Partial<PromptBuilderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compressor = new HistoryCompressor({
      recentRounds: this.config.recentRounds,
      minRoundsToCompress: this.config.minRoundsToCompress,
    });
    this.checkpoints = new HistoryCheckpointManager(
      this.config.maxHistoryCheckpoints ?? DEFAULT_CONFIG.maxHistoryCheckpoints!,
    );
    this.changelog = new ContextChangelog(this.config.maxContextChangelog ?? DEFAULT_CONFIG.maxContextChangelog!);
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

  /**
   * 构建最终 prompt
   */
  build(components: PromptComponents, step?: number): AssembledPrompt {
    const changedBecause: string[] = [];
    const sections: AssembleReportSection[] = [];
    const warnings: string[] = [];
    const parts: Message[] = [];
    let compressedCount = 0;
    let droppedForBudget = 0;
    let checkpointCreated = false;
    let checkpoint: HistoryCheckpoint | undefined;

    // === 1. System Prompt ===
    const systemContent = this.buildSystemPrompt(components);
    parts.push({ role: "system", content: systemContent });
    sections.push({
      name: "system",
      messageCount: 1,
      estimatedTokens: this.estimateTokens([{ role: "system", content: systemContent }]),
      note: `instruction sources: ${components.instruction.sources.length}, agentType: ${this.config.agentType}`,
    });

    // === 2. Agent Notebook (Runtime State) ===
    let injectedNotebook = false;
    const notebookText = this.formatNotebook(components.notebook);
    if (notebookText.length > 50) {
      parts.push({ role: "user", content: notebookText });
      parts.push({ role: "assistant", content: "Runtime state noted. Continuing with task." });
      injectedNotebook = true;
      sections.push({
        name: "notebook",
        messageCount: 2,
        estimatedTokens: Math.ceil(notebookText.length / 4),
        note: `version=${components.notebook.version}, goal=${components.notebook.goal.status}`,
      });
    } else {
      sections.push({
        name: "notebook",
        messageCount: 0,
        estimatedTokens: 0,
        note: "skipped: notebook too small",
      });
    }

    // === 3. Retrieved Knowledge ===
    let injectedKnowledge = false;
    if (components.knowledge.entries.length > 0) {
      const knowledgeText = this.formatKnowledge(components.knowledge);
      parts.push({ role: "user", content: knowledgeText });
      parts.push({ role: "assistant", content: "Knowledge context noted." });
      injectedKnowledge = true;
      sections.push({
        name: "knowledge",
        messageCount: 2,
        estimatedTokens: Math.ceil(knowledgeText.length / 4),
        note: `strategy=${components.knowledge.strategy}, entries=${components.knowledge.entries.length}`,
      });
    } else {
      sections.push({
        name: "knowledge",
        messageCount: 0,
        estimatedTokens: 0,
        note: "no relevant knowledge found",
      });
    }

    // === 4. State Snapshot ===
    const stateText = this.formatStateSnapshot(components.state.snapshot());
    parts.push({ role: "user", content: stateText });
    parts.push({ role: "assistant", content: "State noted." });
    sections.push({
      name: "state",
      messageCount: 2,
      estimatedTokens: Math.ceil(stateText.length / 4),
      note: `status=${components.state.snapshot().status}`,
    });

    // === 5. History (压缩 + 最近) ===
    const nonSystemMsgs = components.rawMessages.filter((m) => m.role !== "system");

    if (this.compressor.shouldCompress(nonSystemMsgs)) {
      const compressed = this.compressor.compress(nonSystemMsgs);
      parts.push(...compressed.recentMessages);
      compressedCount = compressed.compressedCount;

      // 创建 checkpoint
      if (step !== undefined && compressed.compressedCount > 0) {
        checkpoint = this.checkpoints.addCheckpoint({
          step,
          contextVersion: this.contextVersion + 1,
          summary: compressed.summary,
          compressedCount: compressed.compressedCount,
          sourceRoundCount: Math.floor(nonSystemMsgs.length / 4),
        });
        checkpointCreated = true;
      }

      sections.push({
        name: "history",
        messageCount: compressed.recentMessages.length,
        estimatedTokens: this.estimateTokens(compressed.recentMessages),
        note: `compressed ${compressedCount} messages`,
      });
    } else {
      parts.push(...nonSystemMsgs);
      sections.push({
        name: "history",
        messageCount: nonSystemMsgs.length,
        estimatedTokens: this.estimateTokens(nonSystemMsgs),
        note: "no compression needed",
      });
    }

    // === 6. Token 预算保护 ===
    const estimatedBefore = this.estimateTokens(parts);
    const maxAllowed = this.config.contextWindowTokens - this.config.reserveForResponse;

    if (estimatedBefore > maxAllowed) {
      warnings.push(`context exceeded: ${estimatedBefore} > ${maxAllowed}`);
      droppedForBudget = this.trimToFit(parts, maxAllowed);
      warnings.push(`dropped ${droppedForBudget} messages to fit budget`);
    }

    // === 7. Changelog ===
    if (injectedNotebook !== this.lastInjectedNotebook)
      changedBecause.push(`notebook:${this.lastInjectedNotebook}->${injectedNotebook}`);
    if (injectedKnowledge !== this.lastInjectedKnowledge)
      changedBecause.push(`knowledge:${this.lastInjectedKnowledge}->${injectedKnowledge}`);
    if (compressedCount !== this.lastCompressedMessages)
      changedBecause.push(`compressed:${this.lastCompressedMessages}->${compressedCount}`);
    if (droppedForBudget !== this.lastDroppedForBudget)
      changedBecause.push(`dropped:${this.lastDroppedForBudget}->${droppedForBudget}`);
    if (changedBecause.length === 0 && this.contextVersion === 0) changedBecause.push("initial_build");
    else if (changedBecause.length === 0) changedBecause.push("no_major_change");

    this.contextVersion++;
    const finalTokens = this.estimateTokens(parts);

    const changelogEntry = this.changelog.addEntry({
      contextVersion: this.contextVersion,
      step: step ?? 0,
      memoryVersion: components.notebook.version,
      stateSnapshotStatus: components.state.snapshot().status,
      injectedMemory: injectedNotebook,
      injectedState: true,
      compressedMessages: compressedCount,
      droppedForBudget,
      estimatedTotalTokens: finalTokens,
      changedBecause,
    });

    this.lastInjectedNotebook = injectedNotebook;
    this.lastInjectedKnowledge = injectedKnowledge;
    this.lastCompressedMessages = compressedCount;
    this.lastDroppedForBudget = droppedForBudget;

    return {
      messages: parts,
      report: {
        contextVersion: this.contextVersion,
        step: step ?? 0,
        agentType: this.config.agentType,
        totalMessages: parts.length,
        estimatedTotalTokens: finalTokens,
        compressedMessages: compressedCount,
        droppedForBudget,
        maxAllowedTokens: maxAllowed,
        sections,
        warnings,
        changedBecause,
        checkpointCreated,
        retrievalStrategy: components.knowledge.strategy,
        retrievalCount: components.knowledge.entries.length,
      },
      checkpoint,
      changelogEntry,
    };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  private buildSystemPrompt(c: PromptComponents): string {
    const base = c.instruction.merged;

    let addendum = "";
    switch (this.config.agentType) {
      case "coding":
        addendum = CODING_ADDENDUM;
        break;
      case "research":
        addendum = RESEARCH_ADDENDUM;
        break;
    }

    return base + (addendum ? "\n\n" + addendum : "");
  }

  private formatNotebook(notebook: AgentNotebookData): string {
    const lines: string[] = ["## Agent Runtime State"];

    const statusIcon = {
      active: "🟢",
      completed: "✅",
      failed: "❌",
      blocked: "🚫",
    }[notebook.goal.status];
    lines.push(`**Goal**: ${notebook.goal.primary} ${statusIcon}`);

    if (notebook.plan) {
      lines.push(
        `**Plan**: ${notebook.plan.steps.length} steps | ` +
          `${notebook.plan.completedCount} completed | ${notebook.plan.failedCount} failed | ` +
          `current: step ${notebook.plan.currentStepIndex + 1}`,
      );
    }

    if (notebook.currentStep) {
      lines.push(`**Current Step**: ${notebook.currentStep.action}`);
    }

    if (notebook.blocked) {
      lines.push(`**Blocked**: ${notebook.blocked.reason}`);
      if (notebook.blocked.suggestion) {
        lines.push(`  Suggestion: ${notebook.blocked.suggestion}`);
      }
    }

    if (notebook.decisions.length > 0) {
      lines.push("**Decisions**:");
      for (const d of notebook.decisions.slice(-3)) {
        lines.push(`  - ${d.decision} — ${d.reason}`);
      }
    }

    if (notebook.observations.length > 0) {
      lines.push("**Recent Observations**:");
      for (const o of notebook.observations.slice(-3)) {
        const icon = o.success ? "✅" : "❌";
        lines.push(`  - ${icon} ${o.summary}`);
      }
    }

    return lines.join("\n");
  }

  private formatKnowledge(result: RetrievalResult): string {
    const lines: string[] = ["## Relevant Knowledge"];

    for (const entry of result.entries) {
      const score = result.scores.get(entry.id) ?? 0;
      lines.push(`- [${entry.type}|score=${score.toFixed(3)}] ${entry.content}`);
      if (entry.reason) {
        lines.push(`  Reason: ${entry.reason}`);
      }
    }

    return lines.join("\n");
  }

  private formatStateSnapshot(snapshot: ReturnType<StateMachine["snapshot"]>): string {
    const lines: string[] = ["## Execution State"];
    lines.push(`Status: ${snapshot.status}`);
    lines.push(
      `Steps: ${snapshot.totalSteps} (completed: ${snapshot.completedSteps.length}, failed: ${snapshot.failedSteps.length})`,
    );
    if (snapshot.retryCount > 0) lines.push(`Retries: ${snapshot.retryCount}`);
    if (snapshot.reflections.length > 0) {
      lines.push(`Reflections: ${snapshot.reflections.length}`);
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

  private trimToFit(messages: Message[], maxTokens: number): number {
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
