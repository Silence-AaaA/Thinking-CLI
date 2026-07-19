# Thinking Agent — 系统架构设计

> 版本: v2.1 | 日期: 2026-07-19
> 基于"能力域"模型重新组织，替代原有的"问题驱动"路线
> Phase 1-4.7 已全部实现，Phase 5-8 待实施

---

## 一、设计理念

### 从"解决问题"到"构建能力"

早期版本按问题排 Phase：Phase 3 解决审批、Phase 6 解决压缩……
问题是：问题之间没有结构性关系，解决一个不会帮助解决下一个。

新框架按**能力域**组织：每个 Phase 构建一个独立的能力层，
层与层之间有明确的依赖关系，上层依赖下层。

```
用户
 │
 ▼
┌─────────────────────────────────────────────┐
│  Phase 5: Planning                          │  ← 复杂任务分解 (待实施)
│  (Planner / Executor / Replan)              │
├─────────────────────────────────────────────┤
│  Phase 3: Execution Engine                  │  ← 可靠执行 ✅
│  (State Machine / Reflection / Recovery)    │
├─────────────────────────────────────────────┤
│  Phase 4: Context Engineering               │  ← 信息管理 ✅
│  (Compression / Working Memory / Assembler) │
├─────────────────────────────────────────────┤
│  Phase 2: Tool System                       │  ← 能力边界 ✅
│  (Schema / Validation / Observation)        │
├─────────────────────────────────────────────┤
│  Phase 1: Agent Loop                        │  ← 基础循环 ✅
│  (LLM / Tool / Loop Control)               │
├─────────────────────────────────────────────┤
│  Phase 6: Memory                            │  ← 横切关注点 (待实施)
│  Phase 7: Reliability                       │  ← 横切关注点 (待实施)
│  Phase 8: Production                        │  ← 横切关注点 (待实施)
└─────────────────────────────────────────────┘
```

### 四个关键词

整个框架围绕 4 个核心概念展开：

| 关键词 | 含义 | 对应 Phase | 状态 |
|--------|------|-----------|------|
| **State** | Agent 的运行时状态，不进 Prompt | Phase 3 | ✅ 已实现 |
| **Context** | 送给 LLM 的信息，需要精心管理 | Phase 4 | ✅ 已实现 |
| **Observation** | 工具原始输出的结构化提取 | Phase 2 | ✅ 已实现 |
| **Evaluation** | 衡量 Agent 行为好不好 | Phase 7 | ⬜ 待实施 |

---

## 二、Phase 总览

### Phase 1: Agent Loop — 基础循环 ✅

**能力**: LLM 调用 → 工具选择 → 执行 → 反馈 → 循环

**子模块**:
- LLM Adapter（模型调用抽象）✅
- Loop Controller（循环控制、最大步数）✅
- Doom Loop Detector（重复失败检测）✅

**关键决策**:
- ADR-001: ReAct 循环而非 Chain-of-Thought（需要"边做边想"）
- ADR-002: Doom Loop 阈值默认 3（同操作失败 3 次 → 强制跳出）
- ADR-003: LLM 适配层隔离（换模型不改循环逻辑）

**文件**:
- `src/core/agent.ts` — ReAct 循环 + Doom Loop Detector
- `src/llm/openai-adapter.ts` — LLM 适配器
- `src/llm/types.ts` — 接口定义

---

### Phase 2: Tool System — 能力边界 ✅

**能力**: 工具定义、注册、校验、风险评估、观察提取

**子模块**:
- Tool Schema（JSON Schema 定义）✅
- Tool Registry（注册与发现）✅
- Parameter Validation（参数校验）✅
- Risk Assessment（风险评估）✅
- Observation Layer（观察层）✅
- Approval Gateway（审批网关）✅

**关键决策**:
- ADR-004: Token 经济学（先 grep 后 read，先 summary 后全文）
- ADR-005: 4 级审批策略（auto-confirm → ask-once → always-ask → deny）
- ADR-006: Observation 结构化提取（severity、pattern、suggestion）

**文件**:
- `src/tools/registry.ts` — 注册表
- `src/tools/types.ts` — 接口定义
- `src/tools/file-tools.ts` — 文件工具（read_file, write_file, list_dir, file_summary）
- `src/tools/search-tools.ts` — 搜索工具（grep）
- `src/tools/git-tools.ts` — Git 工具（git_status, git_diff, git_log）
- `src/tools/shell-tool.ts` — Shell 工具
- `src/core/risk-assessor.ts` — 风险评估
- `src/core/approval-gateway.ts` — 审批网关
- `src/core/observation.ts` — 观察层

---

### Phase 3: Execution Engine — 可靠执行 ✅

**能力**: 状态管理、错误恢复、反思机制

**子模块**:
- State Machine（状态机）✅ — 6 种状态 + 转换校验
- Error Taxonomy（错误分类）✅ — 错误类型 → 恢复策略映射
- Reflection Engine（反思机制）✅ — 数据驱动触发 + 结构化反思 prompt
- Runtime Snapshot（运行时快照）✅ — checkpoint / resume / replay

**状态模型**:
```
planning → executing → reflecting → recovering → completed / failed
```

**关键决策**:
- ADR-007: State 不进 Prompt（状态机独立于对话历史，不浪费 token）
- ADR-008: 错误分类驱动恢复（file_not_found → 列目录，permission → 换路径，timeout → 缩范围）
- ADR-009: 反思是"数据驱动"而非"感觉驱动"（看连续失败次数、步数、恢复失败次数）
- ADR-019: Runtime Snapshot 全量快照（不只存 messages，包含 state machine + working memory + reflection）

**文件**:
- `src/core/state-machine.ts` — 状态机 + loadSnapshot()
- `src/core/error-taxonomy.ts` — 错误分类与恢复策略
- `src/core/reflection.ts` — 反思引擎 + toJSON()/loadJSON()

---

### Phase 4: Context Engineering — 信息管理 ✅

**能力**: 送给 LLM 的信息精心管理，不溢出、不丢失、可追溯

**核心理念**: 不是"压缩"，是"工程"

```
┌──────────────────────────────────────────┐
│           Context 组成                    │
│                                          │
│  System Prompt     ← 角色 + 规则         │
│  Working Memory    ← 当前任务的关键信息   │
│  Recent History    ← 最近几轮对话         │
│  Summary           ← 早期对话的压缩版     │
│  State Snapshot    ← 状态机的关键字段     │
│                                          │
│  总量必须 < 上下文窗口                    │
└──────────────────────────────────────────┘
```

#### Phase 4 核心 ✅

| 模块 | 职责 |
|------|------|
| Context Assembler | 分层组装 context + token 上限保护 |
| History Compressor | 规则压缩（不用 LLM，确定性、零成本） |
| Working Memory | 结构化关键信息（findings、active files、errors） |

**关键决策**:
- ADR-010: Working Memory 存"当前任务的关键信息"，不是"所有信息"
- ADR-011: 规则压缩而非 LLM 压缩（确定性、零成本、不引入幻觉）
- ADR-012: Context 分层组装（每层有明确职责，总量 < 上下文窗口）

#### Phase 4.5 升级 ✅

| 改进 | 内容 |
|------|------|
| Working Memory v2 | 每条记忆带 source/confidence/strength/lastSeenStep，每步自动衰减 |
| Observation 结构化载荷 | severity / confidence / pattern / suggestion |
| Context Assembler v2 | 可解释组装：每次 assemble 输出 report |

**关键决策**:
- ADR-013: Observation 结构化载荷（不再只是纯文本）
- ADR-014: 衰减机制（重要信息活得久，噪声自然消失）+ 同源覆盖
- ADR-015: 可解释组装（不只知道"送了什么"，还知道"为什么这么送"）

#### Phase 4.6 Runtime ✅

| 模块 | 职责 |
|------|------|
| Runtime Metrics | 每次 run 采集：loops、tokens、tool usage、failure categories |
| History Checkpoints | 重大压缩时保存 summary 快照 |
| Context Changelog | 每次 assemble 记录变化原因 |

**关键决策**:
- ADR-016: Metrics 是"运行结果指标"，Logger 是"过程日志"
- ADR-017: Checkpoint 是"关键节点快照"不是"每步全量备份"
- ADR-018: Changelog 记录"为什么变了"（可诊断 LLM 策略变化）

#### Phase 4.7 State Runtime Enhancement ✅

| 模块 | 职责 |
|------|------|
| Runtime Snapshot | 全量运行时快照（agent + state machine + working memory + reflection） |
| Checkpoint Diff | 比较两个 checkpoint 的 summary 变化（逐行 +/- 格式） |
| Run Report Export | 标准化 JSON 报告（goal、status、steps、tokens、tool usage、failures） |

**关键决策**:
- ADR-019: Snapshot 包含全量状态（不只 messages）
- ADR-020: 行级 diff 而非语义 diff（简单、确定、零成本）
- ADR-021: RunReport 是"面向评估的视图"，不暴露 RuntimeMetrics 内部细节

**文件（Phase 4 全部）**:
- `src/core/context-assembler.ts` — 上下文组装器
- `src/core/history-compressor.ts` — 历史压缩器
- `src/core/working-memory.ts` — 工作记忆 + loadSnapshot()
- `src/core/history-checkpoints.ts` — 历史检查点 + diff()
- `src/core/context-changelog.ts` — 上下文变更日志
- `src/core/runtime-metrics.ts` — 运行时度量

---

### Phase 5: Planning — 任务规划 ⬜

**能力**: 复杂任务分解、执行监控、动态重规划

**子模块**:
- **Task Planner（任务分解）** ⬜
- **Step Executor（步骤执行）** ⬜
- **Dynamic Replanner（动态重规划）** ⬜

**三层规划**:
```
Task Planning（用户任务 → 步骤列表）
    ↓
Execution Planning（每个步骤 → 工具调用序列）
    ↓
Dynamic Replanning（执行中发现问题 → 调整计划）
```

**详细任务计划**: 见 [Phase 5 任务计划](./phase-5-planning-tasks.md)

**文件（待创建）**:
- `src/core/task-planner.ts`
- `src/core/step-executor.ts`
- `src/core/replanner.ts`

---

### Phase 6: Memory — 记忆系统 ⬜

**能力**: 会话内记忆、长期记忆、项目记忆

**三层记忆**:
```
Session Memory（当前对话，自动管理）
    ↓
Project Memory（当前项目，如 AGENTS.md）
    ↓
Long-term Memory（跨项目，持久化存储）
```

**文件（待创建）**:
- `src/memory/session.ts`
- `src/memory/project.ts`
- `src/memory/long-term.ts`

---

### Phase 7: Reliability — 可靠性 ⬜

**能力**: 评估、观测、预算管理

**子模块**:
- **Evaluation（评估体系）** ⬜
- **Telemetry（观测系统）** ⬜
- **Budget Manager（预算管理）** ⬜

**评估体系**:

| 指标 | 含义 |
|------|------|
| Success Rate | 任务完成率 |
| Tool Accuracy | 工具选择正确率 |
| Loop Count | 平均循环次数 |
| Cost Per Task | 每任务平均成本 |
| Latency | 平均响应时间 |

**文件（待创建）**:
- `src/reliability/evaluator.ts`
- `src/reliability/telemetry.ts`
- `src/reliability/budget.ts`

---

### Phase 8: Production — 生产级 ⬜

**能力**: MCP 集成、安全增强、多 Agent

**子模块**:
- MCP Server 集成
- 安全沙盒增强
- 多 Agent 协作
- 插件系统

**文件（待创建）**:
- `src/production/mcp.ts`
- `src/production/sandbox.ts`
- `src/production/multi-agent.ts`

---

## 三、已有代码映射

| 文件 | 对应 Phase | 状态 |
|------|-----------|------|
| `src/core/agent.ts` | Phase 1 + 4.7 | ✅ ReAct 循环 + snapshot/restore/exportRunReport |
| `src/llm/openai-adapter.ts` | Phase 1 | ✅ LLM 适配器 |
| `src/llm/types.ts` | Phase 1 | ✅ 接口定义 |
| `src/tools/registry.ts` | Phase 2 | ✅ 工具注册表 |
| `src/tools/types.ts` | Phase 2 | ✅ 工具接口 |
| `src/tools/file-tools.ts` | Phase 2 | ✅ 文件工具 |
| `src/tools/search-tools.ts` | Phase 2 | ✅ 搜索工具 |
| `src/tools/git-tools.ts` | Phase 2 | ✅ Git 工具 |
| `src/tools/shell-tool.ts` | Phase 2 | ✅ Shell 工具 |
| `src/core/risk-assessor.ts` | Phase 2 | ✅ 风险评估 |
| `src/core/approval-gateway.ts` | Phase 2 | ✅ 审批网关 |
| `src/core/observation.ts` | Phase 2 | ✅ 观察层 |
| `src/core/state-machine.ts` | Phase 3 | ✅ 状态机 + loadSnapshot |
| `src/core/error-taxonomy.ts` | Phase 3 | ✅ 错误分类 |
| `src/core/reflection.ts` | Phase 3 | ✅ 反思引擎 + toJSON/loadJSON |
| `src/core/context-assembler.ts` | Phase 4 | ✅ 上下文组装器 |
| `src/core/history-compressor.ts` | Phase 4 | ✅ 历史压缩器 |
| `src/core/working-memory.ts` | Phase 4 | ✅ 工作记忆 + loadSnapshot |
| `src/core/history-checkpoints.ts` | Phase 4.6 | ✅ 历史检查点 + diff |
| `src/core/context-changelog.ts` | Phase 4.6 | ✅ 上下文变更日志 |
| `src/core/runtime-metrics.ts` | Phase 4.6 | ✅ 运行时度量 |
| `src/utils/logger.ts` | Phase 7 (基础) | ✅ 日志工具 |
| `src/cli/index.ts` | Phase 8 (基础) | ✅ CLI 入口 |

---

## 四、实施顺序

```
✅ Phase 1: Agent Loop（已完成）
✅ Phase 2: Tool System（已完成）
✅ Phase 3: Execution Engine（已完成）
✅ Phase 4: Context Engineering（已完成，含 4.5/4.6/4.7）

⬜ Phase 5: Planning — 任务规划（下一步）
⬜ Phase 6: Memory — 记忆系统
⬜ Phase 7: Reliability — 可靠性
⬜ Phase 8: Production — 生产级
```

每个 Phase 完成后都可以独立运行、独立测试、独立增强。
