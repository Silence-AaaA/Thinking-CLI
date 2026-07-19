# ADR-018: Context Changelog 设计

> Phase 4.6 | 状态：已实现

## 背景

Context 每轮都在变，但如果没有 changelog，很难解释：
- 为什么 v12 和 v13 不同
- 为什么 LLM 突然换策略
- 为什么 token 突然变多/变少

## 决策

每次 assemble 记录一条 changelog entry：
- contextVersion
- step
- memoryVersion
- injectedMemory / injectedState
- compressedMessages
- droppedForBudget
- changedBecause
- estimatedTotalTokens

## 为什么不只保留最新 report

report 描述“当前这一次”，changelog 描述“变化链路”。  
以后做 `ctxdiff`、`replay`、`explainability` 都需要 changelog。

## 关键文件

- `src/core/context-changelog.ts`
- `src/core/context-assembler.ts`
- `src/cli/index.ts`
