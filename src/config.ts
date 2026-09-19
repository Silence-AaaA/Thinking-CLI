/**
 * 配置文件管理器
 *
 * 【配置优先级】（高 → 低）
 * 1. CLI 参数 (--capability high)
 * 2. 项目配置 (.thinking.json)
 * 3. 用户全局配置 (~/.thinking/config.json)
 * 4. 内置默认值
 *
 * 【配置文件位置】
 * - 项目级：项目根目录 .thinking.json
 * - 用户级：~/.thinking/config.json
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { CapabilityLevel } from "./capabilities.js";

export interface ThinkingConfig {
  /** 默认能力档位 */
  defaultCapability: CapabilityLevel;
  /** 默认模型（null = 使用 .env 中的 OPENAI_MODEL） */
  model: string | null;
  /** 是否默认启用审批 */
  approval: boolean;
}

const DEFAULT_CONFIG: ThinkingConfig = {
  defaultCapability: "medium",
  model: null,
  approval: true,
};

/** 项目级配置文件名 */
const PROJECT_CONFIG = ".thinking.json";

/** 用户级配置目录 */
const USER_CONFIG_DIR = path.join(os.homedir(), ".thinking");
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, "config.json");

function findProjectRoot(): string {
  // 从当前目录向上查找 .thinking.json
  let dir = process.cwd();
  while (true) {
    const configPath = path.join(dir, PROJECT_CONFIG);
    if (fs.existsSync(configPath)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * 加载配置（合并多层配置）
 */
export function loadConfig(): ThinkingConfig {
  let config = { ...DEFAULT_CONFIG };

  // 1. 加载用户全局配置
  if (fs.existsSync(USER_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(USER_CONFIG_FILE, "utf-8");
      const userConfig = JSON.parse(raw);
      config = { ...config, ...sanitizeConfig(userConfig) };
    } catch {
      // 忽略解析错误
    }
  }

  // 2. 加载项目级配置（覆盖用户配置）
  const projectRoot = findProjectRoot();
  const projectConfigPath = path.join(projectRoot, PROJECT_CONFIG);
  if (fs.existsSync(projectConfigPath)) {
    try {
      const raw = fs.readFileSync(projectConfigPath, "utf-8");
      const projectConfig = JSON.parse(raw);
      config = { ...config, ...sanitizeConfig(projectConfig) };
    } catch {
      // 忽略解析错误
    }
  }

  return config;
}

/**
 * 保存配置到项目级配置文件
 */
export function saveProjectConfig(updates: Partial<ThinkingConfig>): void {
  const projectRoot = findProjectRoot();
  const configPath = path.join(projectRoot, PROJECT_CONFIG);

  let existing: Partial<ThinkingConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // 忽略
    }
  }

  const merged = { ...existing, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/**
 * 保存配置到用户全局配置文件
 */
export function saveUserConfig(updates: Partial<ThinkingConfig>): void {
  if (!fs.existsSync(USER_CONFIG_DIR)) {
    fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  }

  let existing: Partial<ThinkingConfig> = {};
  if (fs.existsSync(USER_CONFIG_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, "utf-8"));
    } catch {
      // 忽略
    }
  }

  const merged = { ...existing, ...updates };
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/**
 * 获取配置文件路径（用于展示）
 */
export function getConfigPaths(): { project: string | null; user: string } {
  const projectRoot = findProjectRoot();
  const projectConfigPath = path.join(projectRoot, PROJECT_CONFIG);
  return {
    project: fs.existsSync(projectConfigPath) ? projectConfigPath : null,
    user: USER_CONFIG_FILE,
  };
}

/** 清理配置对象，只保留已知字段 */
function sanitizeConfig(raw: Record<string, unknown>): Partial<ThinkingConfig> {
  const result: Partial<ThinkingConfig> = {};
  if (typeof raw["defaultCapability"] === "string") {
    result.defaultCapability = raw["defaultCapability"] as CapabilityLevel;
  }
  if (typeof raw["model"] === "string" || raw["model"] === null) {
    result.model = raw["model"] as string | null;
  }
  if (typeof raw["approval"] === "boolean") {
    result.approval = raw["approval"];
  }
  return result;
}
