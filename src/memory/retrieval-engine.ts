/**
 * Retrieval Engine — 模块化检索管线
 *
 * ============================================================
 * Phase 6 核心：信息生命周期第四层
 *
 * 【设计哲学】
 * 每个 filter 可独立替换。
 * 今天用 Metadata + Recency，明天换 Embedding 只需替换一个 filter。
 * 策略模式：Retrieval Pipeline = Filter Chain
 *
 * 【管线】
 * MetadataFilter → RecencyFilter → RelevanceRanker → Merge
 * ============================================================
 */

import { getLogger } from "../utils/logger.js";
import type { KnowledgeEntry, KnowledgeScope, KnowledgeStore, KnowledgeType } from "./knowledge-layer.js";

// ============================================================
// 类型定义
// ============================================================

export interface RetrievalQuery {
  /** 当前目标（用于相关性匹配） */
  goal?: string;
  /** 当前活跃文件 */
  activeFiles?: string[];
  /** 最近错误 */
  recentErrors?: string[];
  /** 按 tags 过滤 */
  tags?: string[];
  /** 按 type 过滤 */
  types?: KnowledgeType[];
  /** 按 scope 过滤 */
  scope?: KnowledgeScope;
  /** 返回数量上限 */
  limit?: number;
}

export interface ScoredEntry {
  entry: KnowledgeEntry;
  score: number;
}

export interface RetrievalResult {
  entries: KnowledgeEntry[];
  scores: Map<string, number>;
  strategy: string;
  totalCandidates: number;
  filteredCount: number;
}

/**
 * 检索 filter 接口 — 策略模式
 */
export interface RetrievalFilter {
  name: string;
  filter(candidates: KnowledgeEntry[], query: RetrievalQuery): KnowledgeEntry[];
}

/**
 * 排序器接口 — 对结果打分排序
 */
export interface RetrievalRanker {
  name: string;
  rank(candidates: KnowledgeEntry[], query: RetrievalQuery): ScoredEntry[];
}

// ============================================================
// 具体 Filter 实现
// ============================================================

/**
 * Metadata Filter — 按 type / scope / tags 过滤
 */
export class MetadataFilter implements RetrievalFilter {
  name = "metadata";

  filter(candidates: KnowledgeEntry[], query: RetrievalQuery): KnowledgeEntry[] {
    let result = candidates;

    // 按 type 过滤
    if (query.types && query.types.length > 0) {
      result = result.filter((e) => query.types!.includes(e.type));
    }

    // 按 scope 过滤
    if (query.scope) {
      result = result.filter((e) => e.scope === query.scope);
    }

    // 按 tags 过滤（OR 语义：任一 tag 匹配即可）
    if (query.tags && query.tags.length > 0) {
      result = result.filter((e) => query.tags!.some((tag) => e.tags.includes(tag)));
    }

    return result;
  }
}

/**
 * Importance Filter — 过滤掉低重要度条目
 */
export class ImportanceFilter implements RetrievalFilter {
  name = "importance";
  private minImportance: number;

  constructor(minImportance: number = 2) {
    this.minImportance = minImportance;
  }

  filter(candidates: KnowledgeEntry[], _query: RetrievalQuery): KnowledgeEntry[] {
    return candidates.filter((e) => e.importance >= this.minImportance);
  }
}

/**
 * Recency Filter — 按时间衰减，过滤太旧的条目
 */
export class RecencyFilter implements RetrievalFilter {
  name = "recency";
  private maxAge: number;

  /** 默认 7 天 */
  constructor(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000) {
    this.maxAge = maxAgeMs;
  }

  filter(candidates: KnowledgeEntry[], _query: RetrievalQuery): KnowledgeEntry[] {
    const cutoff = Date.now() - this.maxAge;
    return candidates.filter((e) => e.updatedAt >= cutoff);
  }
}

// ============================================================
// 具体 Ranker 实现
// ============================================================

/**
 * Relevance Ranker — 综合 importance * confidence * recency
 *
 * 分数公式：
 *   score = importance_weight * confidence * recency_factor * access_boost
 *
 * 其中：
 *   importance_weight = importance / 5  (归一化到 0-1)
 *   recency_factor = 1 / (1 + days_since_update * 0.1)  (时间衰减)
 *   access_boost = log2(accessCount + 1) / 10  (访问越多越重要，但有上限)
 */
export class RelevanceRanker implements RetrievalRanker {
  name = "relevance";

  rank(candidates: KnowledgeEntry[], _query: RetrievalQuery): ScoredEntry[] {
    const now = Date.now();

    return candidates.map((entry) => {
      const importanceWeight = entry.importance / 5;
      const daysSinceUpdate = (now - entry.updatedAt) / (24 * 60 * 60 * 1000);
      const recencyFactor = 1 / (1 + daysSinceUpdate * 0.1);
      const accessBoost = Math.log2(entry.accessCount + 1) / 10;

      const score = importanceWeight * entry.confidence * recencyFactor * (1 + accessBoost);

      return { entry, score };
    });
  }
}

// ============================================================
// Retrieval Engine
// ============================================================

export interface RetrievalEngineConfig {
  filters: RetrievalFilter[];
  ranker: RetrievalRanker;
  defaultLimit: number;
}

const DEFAULT_CONFIG: RetrievalEngineConfig = {
  filters: [new MetadataFilter(), new ImportanceFilter(2)],
  ranker: new RelevanceRanker(),
  defaultLimit: 10,
};

export class RetrievalEngine {
  private filters: RetrievalFilter[];
  private ranker: RetrievalRanker;
  private defaultLimit: number;
  private logger = getLogger();

  constructor(config?: Partial<RetrievalEngineConfig>) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.filters = merged.filters;
    this.ranker = merged.ranker;
    this.defaultLimit = merged.defaultLimit;
  }

  /**
   * 检索相关知识
   */
  async retrieve(query: RetrievalQuery, store: KnowledgeStore): Promise<RetrievalResult> {
    // 1. 加载候选集
    let candidates = await store.loadBatch();
    const totalCandidates = candidates.length;

    // 2. 过滤管线
    for (const filter of this.filters) {
      candidates = filter.filter(candidates, query);
      this.logger.debug("Retrieval", `${filter.name}: ${candidates.length} candidates remaining`);
    }

    const filteredCount = candidates.length;

    // 3. 排序
    const scored = this.ranker.rank(candidates, query);
    scored.sort((a, b) => b.score - a.score);

    // 4. 截断
    const limit = query.limit ?? this.defaultLimit;
    const top = scored.slice(0, limit);

    // 5. 构建结果
    const scores = new Map<string, number>();
    for (const s of top) {
      scores.set(s.entry.id, s.score);
    }

    this.logger.info("Retrieval", `Retrieved ${top.length}/${totalCandidates} entries (filtered: ${filteredCount})`);

    return {
      entries: top.map((s) => s.entry),
      scores,
      strategy: this.filters
        .map((f) => f.name)
        .concat(this.ranker.name)
        .join("→"),
      totalCandidates,
      filteredCount,
    };
  }

  /**
   * 注册新 filter
   */
  addFilter(filter: RetrievalFilter, position?: number): void {
    if (position !== undefined) {
      this.filters.splice(position, 0, filter);
    } else {
      this.filters.push(filter);
    }
  }

  /**
   * 替换 ranker
   */
  setRanker(ranker: RetrievalRanker): void {
    this.ranker = ranker;
  }

  /**
   * 格式化检索结果为 LLM 可读文本
   */
  formatForLLM(result: RetrievalResult): string {
    if (result.entries.length === 0) return "";

    const lines: string[] = ["## Relevant Knowledge"];

    for (const entry of result.entries) {
      const score = result.scores.get(entry.id) ?? 0;
      lines.push(`- [${entry.type}|importance=${entry.importance}|score=${score.toFixed(3)}] ${entry.content}`);
      if (entry.reason) {
        lines.push(`  Reason: ${entry.reason}`);
      }
      if (entry.tags.length > 0) {
        lines.push(`  Tags: ${entry.tags.join(", ")}`);
      }
    }

    return lines.join("\n");
  }
}
