/**
 * Instruction Layer — 指令层级发现与合并
 *
 * ============================================================
 * Phase 6 核心：信息生命周期第一层
 *
 * 【职责】
 * Discovery → Merge → Priority → InstructionContext
 *
 * 【四种指令源】
 * 1. Managed  — 框架内置默认指令（优先级最低）
 * 2. Global   — ~/.thinking/THINKING.md（用户全局配置）
 * 3. Project  — 项目根目录的 THINKING.md（团队规范）
 * 4. Local    — THINKING.local.md（个人覆盖，不入 git）
 *
 * 【加载策略】
 * 优先级反转：低优先级先加载（利用 LLM 的 recency bias）
 * 从根目录向 CWD 遍历：离 CWD 越近优先级越高
 * ============================================================
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { getLogger } from "../utils/logger.js";

// ============================================================
// 类型定义
// ============================================================

export type InstructionSourceType = "managed" | "global" | "project" | "local";

export interface InstructionSource {
  path: string;
  type: InstructionSourceType;
  priority: number;        // 越高越优先（managed=1, global=2, project=3, local=4）
  content: string;
}

export interface InstructionContext {
  merged: string;          // 合并后的最终文本
  sources: InstructionSource[];  // 按优先级升序排列
  version: number;
}

export interface InstructionLayerConfig {
  /** 配置文件名（默认 THINKING.md） */
  fileName?: string;
  /** 隐藏目录名（默认 .thinking） */
  dirName?: string;
  /** Global 配置目录（默认 ~/.thinking） */
  globalDir?: string;
  /** @include 最大递归深度 */
  maxIncludeDepth?: number;
  /** 是否启用 @include 解析 */
  enableIncludes?: boolean;
}

const DEFAULT_CONFIG: Required<InstructionLayerConfig> = {
  fileName: "THINKING.md",
  dirName: ".thinking",
  globalDir: path.join(os.homedir(), ".thinking"),
  maxIncludeDepth: 3,
  enableIncludes: true,
};

// ============================================================
// 核心实现
// ============================================================

export class InstructionLayer {
  private config: Required<InstructionLayerConfig>;
  private logger = getLogger();
  private cachedContext: InstructionContext | null = null;
  private version = 0;

  constructor(config?: Partial<InstructionLayerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 发现并合并所有指令源
   */
  async discover(cwd: string, managedPrompt?: string): Promise<InstructionContext> {
    const sources: InstructionSource[] = [];

    // 1. Managed — 框架内置默认指令（优先级最低）
    if (managedPrompt) {
      sources.push({
        path: "<builtin>",
        type: "managed",
        priority: 1,
        content: managedPrompt,
      });
    }

    // 2. Global — 用户级配置
    const globalPath = path.join(this.config.globalDir, this.config.fileName);
    const globalSource = await this.readSource(globalPath, "global", 2);
    if (globalSource) sources.push(globalSource);

    // 3. Project — 从根目录向 CWD 遍历
    const projectSources = await this.discoverProjectSources(cwd);
    sources.push(...projectSources);

    // 4. Local — 最高优先级
    const localPath = path.join(cwd, this.config.fileName.replace(".md", ".local.md"));
    const localSource = await this.readSource(localPath, "local", 4);
    if (localSource) sources.push(localSource);

    // 按优先级升序排列（低优先级先注入）
    sources.sort((a, b) => a.priority - b.priority);

    // 合并
    this.version++;
    const merged = this.mergeSources(sources);

    const context: InstructionContext = { merged, sources, version: this.version };
    this.cachedContext = context;

    this.logger.info("InstructionLayer", `Discovered ${sources.length} instruction sources`);
    return context;
  }

  /**
   * 获取缓存的指令上下文
   */
  getCached(): InstructionContext | null {
    return this.cachedContext;
  }

  /**
   * 清除缓存（用于重新加载）
   */
  clearCache(): void {
    this.cachedContext = null;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 从根目录向 CWD 逐级发现项目指令
   *
   * dirs = [/, /home, /home/user, /home/user/project]
   * reverse 后从根开始，离 CWD 越近的越后加载（更高优先级）
   */
  private async discoverProjectSources(cwd: string): Promise<InstructionSource[]> {
    const sources: InstructionSource[] = [];
    const dirs = this.walkUpToRoot(cwd);

    // 从根目录向 CWD 方向遍历
    for (const dir of dirs) {
      // THINKING.md
      const mainPath = path.join(dir, this.config.fileName);
      const mainSource = await this.readSource(mainPath, "project", 3);
      if (mainSource) sources.push(mainSource);

      // .thinking/THINKING.md
      const hiddenPath = path.join(dir, this.config.dirName, this.config.fileName);
      const hiddenSource = await this.readSource(hiddenPath, "project", 3);
      if (hiddenSource) sources.push(hiddenSource);
    }

    return sources;
  }

  /**
   * 从 CWD 向上遍历到文件系统根目录
   */
  private walkUpToRoot(cwd: string): string[] {
    const dirs: string[] = [];
    let current = path.resolve(cwd);
    const root = path.parse(current).root;

    while (true) {
      dirs.push(current);
      const parent = path.dirname(current);
      if (parent === current || current === root) break;
      current = parent;
    }

    // reverse: 从根目录向 CWD
    return dirs.reverse();
  }

  /**
   * 读取单个指令源
   */
  private async readSource(
    filePath: string,
    type: InstructionSourceType,
    priority: number,
  ): Promise<InstructionSource | null> {
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, "utf-8");

      // @include 解析
      let resolved = content;
      if (this.config.enableIncludes) {
        resolved = await this.resolveIncludes(content, filePath, 0);
      }

      this.logger.debug("InstructionLayer", `Loaded: ${filePath} (${type}, priority=${priority})`);
      return { path: filePath, type, priority, content: resolved };
    } catch (err) {
      this.logger.warn("InstructionLayer", `Failed to read ${filePath}: ${err}`);
      return null;
    }
  }

  /**
   * 合并所有指令源为最终文本
   *
   * 按优先级升序排列（低优先级在前），利用 LLM recency bias
   */
  private mergeSources(sources: InstructionSource[]): string {
    if (sources.length === 0) return "";

    const parts: string[] = [];
    for (const source of sources) {
      const header = `[${source.type.toUpperCase()}] ${source.path}`;
      parts.push(`<!-- ${header} -->\n${source.content.trim()}`);
    }

    return parts.join("\n\n");
  }

  /**
   * 解析 @include 指令
   *
   * 支持语法：
   *   @./relative/path.md
   *   @~/global/path.md
   *   @/absolute/path.md
   */
  private async resolveIncludes(
    content: string,
    basePath: string,
    depth: number,
    visited: Set<string> = new Set(),
  ): Promise<string> {
    if (depth >= this.config.maxIncludeDepth) return content;

    const includePattern = /^@(.+)$/gm;
    const resolved: string[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = includePattern.exec(content)) !== null) {
      const includePath = match[1].trim();
      const resolvedPath = this.resolveIncludePath(includePath, basePath);

      if (!resolvedPath) continue;
      if (visited.has(resolvedPath)) {
        this.logger.warn("InstructionLayer", `Circular @include detected: ${resolvedPath}`);
        continue;
      }

      visited.add(resolvedPath);
      resolved.push(content.slice(lastIndex, match.index));

      try {
        if (fs.existsSync(resolvedPath)) {
          let included = fs.readFileSync(resolvedPath, "utf-8");
          // 递归解析嵌套 @include
          included = await this.resolveIncludes(included, resolvedPath, depth + 1, visited);
          resolved.push(included);
        } else {
          this.logger.warn("InstructionLayer", `@include file not found: ${resolvedPath}`);
          resolved.push(match[0]); // 保留原始 @include 行
        }
      } catch {
        resolved.push(match[0]);
      }

      lastIndex = match.index + match[0].length;
    }

    if (resolved.length === 0) return content;
    resolved.push(content.slice(lastIndex));
    return resolved.join("");
  }

  /**
   * 解析 @include 路径
   */
  private resolveIncludePath(includePath: string, basePath: string): string | null {
    const baseDir = path.dirname(basePath);

    if (includePath.startsWith("~/")) {
      return path.join(os.homedir(), includePath.slice(2));
    }
    if (includePath.startsWith("./") || includePath.startsWith("../")) {
      return path.resolve(baseDir, includePath);
    }
    if (path.isAbsolute(includePath)) {
      return includePath;
    }
    // 相对路径（无前缀）
    return path.resolve(baseDir, includePath);
  }
}
