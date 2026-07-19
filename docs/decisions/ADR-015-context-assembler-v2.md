# ADR-015: Context Assembler v2（可解释组装）

> Phase 4.5 | 状态：已实现

## 背景

Phase 4 的 Context Assembler 已经能把上下文重新组装，但缺少“解释能力”：
- 不知道 Prompt 为什么这么拼
- 不知道各部分占了多少 token
- 不知道压缩/裁剪发生在哪

## 决策

Assembler 输出 `AssembledContext.report`，包含：

- `contextVersion`
- `totalMessages`
- `estimatedTotalTokens`
- `compressedMessages`
- `droppedForBudget`
- `injectedMemory / injectedState`
- `sections[]`：每段 name / messageCount / estimatedTokens / note
- `warnings[]`

## 为什么不只保留 stats

stats 是“结果”，report 是“诊断过程”。  
以后优化 agent 的核心不是看最终 token，而是看：
- 是 WM 太重？
- 是 history 没压住？
- 是被 budget 强制裁剪？

## 关键收益

- 调优可解释
- 上下文变化可追踪（contextVersion）
- 为未来 checkpoint / replay 提供审计基础

## 关键文件

- `src/core/context-assembler.ts`
- `src/cli/index.ts`
- `src/test-phase4.ts`
