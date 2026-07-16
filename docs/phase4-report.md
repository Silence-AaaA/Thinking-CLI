# Phase 4 Context Engineering 完成报告 — 上下文工程

## 设计决策

**核心思路**：不是把所有信息都塞给 LLM，而是精心组织"送什么、按什么顺序、多大体积"。

```
之前：this.llm.chat(this.state.messages)  ← 原始流水账

现在：
  ContextAssembler.assemble(rawMessages, workingMemory, stateMachine)
      ↓
  ┌─────────────────────────────────────┐
  │ System Prompt                       │
  │ Working Memory  ← 当前目标+关键发现  │
  │ State Snapshot  ← 状态机关键字段     │
  │ Recent History  ← 最近 N 轮完整对话  │
  │ Summary         ← 早期对话压缩版     │
  └─────────────────────────────────────┘
      ↓
  this.llm.chat(assembled.messages)
```

## 新增模块

### 1. Working Memory — 工作记忆

**文件**: `src/core/working-memory.ts`

5 类结构化信息：
- `currentGoal` — 当前任务目标
- `findings` — 关键发现（带 importance: low/medium/high + 来源）
- `activeFiles` — 涉及的文件列表
- `recentErrors` — 最近 5 条错误
- `decisions` — 做过的决策（最近 10 条）

**核心设计**：
- 重要度分级 → 超限时自动淘汰低重要度发现
- Agent 主循环自动更新（不依赖 LLM 自己管理）
- 每轮注入 prompt，确保关键信息不丢失

### 2. History Compressor — 历史压缩

**文件**: `src/core/history-compressor.ts`

**策略**：规则压缩（不用 LLM），按轮次分割
- 最近 N 轮（默认 5）：完整保留
- 更早的轮次：压缩为结构化摘要

**每轮提取**：
- 用户输入（前 100 字符）
- 助手调用的工具名列表
- 工具结果第一行（前 100 字符）
- 助手回复（前 150 字符）

**为什么不用 LLM 压缩**：
- 压缩发生在每轮 LLM 调用之前，不能引入额外延迟
- 规则压缩毫秒级完成，LLM 压缩需要 1-2 秒
- 规则压缩免费，LLM 压缩消耗 token

### 3. Context Assembler — 上下文组装器

**文件**: `src/core/context-assembler.ts`

**分层组装**：
1. System Prompt — 角色 + 规则（不变）
2. Working Memory — 当前目标 + 关键发现（每轮更新）
3. State Snapshot — 状态机关键字段（每轮更新）
4. Recent History — 最近 N 轮完整对话
5. Summary — 早期对话压缩版（长对话时触发）

**安全机制**：
- Token 上限保护：超过上下文窗口自动截断
- 空 Working Memory 不注入（避免浪费空间）
- 组装统计：消息数、压缩数、token 估算

## Agent 主循环改造

**核心变化**：`llm.chat()` 调用从直接传 `this.state.messages` 改为经过 Context Assembler 组装。

```typescript
// 之前
const response = await this.llm.chat(this.state.messages, tools);

// 现在
const assembled = this.contextAssembler.assemble(
  this.state.messages, this.workingMemory, this.stateMachine
);
const response = await this.llm.chat(assembled.messages, tools);
```

**Working Memory 自动更新点**：
- 工具成功 → `addFinding()` + `addActiveFile()`
- 工具失败 → `addError()`
- 重置时 → `reset()`

## CLI 更新

新增 REPL 命令：
- `wm` — 查看 Working Memory 状态（目标、发现、文件、错误、决策）
- `ctx` — 查看上下文组装统计（消息数、压缩数、token 估算）

## 测试结果

```
Working Memory:      18/18 通过 ✅
History Compressor:  10/10 通过 ✅
Context Assembler:    8/8  通过 ✅
───────────────────────────────
总计:                36/36 通过 ✅
全量回归:            0 失败  ✅
```

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/working-memory.ts` | 新增 | 工作记忆 |
| `src/core/history-compressor.ts` | 新增 | 历史压缩 |
| `src/core/context-assembler.ts` | 新增 | 上下文组装器 |
| `src/core/agent.ts` | 修改 | 集成 WM + Assembler |
| `src/cli/index.ts` | 修改 | 新增 wm/ctx 命令 |
| `src/test-phase4.ts` | 新增 | 36 个测试用例 |
| `package.json` | 修改 | 新增 test:phase4 |
| `docs/roadmap.md` | 修改 | Phase 4 标记完成 |
| `docs/decisions/ADR-010` ~ `012` | 新增 | 3 篇 ADR |
| `docs/phase4-report.md` | 新增 | 本报告 |

## 下一步

Phase 5: Planning — 任务规划
- Task Planner（任务分解）
- Step Executor（步骤执行）
- Dynamic Replanner（动态重规划）
