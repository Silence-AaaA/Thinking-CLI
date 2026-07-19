# Phase 4.5 Context Engine Upgrade 完成报告

## 背景

你指出的问题非常准确：Phase 4 只完成了“能组装上下文”，但没完成：
- 谁决定记忆该留下
- Observation 是否足够结构化
- Context 是否可解释
- 是否有版本/诊断能力

因此这次不是继续往 Phase 5 冲，而是回头补 **Context Engineering 的核心能力**。

## 本次完成的三件核心升级

### 1. Observation 结构化载荷

把 Observation 从“文本摘要”升级为“结构化决策载荷”。

新增字段：
- `status`
- `severity`
- `confidence`
- `structuredPayload`
- `suggestedNextActions[]`
- `source`

目标：让下游模块（WM / Reflection / Recovery）都能基于机器可读信号工作。

## 2. Working Memory v2

把 Working Memory 从“记录型”升级为“演化型记忆系统”。

核心变化：
- 每条 finding 带 `source / confidence / strength / lastSeenStep`
- 每步自动 `tickStep()` 进行衰减
- 支持 `reinforceByFile()` / `demoteByFile()`
- memory 有 `version`

目标：实现你要求的：
- A 降权
- B 降权
- C 升权
- 信息不是一直存在，而是随时间衰减

## 3. Context Assembler v2

把 Context Assembler 从“拼消息”升级为“可解释的上下文引擎”。

新增：
- `AssembleReport`
- `contextVersion`
- `sections[]`
- `compressedMessages`
- `droppedForBudget`
- `warnings[]`

目标：回答你提的关键问题：
- 12000 tokens 为什么是这样拼出来的？
- WM 占多少？history 占多少？summary 占多少？
- 是被压缩了还是被裁剪了？

## 测试结果

Phase 4.5 测试通过：`52/52`
全量回归测试：`0 failures`

关键测试覆盖：
- Working Memory decay / reinforce / demote
- WM version 递增
- Context Assembler report 正确
- contextVersion 递增
- 空 WM 不注入
- 压缩触发正确

## 关键文件

### 新增/重写
- `src/core/observation.ts`
- `src/core/working-memory.ts`
- `src/core/context-assembler.ts`
- `src/test-phase4.ts`

### 修改
- `src/core/agent.ts`
- `src/cli/index.ts`
- `package.json`
- `docs/roadmap.md`
- `docs/decisions/ADR-013`
- `docs/decisions/ADR-014`
- `docs/decisions/ADR-015`

## 结论

这次升级的意义是：

> Phase 4 从“Context Assembly”升级为“Context Engine”。

也就是说：
- 之前是：能把上下文拼好
- 现在是：上下文可解释、可演化、可诊断

## 下一步建议

现在可以更稳地进入 Phase 5，因为：
- Observation 更结构化
- Working Memory 更真实
- Context Assembler 有诊断能力

下一步最自然的是：
1. **State Runtime Snapshot 加强**（更接近 checkpoint/resume）
2. **History Summary Checkpointing**
3. **Runtime Metrics / Run Report**
4. 然后再做 Phase 5 Planning
