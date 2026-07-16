/**
 * Context Assembler — 上下文组装器
 *
 * ============================================================
 * Phase 4 核心：组装最终送给 LLM 的消息列表
 *
 * 【设计哲学】
 * 之前：直接把 this.state.messages 丢给 LLM（原始流水账）
 * 现在：经过组装器重新组织，每部分都有明确职责
 *
 * 【组装结构】
 * ┌─────────────────────────────────────────────┐
 * │ System Prompt        → 角色 + 规则（不变）     │
 * │ Working Memory       → 当前目标 + 关键发现     │
 * │ State Snapshot       → 状态机关键字段          │
 * │ Recent History       → 最近 N 轮完整对话       │
 * │ Summary              → 早期对话的压缩版        │
 * │ Retrieved Context    → 按需获取的文件/知识      │
 * ├─────────────────────────────────────────────┤
 * │ 总量必须 < 上下文窗口                          │
 * └─────────────────────────────────────────────┘
 *
 * 【学习要点】
 * 上下文组装是"Context Engineering"的核心。
 * 不是把所有信息都塞进去，而是精心选择什么该放、什么该省。
 * 这和写好 prompt 的道理一样：信息密度 > 信息数量。
 * ============================================================
 */

import type { Message } from "../llm/types.js";
import type { StateMachine } from "./state-machine.js";
import type { WorkingMemory } from "./working-memory.js";
import { HistoryCompressor } from "./history-compressor.js";
import { getLogger } from "../utils/logger.js";

/** Context Assembler 配置 */
export interface ContextAssemblerConfig {
  /** 历史压缩：保留最近几轮完整对话 */
  recentRounds: number;
  /** 触发压缩的最小轮次 */
  minRoundsToCompress: number;
  /** 是否注入 Working Memory */
  injectWorkingMemory: boolean;
  /** 是否注入 State Snapshot */
  injectStateSnapshot: boolean;
  /** 上下文窗口大小估算（token） */
  contextWindowTokens: number;
  /** 留给模型回复的空间（token） */
  reserveForResponse: number;
}

const DEFAULT_CONFIG: ContextAssemblerConfig = {
  recentRounds: 5,
  minRoundsToCompress: 8,
  injectWorkingMemory: true,
  injectStateSnapshot: true,
  contextWindowTokens: 128000,
  reserveForResponse: 4000,
};

/** 组装结果 */
export interface AssembledContext {
  /** 组装后的消息列表（直接送给 LLM） */
  messages: Message[];
  /** 统计信息 */
  stats: {
    totalMessages: number;
    compressedMessages: number;
    workingMemoryTokens: number;
    stateSnapshotTokens: number;
    estimatedTotalTokens: number;
  };
}

/**
 * Context Assembler
 *
 * 【学习要点】
 * 这是 Phase 4 的核心协调者。
 * 它依赖 Working Memory 和 History Compressor，
 * 负责把各部分组装成最终送给 LLM 的消息列表。
 */
export class ContextAssembler {
  private config: ContextAssemblerConfig;
  private compressor: HistoryCompressor;
  private logger = getLogger();

  constructor(config?: Partial<ContextAssemblerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.compressor = new HistoryCompressor({
      recentRounds: this.config.recentRounds,
      minRoundsToCompress: this.config.minRoundsToCompress,
    });
  }

  /**
   * 组装上下文
   *
   * @param rawMessages 原始对话历史
   * @param workingMemory 工作记忆
   * @param stateMachine 状态机
   * @returns 组装后的消息列表 + 统计信息
   */
  assemble(
    rawMessages: Message[],
    workingMemory: WorkingMemory,
    stateMachine: StateMachine
  ): AssembledContext {
    const parts: Message[] = [];
    let compressedCount = 0;

    // 1. 提取 system message
    const systemMsgs = rawMessages.filter((m) => m.role === "system");
    const nonSystemMsgs = rawMessages.filter((m) => m.role !== "system");

    // System Prompt 始终保留
    parts.push(...systemMsgs);

    // 2. 注入 Working Memory（在 system prompt 之后，对话之前）
    let wmTokens = 0;
    if (this.config.injectWorkingMemory) {
      const wmText = workingMemory.formatForLLM();
      if (wmText.length > 50) {
        // 有实质内容才注入
        parts.push({
          role: "user",
          content: wmText,
        });
        parts.push({
          role: "assistant",
          content: "Working memory noted. Continuing with task.",
        });
        wmTokens = Math.ceil(wmText.length / 4);
      }
    }

    // 3. 注入 State Snapshot
    let ssTokens = 0;
    if (this.config.injectStateSnapshot) {
      const snapshot = stateMachine.snapshot();
      const snapshotText = this.formatStateSnapshot(snapshot);
      if (snapshotText.length > 30) {
        parts.push({
          role: "user",
          content: snapshotText,
        });
        parts.push({
          role: "assistant",
          content: "State snapshot acknowledged.",
        });
        ssTokens = Math.ceil(snapshotText.length / 4);
      }
    }

    // 4. 压缩历史（如果需要）
    if (this.compressor.shouldCompress(rawMessages)) {
      const compressed = this.compressor.compress(rawMessages);
      // 用压缩后的 recentMessages 替代原始消息
      // （compressed.recentMessages 已经包含 system + summary + 最近轮次）
      // 但我们已经手动加了 system 和 memory，所以只取 summary + recent 部分
      const nonSystemRecent = compressed.recentMessages.filter(
        (m) => m.role !== "system"
      );
      parts.push(...nonSystemRecent);
      compressedCount = compressed.compressedCount;
      this.logger.info("ContextAssembler", `History compressed: ${compressedCount} messages`);
    } else {
      // 不需要压缩，直接用原始消息（排除 system，已在前面加过）
      parts.push(...nonSystemMsgs);
    }

    // 5. 总量检查
    const estimatedTokens = this.estimateTokens(parts);
    const maxAllowed = this.config.contextWindowTokens - this.config.reserveForResponse;

    if (estimatedTokens > maxAllowed) {
      this.logger.warn(
        "ContextAssembler",
        `Context too large: ${estimatedTokens} tokens > ${maxAllowed} limit. Truncating.`
      );
      // 简单策略：移除最早的消息（保留 system + memory）
      this.truncateToFit(parts, maxAllowed);
    }

    return {
      messages: parts,
      stats: {
        totalMessages: parts.length,
        compressedMessages: compressedCount,
        workingMemoryTokens: wmTokens,
        stateSnapshotTokens: ssTokens,
        estimatedTotalTokens: this.estimateTokens(parts),
      },
    };
  }

  /**
   * 格式化状态快照为 LLM 可读文本
   */
  private formatStateSnapshot(snapshot: ReturnType<StateMachine["snapshot"]>): string {
    const lines: string[] = ["## Execution State"];

    lines.push(`Status: ${snapshot.status}`);
    lines.push(`Steps: ${snapshot.totalSteps} (completed: ${snapshot.completedSteps.length}, failed: ${snapshot.failedSteps.length})`);

    if (snapshot.retryCount > 0) {
      lines.push(`Retries: ${snapshot.retryCount}`);
    }

    if (snapshot.reflections.length > 0) {
      lines.push(`Reflections: ${snapshot.reflections.length} (last: ${snapshot.reflections[snapshot.reflections.length - 1].newStrategy})`);
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

  /**
   * 估算消息列表的 token 数
   */
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

  /**
   * 截断消息列表以适应 token 限制
   *
   * 【策略】
   * 从最早的消息开始移除（保留 system + 最近消息）
   * 不动前 2 条（通常是 system prompt）
   */
  private truncateToFit(messages: Message[], maxTokens: number): void {
    // 保留前 2 条（system + memory）
    while (this.estimateTokens(messages) > maxTokens && messages.length > 4) {
      // 找到第 3 条非 system 消息并移除
      const idx = messages.findIndex((m, i) => i >= 2 && m.role !== "system");
      if (idx >= 0 && idx < messages.length - 2) {
        messages.splice(idx, 1);
      } else {
        break;
      }
    }
  }
}

