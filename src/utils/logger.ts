/**
 * 日志工具
 *
 * 【学习要点】
 * 结构化日志是 Agent 系统的"眼睛"。
 * 没有日志，你就不知道 LLM 为什么做了某个决定，
 * 也不知道工具为什么执行失败。
 *
 * 设计原则：
 * 1. 结构化：JSON 格式，方便分析
 * 2. 分级：info/warn/error，方便过滤
 * 3. 上下文：每条日志都带 session_id 和 step
 */

import * as fs from "fs";
import * as path from "path";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogEntry {
  timestamp: string;
  level: string;
  component: string;
  message: string;
  data?: unknown;
}

class Logger {
  private level: LogLevel;
  private logFile?: fs.WriteStream;
  private sessionId: string;

  constructor(level: LogLevel = LogLevel.INFO, logDir?: string) {
    this.level = level;
    this.sessionId = Date.now().toString(36);

    if (logDir) {
      // 确保日志目录存在
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, `agent-${this.sessionId}.jsonl`);
      this.logFile = fs.createWriteStream(logPath, { flags: "a" });
    }
  }

  private log(level: LogLevel, component: string, message: string, data?: unknown): void {
    if (level < this.level) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      component,
      message,
      data,
    };

    // 输出到控制台
    const prefix = `[${entry.level}] [${component}]`;
    if (level >= LogLevel.ERROR) {
      console.error(`${prefix} ${message}`);
    } else if (level >= LogLevel.WARN) {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }

    // 写入日志文件（如果有）
    if (this.logFile) {
      this.logFile.write(JSON.stringify(entry) + "\n");
    }
  }

  debug(component: string, message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, component, message, data);
  }

  info(component: string, message: string, data?: unknown): void {
    this.log(LogLevel.INFO, component, message, data);
  }

  warn(component: string, message: string, data?: unknown): void {
    this.log(LogLevel.WARN, component, message, data);
  }

  error(component: string, message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, component, message, data);
  }

  close(): void {
    if (this.logFile) {
      this.logFile.end();
    }
  }
}

// 全局 logger 实例
let globalLogger: Logger;

export function initLogger(level?: LogLevel, logDir?: string): Logger {
  globalLogger = new Logger(level, logDir);
  return globalLogger;
}

export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger();
  }
  return globalLogger;
}
