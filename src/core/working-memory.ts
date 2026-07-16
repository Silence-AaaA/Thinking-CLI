/**
 * Working Memory — 工作记忆
 *
 * ============================================================
 * Phase 4 核心：当前任务的关键信息，每轮注入 prompt
 *
 * 【设计哲学】
 * LLM 在长对话中会"忘记"前面的关键信息。
 * Working Memory 用结构化字段存储关键上下文，
 * 每次调 LLM 时自动注入，确保不会丢失。
 *
 * 【与对话历史的区别】
 * - 对话历史：完整的 tool_call → result 流水账，越来越长
 * - Working Memory：只存关键结论，体积小、信息密度高
 *
 * 【生命周期】
 * - 任务开始时初始化
 * - 每次工具调用后自动更新（由 Agent 主循环驱动）
 * - 任务结束时重置
 * ============================================================
 */

import { getLogger } from "../utils/logger.js";

/** Working Memory 配置 */
export interface WorkingMemoryConfig {
  /** 最大文件追踪数（防止无限膨胀） */
  maxTrackedFiles: number;
  /** 最大关键发现数 */
  maxFindings: number;
  /** 每条发现的最大字符数 */
  maxFindingLength: number;
}

const DEFAULT_CONFIG: WorkingMemoryConfig = {
  maxTrackedFiles: 20,
  maxFindings: 15,
  maxFindingLength: 200,
};

/** 一条关键发现 */
export interface Finding {
  /** 发现内容 */
  content: string;
  /** 来源工具 */
  source: string;
  /** 来源文件/路径（可选） */
  file?: string;
  /** 时间戳 */
  timestamp: number;
  /** 重要程度 */
  importance: "low" | "medium" | "high";
}

/** Working Memory 快照 */
export interface WorkingMemorySnapshot {
  currentGoal: string;
  findings: Finding[];
  activeFiles: string[];
  recentErrors: string[];
  decisions: string[];
}

/**
 * Working Memory
 *
 * 【学习要点】
 * 这个模块是"信息管理"的核心。
 * 它不是简单的 key-value 存储，而是有选择地保留
 * 对当前任务最有价值的信息。
 */
export class WorkingMemory {
  private _currentGoal: string = "";
  private _findings: Finding[] = [];
  private _activeFiles: Set<string> = new Set();
  private _recentErrors: string[] = [];
  private _decisions: string[] = [];
  private config: WorkingMemoryConfig;
  private logger = getLogger();

  constructor(config?: Partial<WorkingMemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 设置当前目标 */
  setGoal(goal: string): void {
    this._currentGoal = goal;
    this.logger.info("WorkingMemory", `Goal: ${goal.slice(0, 80)}`);
  }

  /** 添加一条关键发现 */
  addFinding(finding: Omit<Finding, "timestamp">): void {
    const entry: Finding = { ...finding, timestamp: Date.now() };
    this._findings.push(entry);

    // 超过上限，移除最旧的低重要度发现
    if (this._findings.length > this.config.maxFindings) {
      const lowIdx = this._findings.findIndex((f) => f.importance === "low");
      if (lowIdx >= 0) {
        this._findings.splice(lowIdx, 1);
      } else {
        this._findings.shift();
      }
    }
  }

  /** 追踪一个活跃文件 */
  addActiveFile(path: string): void {
    this._activeFiles.add(path);
    // 超过上限移除最旧的
    if (this._activeFiles.size > this.config.maxTrackedFiles) {
      const first = this._activeFiles.values().next().value;
      if (first) this._activeFiles.delete(first);
    }
  }

  /** 记录最近错误 */
  addError(error: string): void {
    this._recentErrors.push(error.slice(0, this.config.maxFindingLength));
    // 只保留最近 5 条
    if (this._recentErrors.length > 5) {
      this._recentErrors.shift();
    }
  }

  /** 记录一个决策 */
  addDecision(decision: string): void {
    this._decisions.push(decision.slice(0, this.config.maxFindingLength));
    // 只保留最近 10 条
    if (this._decisions.length > 10) {
      this._decisions.shift();
    }
  }

  /** 获取快照 */
  snapshot(): WorkingMemorySnapshot {
    return {
      currentGoal: this._currentGoal,
      findings: [...this._findings],
      activeFiles: [...this._activeFiles],
      recentErrors: [...this._recentErrors],
      decisions: [...this._decisions],
    };
  }

  /**
   * 格式化为 LLM 可读的文本
   *
   * 【输出格式】
   * ```
   * ## Working Memory
   * **Goal**: read and analyze package.json
   * **Active Files**: package.json, tsconfig.json
   * **Key Findings**:
   *   - [high] (read_file) package.json has 3 dependencies
   *   - [medium] (grep) no TODO comments found
   * **Recent Errors**:
   *   - read_file: ENOENT for /bad/path
   * **Decisions**:
   *   - Using grep before reading entire files
   * ```
   */
  formatForLLM(): string {
    const lines: string[] = ["## Working Memory"];

    if (this._currentGoal) {
      lines.push(`**Goal**: ${this._currentGoal}`);
    }

    if (this._activeFiles.size > 0) {
      lines.push(`**Active Files**: ${[...this._activeFiles].join(", ")}`);
    }

    if (this._findings.length > 0) {
      lines.push("**Key Findings**:");
      this._findings.forEach((f) => {
        const trunc = f.content.length > 120 ? f.content.slice(0, 120) + "..." : f.content;
        lines.push(`  - [${f.importance}] (${f.source}) ${trunc}`);
      });
    }

    if (this._recentErrors.length > 0) {
      lines.push("**Recent Errors**:");
      this._recentErrors.forEach((e) => {
        lines.push(`  - ${e}`);
      });
    }

    if (this._decisions.length > 0) {
      lines.push("**Decisions**:");
      this._decisions.forEach((d) => {
        lines.push(`  - ${d}`);
      });
    }

    return lines.join("\n");
  }

  /** 估算当前 token 消耗 */
  estimateTokens(): number {
    return Math.ceil(this.formatForLLM().length / 4);
  }

  /** 重置 */
  reset(): void {
    this._currentGoal = "";
    this._findings = [];
    this._activeFiles.clear();
    this._recentErrors = [];
    this._decisions = [];
    this.logger.info("WorkingMemory", "Reset");
  }
}
