/**
 * History Compressor — 历史压缩
 *
 * ============================================================
 * Phase 4 核心：把早期对话压缩为摘要
 *
 * 【设计哲学】
 * 对话越长，LLM 的注意力越分散。
 * 第 1 轮的工具调用细节对当前决策可能已经没用了，
 * 但"之前做过什么"这个高层信息还是有价值的。
 *
 * 【策略】
 * 把对话历史分为两段：
 * - Recent（最近 N 轮）：保持完整，LLM 需要精确上下文
 * - Older（更早的轮次）：压缩为摘要，只保留关键信息
 *
 * 【压缩方式】
 * 不是用 LLM 来总结（太慢、太贵），
 * 而是用规则提取关键信息：
 * - 调了哪些工具（tool name + 关键参数）
 * - 成功还是失败
 * - 核心结论（如果是 LLM 的文字回复）
 * ============================================================
 */

import type { Message } from "../llm/types.js";
import { getLogger } from "../utils/logger.js";

/** History Compressor 配置 */
export interface HistoryCompressorConfig {
  /** 保留最近几轮完整对话（1 轮 = user + assistant/tool 消息序列） */
  recentRounds: number;
  /** 触发压缩的最小轮次数（对话少于此数不压缩） */
  minRoundsToCompress: number;
  /** 压缩摘要的最大 token 估算 */
  maxSummaryTokens?: number;
}

const DEFAULT_CONFIG: HistoryCompressorConfig = {
  recentRounds: 5,
  minRoundsToCompress: 8,
};

/** 压缩结果 */
export interface CompressedHistory {
  /** 压缩后的摘要文本 */
  summary: string;
  /** 保留的最近消息 */
  recentMessages: Message[];
  /** 压缩了多少条消息 */
  compressedCount: number;
  /** 原始总消息数 */
  originalCount: number;
}

/**
 * History Compressor
 *
 * 【学习要点】
 * 这是一个"规则驱动"的压缩器，不是 LLM 驱动的。
 * 好处：快、免费、可预测。
 * 限制：不能像 LLM 那样生成自然语言摘要。
 *
 * 对于学习项目，规则压缩足够了。
 * 生产级可以考虑用 LLM 做更精细的压缩（Phase 8）。
 */
export class HistoryCompressor {
  private config: HistoryCompressorConfig;
  private logger = getLogger();

  constructor(config?: Partial<HistoryCompressorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 判断是否需要压缩
   */
  shouldCompress(messages: Message[]): boolean {
    // 排除 system message
    const nonSystem = messages.filter((m) => m.role !== "system");
    // 估算轮次数（大约每 4 条消息 = 1 轮）
    const estimatedRounds = Math.floor(nonSystem.length / 4);
    return estimatedRounds >= this.config.minRoundsToCompress;
  }

  /**
   * 压缩对话历史
   *
   * 【算法】
   * 1. 把消息按轮次分组（每轮 = user → assistant → tool* → assistant）
   * 2. 前 N 轮压缩为摘要
   * 3. 最近 N 轮保持完整
   * 4. 返回 { summary, recentMessages }
   */
  compress(messages: Message[]): CompressedHistory {
    // 保留 system message
    const systemMsgs = messages.filter((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    // 按轮次分组
    const rounds = this.groupIntoRounds(nonSystemMsgs);

    if (rounds.length <= this.config.recentRounds) {
      // 不需要压缩
      return {
        summary: "",
        recentMessages: messages,
        compressedCount: 0,
        originalCount: messages.length,
      };
    }

    // 分割：早期轮次 vs 最近轮次
    const splitIdx = rounds.length - this.config.recentRounds;
    const olderRounds = rounds.slice(0, splitIdx);
    const recentRounds = rounds.slice(splitIdx);

    // 压缩早期轮次
    const summary = this.compressRounds(olderRounds);

    // 重建消息列表：system + summary + 最近轮次
    const summaryMessage: Message = {
      role: "user",
      content: summary,
    };

    const recentMessages: Message[] = [
      ...systemMsgs,
      summaryMessage,
      { role: "assistant", content: "Understood. I'll continue from here." },
      ...recentRounds.flat(),
    ];

    const compressedCount = nonSystemMsgs.length - recentRounds.flat().length;

    this.logger.info("HistoryCompressor", `Compressed ${compressedCount} messages into summary`);

    return {
      summary,
      recentMessages,
      compressedCount,
      originalCount: messages.length,
    };
  }

  // ---- 内部方法 ----

  /**
   * 把消息序列按轮次分组
   *
   * 一轮 = user 消息开始，到下一个 user 消息之前的所有消息
   * 特殊处理：第一轮可能没有 user 消息（只有 system + assistant）
   */
  private groupIntoRounds(messages: Message[]): Message[][] {
    const rounds: Message[][] = [];
    let currentRound: Message[] = [];

    for (const msg of messages) {
      if (msg.role === "user" && currentRound.length > 0) {
        rounds.push(currentRound);
        currentRound = [];
      }
      currentRound.push(msg);
    }

    if (currentRound.length > 0) {
      rounds.push(currentRound);
    }

    return rounds;
  }

  /**
   * 把一组轮次压缩为文本摘要
   *
   * 【提取信息】
   * - 调了哪些工具 + 关键参数
   * - 成功/失败
   * - LLM 的关键结论
   */
  private compressRounds(rounds: Message[][]): string {
    const entries: string[] = [];

    for (const round of rounds) {
      const roundSummary = this.compressRound(round);
      if (roundSummary) {
        entries.push(roundSummary);
      }
    }

    return [
      "## Conversation History Summary",
      "",
      "以下是之前对话的压缩摘要，保留了关键信息：",
      "",
      ...entries,
      "",
      "---",
      "（以下是最近的完整对话）",
    ].join("\n");
  }

  /**
   * 压缩单轮对话
   */
  private compressRound(messages: Message[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      if (msg.role === "user" && msg.content) {
        // 用户输入（可能带反思 prompt，只保留用户原始输入）
        const preview = msg.content.slice(0, 100);
        if (preview.startsWith("## ⚠️ REFLECTION")) {
          parts.push("  触发了反思机制");
          continue;
        }
        if (preview.startsWith("## Conversation History Summary")) {
          // 跳过之前的压缩摘要
          continue;
        }
        parts.push(`用户: ${preview}${msg.content.length > 100 ? "..." : ""}`);
      }

      if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // 助手调用了工具
          const toolNames = msg.tool_calls.map((tc) => tc.name).join(", ");
          parts.push(`助手调用工具: ${toolNames}`);
        } else if (msg.content) {
          // 助手的纯文字回复（可能是最终结论）
          const preview = msg.content.slice(0, 150);
          parts.push(`助手回复: ${preview}${msg.content.length > 150 ? "..." : ""}`);
        }
      }

      if (msg.role === "tool" && msg.content) {
        // 工具结果 — 提取摘要行
        const firstLine = msg.content.split("\n")[0].slice(0, 100);
        parts.push(`  结果: ${firstLine}`);
      }
    }

    if (parts.length === 0) return "";
    return parts.join("\n");
  }
}
