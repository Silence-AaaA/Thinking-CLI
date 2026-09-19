/**
 * Knowledge Layer — 跨会话持久化知识
 *
 * ============================================================
 * Phase 6 核心：信息生命周期第二层（Framework 核心）
 *
 * 【设计哲学】
 * Storage 越 Dumb 越好。
 * 所有分类、过滤、排序 — 全部交给 Retrieval Engine。
 * Storage 只管：存 / 取 / 删。
 *
 * 【存储策略】
 * Flat uuid.json — 所有知识条目平铺存储
 * 分类全靠 metadata（type / scope / tags）
 * 不用 topic 目录 — 以后迁移零成本
 *
 * 【每条知识带 reason】
 * 不只知道"是什么"，还知道"为什么"
 * Compact / 跨会话恢复 / Multi-Agent 都有收益
 * ============================================================
 */

import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { getLogger } from "../utils/logger.js";

// ============================================================
// 类型定义
// ============================================================

export type KnowledgeType =
  | "preference"      // 用户偏好（代码风格、输出格式）
  | "convention"      // 项目约定（命名规范、目录结构）
  | "architecture"    // 架构知识（模块关系、数据流）
  | "experience"      // 经验教训（踩过的坑、有效的策略）
  | "fact"            // 事实（API 地址、配置值）
  | "timeline";       // 时间线（做了什么决策、为什么）

export type KnowledgeScope = "global" | "project";

export type KnowledgeSourceKind = "user" | "tool" | "observation" | "reflection" | "extraction";

export interface KnowledgeSource {
  kind: KnowledgeSourceKind;
  sessionId?: string;
  stepId?: number;
}

export interface KnowledgeEntry {
  id: string;
  type: KnowledgeType;
  scope: KnowledgeScope;
  content: string;
  reason: string;
  importance: number;        // 1-5
  confidence: number;        // 0-1
  source: KnowledgeSource;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  tags: string[];
}

/**
 * 轻量索引条目（不含 content/reason，用于快速过滤）
 */
export interface IndexEntry {
  id: string;
  type: KnowledgeType;
  scope: KnowledgeScope;
  importance: number;
  tags: string[];
  updatedAt: number;
}

export interface KnowledgeIndex {
  version: number;
  updatedAt: number;
  entries: IndexEntry[];
}

// ============================================================
// 配置
// ============================================================

export interface KnowledgeStoreConfig {
  /** 存储根目录（默认 ~/.thinking） */
  storageRoot: string;
  /** 项目标识（用于构建项目级存储路径） */
  projectId?: string;
  /** GC：最大存活时间（ms，默认 30 天） */
  maxAge: number;
  /** GC：最小重要度（低于此值的老条目被淘汰） */
  gcMinImportance: number;
}

const DEFAULT_CONFIG: KnowledgeStoreConfig = {
  storageRoot: path.join(getHomeDir(), ".thinking"),
  maxAge: 30 * 24 * 60 * 60 * 1000,
  gcMinImportance: 2,
};

function getHomeDir(): string {
  try {
    return require("os").homedir();
  } catch {
    return process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  }
}

// ============================================================
// Knowledge Store
// ============================================================

export class KnowledgeStore {
  private config: KnowledgeStoreConfig;
  private logger = getLogger();
  private indexCache: KnowledgeIndex | null = null;

  constructor(config?: Partial<KnowledgeStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============================================================
  // 路径
  // ============================================================

  private get projectDir(): string {
    if (this.config.projectId) {
      return path.join(this.config.storageRoot, "projects", this.config.projectId, "knowledge");
    }
    return path.join(this.config.storageRoot, "global", "knowledge");
  }

  private get indexPath(): string {
    return path.join(this.projectDir, "..", "index.json");
  }

  private entryPath(id: string): string {
    return path.join(this.projectDir, `${id}.json`);
  }

  // ============================================================
  // 存 / 取 / 删
  // ============================================================

  /**
   * 保存一条知识
   */
  async save(entry: KnowledgeEntry): Promise<void> {
    this.ensureDir(this.projectDir);

    const filePath = this.entryPath(entry.id);
    const data = JSON.stringify(entry, null, 2);
    fs.writeFileSync(filePath, data, "utf-8");

    // 更新索引
    this.updateIndex(entry);

    this.logger.info("KnowledgeStore", `Saved: ${entry.id} (${entry.type})`);
  }

  /**
   * 批量保存
   */
  async saveBatch(entries: KnowledgeEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.save(entry);
    }
  }

  /**
   * 按 ID 加载单条
   */
  async load(id: string): Promise<KnowledgeEntry | null> {
    const filePath = this.entryPath(id);
    try {
      if (!fs.existsSync(filePath)) return null;
      const data = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(data) as KnowledgeEntry;
      // 更新访问计数
      entry.accessCount++;
      entry.lastAccessedAt = Date.now();
      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * 加载多条（或全部）
   */
  async loadBatch(ids?: string[]): Promise<KnowledgeEntry[]> {
    if (!ids) {
      // 加载全部
      const index = this.getIndex();
      return (await Promise.all(index.entries.map(e => this.load(e.id)))).filter(Boolean) as KnowledgeEntry[];
    }
    return (await Promise.all(ids.map(id => this.load(id)))).filter(Boolean) as KnowledgeEntry[];
  }

  /**
   * 删除
   */
  async delete(id: string): Promise<void> {
    const filePath = this.entryPath(id);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      this.logger.warn("KnowledgeStore", `Failed to delete ${id}: ${err}`);
    }

    // 更新索引
    this.removeFromIndex(id);
  }

  /**
   * 获取轻量索引
   */
  getIndex(): KnowledgeIndex {
    if (this.indexCache) return this.indexCache;

    try {
      if (fs.existsSync(this.indexPath)) {
        const data = fs.readFileSync(this.indexPath, "utf-8");
        this.indexCache = JSON.parse(data) as KnowledgeIndex;
        return this.indexCache!;
      }
    } catch {
      // 索引损坏，重建
    }

    this.indexCache = { version: 1, updatedAt: Date.now(), entries: [] };
    return this.indexCache;
  }

  /**
   * 获取条目总数
   */
  count(): number {
    return this.getIndex().entries.length;
  }

  // ============================================================
  // GC（垃圾回收）
  // ============================================================

  /**
   * 清理过期 + 低重要度的条目
   */
  async gc(): Promise<number> {
    const index = this.getIndex();
    const now = Date.now();
    let removed = 0;

    for (const entry of [...index.entries]) {
      const age = now - entry.updatedAt;
      const isOld = age > this.config.maxAge;
      const isLowImportance = entry.importance < this.config.gcMinImportance;

      if (isOld && isLowImportance) {
        await this.delete(entry.id);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info("KnowledgeStore", `GC removed ${removed} entries`);
    }
    return removed;
  }

  // ============================================================
  // 从 Working Memory 提升
  // ============================================================

  /**
   * 从 AgentNotebook 的决策中提取知识
   */
  extractFromDecision(decision: {
    decision: string;
    reason: string;
    stepId: number;
  }, sessionId?: string): KnowledgeEntry {
    return this.createEntry({
      type: "experience",
      scope: "project",
      content: decision.decision,
      reason: decision.reason,
      importance: 3,
      confidence: 0.8,
      source: { kind: "extraction", sessionId, stepId: decision.stepId },
      tags: ["decision"],
    });
  }

  /**
   * 从 Observation 中提取知识
   */
  extractFromObservation(obs: {
    summary: string;
    keyFindings: string[];
    success: boolean;
    severity: string;
    stepId: number;
  }, sessionId?: string): KnowledgeEntry | null {
    // 只提取有价值的信息
    if (obs.severity === "low" && obs.success) return null;

    const content = obs.keyFindings.length > 0
      ? `${obs.summary}: ${obs.keyFindings.join("; ")}`
      : obs.summary;

    return this.createEntry({
      type: obs.success ? "fact" : "experience",
      scope: "project",
      content,
      reason: obs.success
        ? `Observation at step ${obs.stepId}`
        : `Failed observation at step ${obs.stepId} — learn from this`,
      importance: obs.success ? 2 : 3,
      confidence: 0.7,
      source: { kind: "observation", sessionId, stepId: obs.stepId },
      tags: obs.success ? ["observation"] : ["observation", "failure"],
    });
  }

  // ============================================================
  // 内部方法
  // ============================================================

  private createEntry(partial: Omit<KnowledgeEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt">): KnowledgeEntry {
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessedAt: now,
      ...partial,
    };
  }

  private updateIndex(entry: KnowledgeEntry): void {
    const index = this.getIndex();
    const existing = index.entries.findIndex(e => e.id === entry.id);

    const indexEntry: IndexEntry = {
      id: entry.id,
      type: entry.type,
      scope: entry.scope,
      importance: entry.importance,
      tags: entry.tags,
      updatedAt: entry.updatedAt,
    };

    if (existing >= 0) {
      index.entries[existing] = indexEntry;
    } else {
      index.entries.push(indexEntry);
    }

    index.version++;
    index.updatedAt = Date.now();
    this.saveIndex(index);
  }

  private removeFromIndex(id: string): void {
    const index = this.getIndex();
    index.entries = index.entries.filter(e => e.id !== id);
    index.version++;
    index.updatedAt = Date.now();
    this.saveIndex(index);
  }

  private saveIndex(index: KnowledgeIndex): void {
    this.ensureDir(path.dirname(this.indexPath));
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), "utf-8");
    this.indexCache = index;
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
