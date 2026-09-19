/**
 * 能力档位系统 (Capability Profiles)
 *
 * 用户可以通过 --capability low|medium|high|max 调整主模型的"思考深度"
 * 模型本身不变，变的是：温度、迭代上限、系统提示词深度
 *
 * 【设计哲学】
 * 同一个模型，通过参数调节能表现出不同的"能力"：
 * - low    : 低温、少迭代、简洁回答 → 快速问答
 * - medium : 平衡参数 → 日常编程
 * - high   : 高温、多迭代、深度推理 → 复杂任务
 * - max    : 最大探索、最多迭代 → 极限推理
 */

export type CapabilityLevel = "low" | "medium" | "high" | "max";

export interface CapabilityProfile {
  /** 档位名称 */
  level: CapabilityLevel;
  /** 显示标签 */
  label: string;
  /** 描述 */
  description: string;
  /** 最大 ReAct 迭代次数 */
  maxIterations: number;
  /** 是否默认使用规划模式 */
  preferPlanned: boolean;
  /** 温度参数 */
  temperature: number;
  /** 系统提示词追加指令 */
  systemPromptSuffix: string;
  /** 颜色标识（给 UI 用） */
  color: string;
  /** 图标 */
  icon: string;
}

export const CAPABILITY_PROFILES: Record<CapabilityLevel, CapabilityProfile> = {
  low: {
    level: "low",
    label: "Low",
    description: "Quick & concise — simple questions, fast replies",
    maxIterations: 8,
    preferPlanned: false,
    temperature: 0.2,
    systemPromptSuffix:
      "\n\n## Mode: Quick\n- Be concise. Short answers.\n- Skip unnecessary exploration.\n- Answer directly if you know the answer.",
    color: "#60efff",
    icon: "🟢",
  },
  medium: {
    level: "medium",
    label: "Medium",
    description: "Balanced — daily coding tasks",
    maxIterations: 20,
    preferPlanned: false,
    temperature: 0.5,
    systemPromptSuffix: "",
    color: "#00f5ff",
    icon: "🔵",
  },
  high: {
    level: "high",
    label: "High",
    description: "Deep reasoning — complex refactors & architecture",
    maxIterations: 40,
    preferPlanned: true,
    temperature: 0.7,
    systemPromptSuffix:
      "\n\n## Mode: Deep Reasoning\n- Think step-by-step before acting.\n- Consider edge cases and alternatives.\n- Use planning mode for multi-file changes.\n- Verify every change thoroughly.",
    color: "#a855f7",
    icon: "🟣",
  },
  max: {
    level: "max",
    label: "Max",
    description: "Maximum power — hardest problems, no compromise",
    maxIterations: 60,
    preferPlanned: true,
    temperature: 0.9,
    systemPromptSuffix:
      "\n\n## Mode: Maximum Power\n- Exhaustive analysis before action.\n- Always verify every change with tests.\n- Use multiple approaches if the first fails.\n- Think about security, performance, and maintainability.\n- Leave no edge case unchecked.",
    color: "#ff00e5",
    icon: "🔴",
  },
};

/** 获取能力档位，如果无效则返回 medium */
export function getCapabilityProfile(level: string): CapabilityProfile {
  const key = level.toLowerCase() as CapabilityLevel;
  return CAPABILITY_PROFILES[key] ?? CAPABILITY_PROFILES.medium;
}

/** 获取所有可用档位列表 */
export function listCapabilities(): CapabilityProfile[] {
  return Object.values(CAPABILITY_PROFILES);
}
