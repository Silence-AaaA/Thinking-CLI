/**
 * Working Memory v2 — 可衰减、可溯源的工作记忆
 *
 * ============================================================
 * Phase 4.5 升级：
 * 1. 每条记忆带 source / confidence / lastSeenStep / strength
 * 2. 每轮 step 自动 decay（重要信息活得久，噪声会自然消失）
 * 3. 高 severity / confidence 的 Observation 自动升权
 * 4. 同源覆盖：相同 file/source 的旧记忆可以被新证据替代
 * ============================================================
 */

import { getLogger } from "../utils/logger.js";

export interface WorkingMemoryConfig {
  maxTrackedFiles: number;
  maxFindings: number;
  maxFindingLength: number;
  /** 每步强度衰减量（默认 1） */
  decayPerStep?: number;
  /** 低于该强度的 finding 自动淘汰 */
  minStrength?: number;
  /** 最大强度上限 */
  maxStrength?: number;
}

const DEFAULT_CONFIG: Required<WorkingMemoryConfig> = {
  maxTrackedFiles: 20,
  maxFindings: 20,
  maxFindingLength: 240,
  decayPerStep: 1,
  minStrength: 0,
  maxStrength: 20,
};

export type MemorySourceKind = "user" | "tool" | "observation" | "reflection" | "replan" | "system" | "unknown";

export interface MemorySource {
  kind: MemorySourceKind;
  toolName?: string;
  toolCallId?: string;
  stepId?: number;
  filePath?: string;
}

export interface Finding {
  id: string;
  content: string;
  source: MemorySource;
  file?: string;
  timestamp: number;
  lastSeenStep: number;
  importance: "low" | "medium" | "high";
  confidence: number;
  strength: number;
  tags?: string[];
}

export interface WorkingMemorySnapshot {
  currentGoal: string;
  currentStep: number;
  findings: Finding[];
  activeFiles: string[];
  recentErrors: string[];
  decisions: string[];
  version: number;
}

export class WorkingMemory {
  private _currentGoal = "";
  private _currentStep = 0;
  private _findings: Finding[] = [];
  private _activeFiles = new Map<string, { addedAtStep: number; lastSeenStep: number }>();
  private _recentErrors: string[] = [];
  private _decisions: string[] = [];
  private _version = 0;
  private config: Required<WorkingMemoryConfig>;
  private logger = getLogger();

  constructor(config?: Partial<WorkingMemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get version(): number {
    return this._version;
  }

  setGoal(goal: string): void {
    this._currentGoal = goal;
    this._version++;
    this.logger.info("WorkingMemory", `Goal: ${goal.slice(0, 80)}`);
  }

  setCurrentStep(step: number): void {
    this._currentStep = step;
  }

  /** 每步自动 decay + 淘汰 */
  tickStep(step?: number): void {
    if (step !== undefined) {
      this._currentStep = step;
    }

    let changed = false;
    for (const finding of this._findings) {
      const newStrength = Math.max(this.config.minStrength, finding.strength - this.config.decayPerStep);
      if (newStrength !== finding.strength) {
        finding.strength = newStrength;
        changed = true;
      }
    }

    const before = this._findings.length;
    this._findings = this._findings.filter((f) => f.strength > this.config.minStrength || f.importance === "high");
    if (this._findings.length !== before) {
      changed = true;
    }

    if (changed) {
      this._version++;
    }
  }

  addFinding(input: {
    content: string;
    source: MemorySource;
    file?: string;
    importance?: Finding["importance"];
    confidence?: number;
    strength?: number;
    tags?: string[];
    replaceKey?: string;
  }): Finding {
    const now = Date.now();
    const importance = input.importance ?? "medium";
    const confidence = clamp(input.confidence ?? importanceToDefaultConfidence(importance), 0, 1);
    const strength = clamp(
      input.strength ?? importanceToDefaultStrength(importance),
      this.config.minStrength,
      this.config.maxStrength,
    );

    if (input.replaceKey) {
      const idx = this._findings.findIndex((f) => f.tags?.includes(input.replaceKey!));
      if (idx >= 0) {
        const old = this._findings[idx];
        const merged: Finding = {
          ...old,
          content: input.content.slice(0, this.config.maxFindingLength),
          source: input.source,
          file: input.file ?? old.file,
          lastSeenStep: this._currentStep,
          timestamp: now,
          importance,
          confidence: Math.max(old.confidence, confidence),
          strength: Math.min(this.config.maxStrength, Math.max(old.strength, strength) + 2),
          tags: unique([...(old.tags ?? []), ...(input.tags ?? [])]),
        };
        this._findings[idx] = merged;
        this._version++;
        return merged;
      }
    }

    const entry: Finding = {
      id: `wm_${now}_${Math.random().toString(36).slice(2, 8)}`,
      content: input.content.slice(0, this.config.maxFindingLength),
      source: input.source,
      file: input.file,
      timestamp: now,
      lastSeenStep: this._currentStep,
      importance,
      confidence,
      strength,
      tags: input.tags,
    };

    this._findings.push(entry);
    this.evictOverflow();
    this._version++;
    return entry;
  }

  reinforceByFile(filePath: string, boost = 2): void {
    let changed = false;
    for (const f of this._findings) {
      if (f.source.filePath === filePath || f.file === filePath) {
        f.strength = Math.min(this.config.maxStrength, f.strength + boost);
        f.lastSeenStep = this._currentStep;
        changed = true;
      }
    }
    if (changed) this._version++;
  }

  demoteByFile(filePath: string, amount = 2): void {
    let changed = false;
    for (const f of this._findings) {
      if (f.source.filePath === filePath || f.file === filePath) {
        f.strength = Math.max(this.config.minStrength, f.strength - amount);
        f.lastSeenStep = this._currentStep;
        changed = true;
      }
    }
    if (changed) this._version++;
  }

  addActiveFile(path: string): void {
    const existing = this._activeFiles.get(path);
    if (existing) {
      existing.lastSeenStep = this._currentStep;
    } else {
      this._activeFiles.set(path, { addedAtStep: this._currentStep, lastSeenStep: this._currentStep });
      if (this._activeFiles.size > this.config.maxTrackedFiles) {
        const oldest = [...this._activeFiles.entries()].sort((a, b) => a[1].lastSeenStep - b[1].lastSeenStep)[0];
        if (oldest) this._activeFiles.delete(oldest[0]);
      }
    }
  }

  addError(error: string): void {
    this._recentErrors.push(error.slice(0, this.config.maxFindingLength));
    if (this._recentErrors.length > 5) this._recentErrors.shift();
    this._version++;
  }

  addDecision(decision: string): void {
    this._decisions.push(decision.slice(0, this.config.maxFindingLength));
    if (this._decisions.length > 10) this._decisions.shift();
    this._version++;
  }

  snapshot(): WorkingMemorySnapshot {
    return {
      currentGoal: this._currentGoal,
      currentStep: this._currentStep,
      findings: this._findings.map((f) => ({ ...f, source: { ...f.source }, tags: f.tags ? [...f.tags] : undefined })),
      activeFiles: [...this._activeFiles.keys()],
      recentErrors: [...this._recentErrors],
      decisions: [...this._decisions],
      version: this._version,
    };
  }

  /** 从快照恢复状态（用于 checkpoint/resume） */
  loadSnapshot(snap: WorkingMemorySnapshot): void {
    this._currentGoal = snap.currentGoal;
    this._currentStep = snap.currentStep;
    this._findings = snap.findings.map((f) => ({
      ...f,
      source: { ...f.source },
      tags: f.tags ? [...f.tags] : undefined,
    }));
    this._activeFiles = new Map(
      snap.activeFiles.map((p) => [p, { addedAtStep: snap.currentStep, lastSeenStep: snap.currentStep }]),
    );
    this._recentErrors = [...snap.recentErrors];
    this._decisions = [...snap.decisions];
    this._version = snap.version;
    this.logger.info("WorkingMemory", `Loaded snapshot: version=${snap.version}, findings=${snap.findings.length}`);
  }
  /** 为 Task Planning 格式化（只输出规划相关信息，过滤噪声） */
  formatForPlanning(): string {
    const lines: string[] = ["## Working Memory (Planning Context)"];

    if (this._currentGoal) {
      lines.push(`**Current Goal**: ${this._currentGoal}`);
    }

    // 只取高价值 findings
    const relevant = this._findings
      .filter((f) => f.importance !== "low" && f.strength >= 5)
      .sort((a, b) => b.strength - a.strength || b.confidence - a.confidence)
      .slice(0, 8);

    if (relevant.length > 0) {
      lines.push("**Key Findings**:");
      for (const f of relevant) {
        const sourceTag = f.source.toolName ?? f.source.kind;
        lines.push(`  - [${f.importance}|src=${sourceTag}] ${f.content}`);
      }
    }

    if (this._activeFiles.size > 0) {
      lines.push(`**Active Files**: ${[...this._activeFiles.keys()].join(", ")}`);
    }

    if (this._decisions.length > 0) {
      lines.push("**Previous Decisions**:");
      this._decisions.forEach((d) => {
        lines.push(`  - ${d}`);
      });
    }

    if (this._recentErrors.length > 0) {
      lines.push("**Known Issues**:");
      this._recentErrors.forEach((e) => {
        lines.push(`  - ${e}`);
      });
    }

    return lines.join("\n");
  }
  formatForLLM(): string {
    const lines: string[] = ["## Working Memory"];
    lines.push(`Version: ${this._version}`);

    if (this._currentGoal) {
      lines.push(`**Goal**: ${this._currentGoal}`);
    }

    if (this._activeFiles.size > 0) {
      lines.push(`**Active Files**: ${[...this._activeFiles.keys()].join(", ")}`);
    }

    const sorted = [...this._findings].sort((a, b) => b.strength - a.strength || b.confidence - a.confidence);
    if (sorted.length > 0) {
      lines.push("**Key Findings**:");
      for (const f of sorted.slice(0, 10)) {
        const preview = f.content.length > 120 ? f.content.slice(0, 120) + "..." : f.content;
        const sourceTag = f.source.toolName ?? f.source.kind;
        lines.push(
          `  - [${f.importance}|str=${f.strength}|conf=${f.confidence.toFixed(2)}|src=${sourceTag}|step=${f.lastSeenStep}] ${preview}`,
        );
      }
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

  estimateTokens(): number {
    return Math.ceil(this.formatForLLM().length / 4);
  }

  reset(): void {
    this._currentGoal = "";
    this._currentStep = 0;
    this._findings = [];
    this._activeFiles.clear();
    this._recentErrors = [];
    this._decisions = [];
    this._version = 0;
    this.logger.info("WorkingMemory", "Reset");
  }

  private evictOverflow(): void {
    if (this._findings.length <= this.config.maxFindings) return;

    this._findings.sort((a, b) => {
      if (a.importance !== b.importance) return importanceRank(a.importance) - importanceRank(b.importance);
      if (a.strength !== b.strength) return a.strength - b.strength;
      if (a.confidence !== b.confidence) return a.confidence - b.confidence;
      return a.lastSeenStep - b.lastSeenStep;
    });

    while (this._findings.length > this.config.maxFindings) {
      this._findings.shift();
    }
  }
}

function importanceRank(importance: Finding["importance"]): number {
  if (importance === "low") return 0;
  if (importance === "medium") return 1;
  return 2;
}

function importanceToDefaultConfidence(importance: Finding["importance"]): number {
  if (importance === "low") return 0.6;
  if (importance === "medium") return 0.78;
  return 0.9;
}

function importanceToDefaultStrength(importance: Finding["importance"]): number {
  if (importance === "low") return 6;
  if (importance === "medium") return 10;
  return 14;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
