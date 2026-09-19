/**
 * Extraction Scheduler — 双阈值触发机制
 *
 * ============================================================
 * 从 Claude Code Session Memory 借鉴的双阈值设计
 *
 * 【触发条件】
 * Token 增长是必要条件（防止过度提取）
 * Tool call 计数是充分条件（防止在无工具调用时提取）
 *
 * 【公式】
 * shouldExtract = (tokenDelta >= tokenThreshold AND toolCalls >= toolCallThreshold)
 *              OR (tokenDelta >= tokenThreshold AND noToolCallsInLastTurn)
 * ============================================================
 */

import { getLogger } from "../utils/logger.js";

export interface ExtractionTriggerConfig {
  /** token 增长量阈值（默认 5000） */
  tokenThreshold: number;
  /** tool call 计数阈值（默认 3） */
  toolCallThreshold: number;
  /** 初始化阈值（默认 10000） */
  initTokenThreshold: number;
}

const DEFAULT_CONFIG: ExtractionTriggerConfig = {
  tokenThreshold: 5000,
  toolCallThreshold: 3,
  initTokenThreshold: 10000,
};

export class ExtractionScheduler {
  private config: ExtractionTriggerConfig;
  private logger = getLogger();

  private initialized = false;
  private lastTokenCount = 0;
  private toolCallsSinceLast = 0;
  private lastTurnHadToolCalls = false;

  constructor(config?: Partial<ExtractionTriggerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 判断是否应该触发提取
   */
  shouldExtract(currentTokens: number, hasToolCallsInCurrentTurn: boolean): boolean {
    // 1. 初始化阶段：等待 token 达到阈值
    if (!this.initialized) {
      if (currentTokens < this.config.initTokenThreshold) return false;
      this.initialized = true;
      this.lastTokenCount = currentTokens;
      return false;
    }

    // 2. 计算 token 增长
    const tokenDelta = currentTokens - this.lastTokenCount;
    const tokenMet = tokenDelta >= this.config.tokenThreshold;

    // 3. 判断 tool call 条件
    const toolMet = this.toolCallsSinceLast >= this.config.toolCallThreshold;
    const noToolCalls = !this.lastTurnHadToolCalls && !hasToolCallsInCurrentTurn;

    // 4. 触发条件
    const shouldTrigger = (tokenMet && toolMet) || (tokenMet && noToolCalls);

    if (shouldTrigger) {
      const toolCallsBefore = this.toolCallsSinceLast;
      this.lastTokenCount = currentTokens;
      this.toolCallsSinceLast = 0;
      this.logger.info(
        "ExtractionScheduler",
        `Triggered: tokenDelta=${tokenDelta}, toolCalls=${toolCallsBefore}, noToolCalls=${noToolCalls}`,
      );
    } else {
      // 未触发时，如果 token 条件不满足，重置 toolCallsSinceLast
      // 避免跨 turn 的 tool call 累积导致误触发
      if (!tokenMet) {
        this.toolCallsSinceLast = 0;
      }
    }

    this.lastTurnHadToolCalls = hasToolCallsInCurrentTurn;
    return shouldTrigger;
  }

  /**
   * 记录一次 tool call
   */
  recordToolCall(): void {
    this.toolCallsSinceLast++;
    this.lastTurnHadToolCalls = true;
  }

  /**
   * 记录 token 数变化
   */
  recordTokenCount(count: number): void {
    // 只用于外部跟踪，不影响 shouldExtract 的判断
  }

  /**
   * 重置（新会话时）
   */
  reset(): void {
    this.initialized = false;
    this.lastTokenCount = 0;
    this.toolCallsSinceLast = 0;
    this.lastTurnHadToolCalls = false;
  }

  /**
   * 序列化（用于 checkpoint）
   */
  toJSON(): {
    initialized: boolean;
    lastTokenCount: number;
    toolCallsSinceLast: number;
    lastTurnHadToolCalls: boolean;
  } {
    return {
      initialized: this.initialized,
      lastTokenCount: this.lastTokenCount,
      toolCallsSinceLast: this.toolCallsSinceLast,
      lastTurnHadToolCalls: this.lastTurnHadToolCalls,
    };
  }

  /**
   * 从序列化恢复
   */
  loadJSON(data: {
    initialized: boolean;
    lastTokenCount: number;
    toolCallsSinceLast: number;
    lastTurnHadToolCalls: boolean;
  }): void {
    this.initialized = data.initialized;
    this.lastTokenCount = data.lastTokenCount;
    this.toolCallsSinceLast = data.toolCallsSinceLast;
    this.lastTurnHadToolCalls = data.lastTurnHadToolCalls;
  }
}
