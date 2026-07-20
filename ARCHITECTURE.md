# Thinking Agent — 技术架构文档

> **版本**: v0.4.6 | **语言**: TypeScript (ESM) | **运行时**: Node.js

---

## 目录

1. [项目概览](#1-项目概览)
2. [目录结构](#2-目录结构)
3. [核心模块及职责](#3-核心模块及职责)
4. [模块间依赖关系](#4-模块间依赖关系)
5. [关键设计模式](#5-关键设计模式)

---

## 1. 项目概览

**Thinking Agent** 是一个基于 ReAct（Reasoning + Acting）循环的 CLI 编码 Agent，用于学习 Agent 架构设计。它通过 LLM 驱动的工具调用循环来自主完成编码任务，包含任务规划、错误恢复、反思机制等完整的 Agent 能力体系。

**核心特性**：
- ReAct 循环驱动的任务执行
- 分级审批安全系统（READ → WRITE → EXECUTE → DESTRUCTIVE → BLOCKED）
- 结构化观察层（工具原始输出 → 结构化摘要）
- 状态机驱动的运行时管理
- 9 种错误分类 + 对应恢复策略
- 基于 LLM 的反思机制
- 可衰减、可溯源的工作记忆
- 上下文压缩与历史检查点
- 任务路由（DIRECT / PLAN 两种模式）
- 树形任务分解与依赖管理

---

## 2. 目录结构

```
src/
├── cli/                          # 命令行入口层
│   └── index.ts                  (357 行) — Commander CLI + REPL
│
├── core/                         # 核心引擎层（15 个模块）
│   ├── agent.ts                  (619 行) — Agent 主类 + ReAct 循环 + DoomLoopDetector
│   ├── approval-gateway.ts       (192 行) — 审批网关（工具执行守门人）
│   ├── context-assembler.ts      (340 行) — 上下文组装器（Token 预算管理）
│   ├── context-changelog.ts      ( 84 行) — 上下文变化日志
│   ├── error-taxonomy.ts         (268 行) — 错误分类与恢复策略
│   ├── history-checkpoints.ts    (135 行) — 历史摘要版本化
│   ├── history-compressor.ts     (248 行) — 历史压缩器（规则压缩，非 LLM）
│   ├── observation.ts            (626 行) — 观察层（6 个 Extractor + 管理器）
│   ├── reflection.ts             (301 行) — 反思引擎（失败分析 → 新策略）
│   ├── risk-assessor.ts          (239 行) — 风险评估器
│   ├── runtime-metrics.ts        (146 行) — 运行时度量采集
│   ├── state-machine.ts          (232 行) — 状态机（6 种执行状态）
│   ├── step-executor.ts          (264 行) — 步骤执行器（计划 → 执行桥梁）
│   ├── task-planner.ts           (853 行) — 任务规划器（树形分解）
│   ├── task-router.ts            (218 行) — 任务路由器（DIRECT / PLAN）
│   └── working-memory.ts         (407 行) — 工作记忆（可衰减、可溯源）
│
├── llm/                          # LLM 适配层
│   ├── openai-adapter.ts         (174 行) — OpenAI 兼容适配器
│   └── types.ts                  ( 32 行) — LLM 接口定义
│
├── tools/                        # 工具系统层
│   ├── types.ts                  ( 79 行) — 工具核心类型
│   ├── registry.ts               ( 67 行) — 工具注册表
│   ├── file-tools.ts             (260 行) — 文件操作工具（4 个）
│   ├── search-tools.ts           (232 行) — 搜索工具（3 个）
│   ├── shell-tool.ts             (161 行) — Shell 命令工具
│   ├── git-tools.ts              (242 行) — Git 操作工具（4 个）
│   └── index.ts                  ( 10 行) — 统一导出
│
└── utils/                        # 基础设施层
    ├── logger.ts                 (114 行) — 分级日志系统
    └── ui.ts                     (214 行) — CLI 终端 UI（chalk + gradient + boxen）
```

**总计**: ~20 个源文件，约 5,300 行 TypeScript 代码。

---

## 3. 核心模块及职责

### 3.1 入口层（cli/）

| 模块 | 职责 |
|------|------|
| **cli/index.ts** | CLI 入口，基于 Commander.js 构建。支持单次任务执行和 REPL 交互模式。负责组装所有依赖（LLM → Tools → Agent）、处理用户输入、渲染输出。提供 `wm`/`ctx`/`metrics`/`audit` 等调试子命令。 |

### 3.2 核心引擎层（core/）

#### 3.2.1 Agent 主循环

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **agent.ts** | **Agent 主类**。实现 ReAct 循环：组装上下文 → 调用 LLM → 解析 tool_call → 通过审批网关执行 → 观察结果 → 更新记忆 → 循环或终止。包含 `DoomLoopDetector`（死循环检测）和 `RunReport`（运行报告）。 | `Agent`, `DoomLoopDetector`, `AgentConfig`, `AgentState`, `RuntimeSnapshot`, `RunReport` |

**Agent 的核心依赖**（构造函数中创建）：
```
Agent
├── LLMAdapter          (外部注入)
├── ToolRegistry        (外部注入)
├── ApprovalGateway     (内部创建)
├── ObservationManager  (内部创建)
├── StateMachine        (内部创建)
├── ErrorTaxonomy       (内部创建)
├── ReflectionEngine    (内部创建)
├── WorkingMemory       (内部创建)
├── ContextAssembler    (内部创建)
├── TaskRouter          (可选，按需创建)
├── TaskPlanner         (可选，按需创建)
└── StepExecutor        (可选，按需创建)
```

#### 3.2.2 安全与审批

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **risk-assessor.ts** | **风险评估器**。纯逻辑模块，根据工具名和参数评估风险等级（READ/WRITE/EXECUTE/DESTRUCTIVE/BLOCKED），并决定审批策略（ALLOW/CONFIRM/DENY）。检测脚本语言绕过安全机制的行为。 | `RiskAssessor`, `RiskLevel`, `ApprovalDecision`, `RiskAssessment` |
| **approval-gateway.ts** | **审批网关**。工具执行的守门人，所有工具调用必须经过这里。根据风险等级做决策：READ 直接放行、WRITE 记录日志、EXECUTE 白名单校验、DESTRUCTIVE 调用用户确认回调、BLOCKED 直接拒绝。维护审计日志。 | `ApprovalGateway`, `ApprovalCallback` |

#### 3.2.3 观察与分析

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **observation.ts** | **观察层**。将工具原始输出转换为结构化观察（Observation）。包含 6 个专用 Extractor（GenericExtractor, FileReadExtractor, SearchExtractor, ShellExtractor, GitExtractor）+ 1 个 ObservationManager 统一管理。每个 Observation 包含 summary、severity、confidence、suggestedNextActions 等字段。 | `ObservationManager`, `Observation`, 5 个 Extractor 类 |
| **error-taxonomy.ts** | **错误分类与恢复**。9 种错误类型（tool_error, validation_error, permission_error, timeout, rate_limit, context_overflow, network_error, schema_error, hallucination），每种对应恢复策略（重试、重新生成参数、退避、压缩上下文、跳过重规划等）。基于关键词模式匹配分类，附带 confidence。 | `ErrorTaxonomy`, `ErrorType`, `RecoveryAction`, `ErrorClassification`, `RecoveryPlan` |

#### 3.2.4 状态管理

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **state-machine.ts** | **运行时状态机**。6 种状态：planning → executing → reflecting → recovering → completed / failed。管理当前目标、步骤记录、反思记录、Token 消耗。支持快照与恢复（Phase 4.7）。状态信息不进 LLM Prompt，独立管理以节省 Token。 | `StateMachine`, `ExecutionStatus`, `StepRecord`, `ReflectionRecord`, `StateSnapshot` |
| **working-memory.ts** | **工作记忆**。可衰减、可溯源的短期记忆系统。每条记忆带 source/confidence/lastSeenStep/strength。每步自动 decay（重要信息活得久，噪声自然消失）。高 severity 的 Observation 自动升权。同源覆盖：相同文件/来源的旧记忆被新证据替代。提供 `formatForLLM()`（全量）和 `formatForPlanning()`（精简）两种输出格式。 | `WorkingMemory`, `MemorySource`, `MemoryFinding` |
| **reflection.ts** | **反思引擎**。连续失败时触发自我反思。3 种触发条件：连续失败、步数过多、恢复策略耗尽、死循环。反思输出包含分析、诊断、新策略建议，注入下一轮 LLM 调用的 Prompt 引导换思路。 | `ReflectionEngine`, `ReflectionTrigger`, `ReflectionResult`, `ReflectionJSON` |

#### 3.2.5 上下文管理

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **context-assembler.ts** | **上下文组装器 v3**。负责将 system prompt + 压缩历史 + 最近对话 + Working Memory + State Snapshot 组装成最终发给 LLM 的消息列表。管理 Token 预算分配（contextWindowTokens - reserveForResponse）。在重大压缩时保存 checkpoint，记录 changelog。 | `ContextAssembler`, `ContextAssemblerConfig`, `AssembleReport` |
| **history-compressor.ts** | **历史压缩器**。用规则（非 LLM）将早期对话压缩为摘要。策略：最近 N 轮保持完整，更早的轮次提取关键信息（调了哪些工具、成功还是失败、核心结论）。更便宜、更快。 | `HistoryCompressor`, `CompressedHistory` |
| **history-checkpoints.ts** | **历史检查点管理器**。每次重大压缩时保存快照（step、contextVersion、summary、compressedCount），支持 Replay 某个历史版本。 | `HistoryCheckpointManager`, `HistoryCheckpoint` |
| **context-changelog.ts** | **上下文变化日志**。记录每次 assemble 发生了什么变化（添加/移除/压缩/替换），方便诊断"LLM 为什么突然换策略"，支持 context diff / replay。 | `ContextChangelog`, `ContextChangeEntry` |

#### 3.2.6 任务规划与执行

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **task-router.ts** | **任务路由器**。判断任务走 DIRECT 还是 PLAN 路径。DIRECT = 一次 Agent.run() 可完成；PLAN = 需要多阶段、产生中间产物。让 LLM 判断复杂度。 | `TaskRouter`, `RouteResult`, `RouteAnalysis` |
| **task-planner.ts** | **任务规划器**。四阶段规划：Goal Analysis → Dependency Discovery → Task Decomposition → Execution Plan。从"一次性拆分"改为"递归拆解"，从"线性列表"改为"树形结构"。停止标准：叶子任务是"一次执行即可完成的原子操作"。 | `TaskPlanner`, `GoalAnalysis`, `TaskNode`, `TaskStep`, `TaskPlan` |
| **step-executor.ts** | **步骤执行器**。TaskPlanner 和 Agent 之间的桥梁。按依赖顺序执行 TaskPlan 中的每个步骤，每步调用 Agent.run()。关键设计：每步前 resetForStep()（重置状态机但保留 Working Memory）。每步独立的 maxIterations（默认 10）。 | `StepExecutor`, `StepExecutionResult`, `PlanExecutionResult` |

#### 3.2.7 运行时度量

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **runtime-metrics.ts** | **运行时度量**。每次 Agent.run() 采集 run-level metrics：循环数、工具调用数、重试数、反思数、压缩数、Token 消耗、工具使用分布、错误分布、警告。方便对比不同策略效果。 | `RuntimeMetrics`, `RunMetricsSnapshot` |

### 3.3 LLM 适配层（llm/）

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **types.ts** | LLM 接口定义。`Message`（4 种角色：system/user/assistant/tool）、`LLMResponse`（content + toolCalls + usage）、`LLMAdapter` 接口（单方法 chat）。 | `Message`, `LLMResponse`, `LLMAdapter` |
| **openai-adapter.ts** | OpenAI 兼容适配器。实现 `LLMAdapter` 接口，处理流式 tool_call 分块累积、tool message 格式严格匹配、错误重试（指数退避）。支持自定义 apiKey/baseURL/model。 | `OpenAIAdapter` |

### 3.4 工具系统层（tools/）

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **types.ts** | 工具核心类型。`Tool` 接口（name + description + parameters JSON Schema + execute 函数），与 OpenAI function calling 协议对齐。`ToolResult`（success + data + error + tokenEstimate），`ToolCall`（id + name + arguments）。 | `Tool`, `ToolResult`, `ToolCall`, `ToolParameterSchema` |
| **registry.ts** | **工具注册表**。管理工具注册、查找、执行。`register()` 注册工具（不允许重名）、`getToolDefinitions()` 转换为 LLM 格式、`execute()` 查找+参数校验+调用。 | `ToolRegistry` |
| **file-tools.ts** | 文件操作工具集（4 个）：`file_summary`（结构摘要）、`read_file`（读取，支持行范围）、`write_file`（写入）、`list_dir`（目录列表，支持递归）。 | `fileSummaryTool`, `readFileTool`, `writeFileTool`, `listDirTool` |
| **search-tools.ts** | 搜索工具集（3 个）：`grep`（正则搜索，返回匹配位置）、`find_files`（按文件名模式查找）。 | `grepTool`, `findFilesTool`, `searchTools` |
| **shell-tool.ts** | Shell 命令工具（1 个）：`run_shell`。白名单命令机制 + 绝对阻断模式（如 `rm -rf /`）+ 需要审批的模式。 | `runShellTool`, `shellTools` |
| **git-tools.ts** | Git 操作工具集（4 个）：`git_status`、`git_diff`、`git_log`、`gitExec`（底层 git 命令执行）。 | `gitStatusTool`, `gitDiffTool`, `gitLogTool`, `gitTools` |

### 3.5 基础设施层（utils/）

| 模块 | 职责 | 关键类/接口 |
|------|------|------------|
| **logger.ts** | 分级日志系统。4 级：DEBUG/INFO/WARN/ERROR。单例模式（`initLogger` + `getLogger`）。支持文件输出。 | `Logger`, `LogLevel`, `initLogger`, `getLogger` |
| **ui.ts** | CLI 终端 UI 渲染。基于 chalk + gradient-string + boxen。提供 banner、welcome info、prompt、thinking、result、confirmation、metrics、error、risk level 等渲染函数。 | `theme`, `gradients`, `generateBanner`, `renderWelcomeInfo`, `renderPrompt`, `renderThinking`, `renderResult` 等 12 个函数 |

---

## 4. 模块间依赖关系

### 4.1 依赖图（模块级）

```
┌─────────────────────────────────────────────────────────────────┐
│                          cli/index.ts                           │
│                    (入口层：组装所有依赖)                         │
└──────┬──────────┬───────────┬───────────┬───────────┬───────────┘
       │          │           │           │           │
       ▼          ▼           ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  Agent   │ │ToolReg.  │ │OpenAI    │ │  Logger  │ │    UI    │
│          │ │          │ │Adapter   │ │          │ │          │
└──┬───┬───┘ └────┬─────┘ └────┬─────┘ └──────────┘ └──────────┘
   │   │          │             │
   │   │          │             ▼
   │   │          │      ┌──────────┐
   │   │          │      │llm/types │◄───────────────┐
   │   │          │      └──────────┘                │
   │   │          ▼                                   │
   │   │   ┌────────────┐                            │
   │   │   │ tools/types │◄──────────────────────┐   │
   │   │   └────────────┘                        │   │
   │   │          ▲                               │   │
   │   │          │                               │   │
   │   ▼          ▼                               │   │
   │  ┌─────────────────────────────────────────┐ │   │
   │  │             Agent (核心)                 │ │   │
   │  │                                         │ │   │
   │  │  ┌──────────┐  ┌──────────────────────┐ │ │   │
   │  │  │ Approval │  │  ObservationManager  │ │ │   │
   │  │  │ Gateway  │  │  (5个Extractor)      │ │ │   │
   │  │  └────┬─────┘  └──────────────────────┘ │ │   │
   │  │       │                                  │ │   │
   │  │       ▼                                  │ │   │
   │  │  ┌──────────┐                            │ │   │
   │  │  │  Risk    │                            │ │   │
   │  │  │ Assessor │                            │ │   │
   │  │  └──────────┘                            │ │   │
   │  │                                          │ │   │
   │  │  ┌──────────┐  ┌──────────┐  ┌────────┐ │ │   │
   │  │  │  State   │  │  Error   │  │Reflect.│ │ │   │
   │  │  │ Machine  │  │ Taxonomy │  │ Engine │ │ │   │
   │  │  └──────────┘  └──────────┘  └────────┘ │ │   │
   │  │                                          │ │   │
   │  │  ┌──────────────────────────────────┐    │ │   │
   │  │  │       WorkingMemory              │    │ │   │
   │  │  └──────────────────────────────────┘    │ │   │
   │  │                                          │ │   │
   │  │  ┌───────────┐  ┌───────────────────┐    │ │   │
   │  │  │  Context  │  │  HistoryCompress. │    │ │   │
   │  │  │ Assembler ├─►│  + Checkpoints    │    │ │   │
   │  │  │           │  │  + Changelog      │    │ │   │
   │  │  └───────────┘  └───────────────────┘    │ │   │
   │  │                                          │ │   │
   │  │  ┌──────────┐  ┌──────────┐  ┌────────┐ │ │   │
   │  │  │  Task    │  │  Task    │  │  Step  │ │ │   │
   │  │  │  Router  │  │ Planner  │  │Executor│ │ │   │
   │  │  └──────────┘  └──────────┘  └────────┘ │ │   │
   │  │                                          │ │   │
   │  │  ┌──────────────────────────────────┐    │ │   │
   │  │  │       RuntimeMetrics             │    │ │   │
   │  │  └──────────────────────────────────┘    │ │   │
   │  └──────────────────────────────────────────┘ │   │
   │                                               │   │
   │         ┌─────────────────────────────────────┘   │
   │         │                                         │
   ▼         ▼                                         │
┌──────────────────┐                                   │
│  Tools Layer     │                                   │
│ ┌──────────────┐ │     ┌──────────────────┐         │
│ │ file-tools   │─┼────►│  tools/types     │─────────┘
│ │ search-tools │ │     └──────────────────┘
│ │ shell-tool   │ │
│ │ git-tools    │ │
│ └──────────────┘ │
│ ┌──────────────┐ │
│ │  registry    │ │
│ └──────────────┘ │
└──────────────────┘
```

### 4.2 详细依赖矩阵

| 模块 | 依赖（内部） | 依赖（外部） |
|------|-------------|-------------|
| **Agent** | LLMAdapter, ToolRegistry, ToolCall, ApprovalGateway, ObservationManager, StateMachine, ErrorTaxonomy, ReflectionEngine, WorkingMemory, ContextAssembler, RuntimeMetrics, TaskRouter, TaskPlanner, StepExecutor, Logger | — |
| **ApprovalGateway** | ToolCall, ToolResult, ToolRegistry, RiskAssessor, Logger | — |
| **RiskAssessor** | ToolCall, Logger | — |
| **ObservationManager** | ToolCall, ToolResult, Logger | — |
| **ErrorTaxonomy** | ToolCall, ToolResult, Logger | — |
| **StateMachine** | Logger | — |
| **ReflectionEngine** | StepRecord, StateSnapshot, ErrorType, RecoveryAction, Logger | — |
| **WorkingMemory** | Logger | — |
| **ContextAssembler** | Message, StateMachine, WorkingMemory, HistoryCompressor, HistoryCheckpointManager, ContextChangelog, Logger | — |
| **HistoryCompressor** | Message, Logger | — |
| **HistoryCheckpointManager** | — | — |
| **ContextChangelog** | — | — |
| **TaskRouter** | LLMAdapter, Message, WorkingMemory, Logger | — |
| **TaskPlanner** | LLMAdapter, Message, WorkingMemory, Logger | — |
| **StepExecutor** | Agent(类型), TaskPlan, TaskStep, WorkingMemory, Logger | — |
| **RuntimeMetrics** | — | — |
| **OpenAIAdapter** | LLMAdapter, LLMResponse, Message, ToolCall | openai |
| **ToolRegistry** | Tool, ToolResult, ToolCall | — |
| **file-tools** | Tool, ToolResult | fs/promises, path |
| **search-tools** | Tool, ToolResult | fs/promises, path |
| **shell-tool** | Tool, ToolResult | child_process |
| **git-tools** | Tool, ToolResult | child_process |
| **CLI** | Agent, PlanExecutionResult, ToolRegistry, fileTools, searchTools, shellTools, gitTools, OpenAIAdapter, Logger, UI, ToolCall, RiskLevel | commander, readline, dotenv |

### 4.3 分层规则

```
层级（从上到下，依赖方向 ↓）:

L1: cli/          → 可依赖所有层
L2: core/agent    → 依赖 core/*、tools/*、llm/*
L3: core/*        → 依赖 tools/types、llm/types、utils/*、同层其他模块
L4: tools/        → 依赖 tools/types、Node.js 内置模块
L5: llm/          → 依赖 tools/types、llm/types、外部 SDK
L6: utils/        → 仅依赖 Node.js 内置模块和外部 UI 库
L7: types (tools/types, llm/types) → 无内部依赖，纯类型定义
```

---

## 5. 关键设计模式

### 5.1 ReAct 循环模式（Agent 核心）

**位置**: `core/agent.ts` → `Agent.run()`

这是整个系统的核心驱动力，实现了经典的 ReAct（Reasoning + Acting）范式：

```
用户输入
  │
  ▼
┌─────────────────────────────────────┐
│ 循环开始                              │
│  ① ContextAssembler 组装上下文        │
│  ② LLM.chat() 生成响应               │
│  ③ 解析 tool_calls                   │
│     ├─ 无 tool_calls → 返回最终回答    │
│     └─ 有 tool_calls ↓               │
│  ④ ApprovalGateway 审批每个 tool_call │
│  ⑤ 执行工具（通过 ToolRegistry）      │
│  ⑥ ObservationManager 处理原始输出    │
│  ⑦ WorkingMemory 更新记忆            │
│  ⑧ StateMachine 状态转移             │
│  ⑨ ErrorTaxonomy 分类失败            │
│  ⑩ DoomLoopDetector 检测死循环        │
│  ⑪ ReflectionEngine 判断是否需要反思  │
│  回到 ①                               │
└─────────────────────────────────────┘
```

**设计要点**：
- 状态信息不进 LLM Prompt（StateMachine 独立管理），节省 Token
- Working Memory 通过 `formatForLLM()` 注入上下文，提供关键发现
- 上下文压缩确保不会超出 Token 预算

### 5.2 注册表模式（Tool Registry）

**位置**: `tools/registry.ts`

```typescript
class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  
  register(tool: Tool): void;           // 注册工具（不允许重名）
  getToolDefinitions(): Array<...>;      // 转为 LLM function calling 格式
  async execute(toolCall: ToolCall): Promise<ToolResult>;  // 查找+校验+调用
  listTools(): string[];                 // 列出所有工具名
}
```

**设计要点**：
- 每个工具是"自描述"的：name + description + parameters JSON Schema + execute
- 与 OpenAI function calling 协议完全对齐，可直接发给 LLM
- 工具注册在启动时完成（CLI 层），运行时只查询和执行
- 参数校验（required 字段检查）在 Registry 层统一处理

### 5.3 网关/中间件模式（Approval Gateway）

**位置**: `core/approval-gateway.ts` + `core/risk-assessor.ts`

```
ToolCall → RiskAssessor.assess() → RiskLevel
                                      │
                                      ▼
                              ApprovalGateway.decide()
                                      │
                ┌──────┬──────┬───────┼───────┬───────┐
                ▼      ▼      ▼       ▼       ▼       ▼
              READ   WRITE  EXECUTE  CONFIRM  DENY   BLOCKED
              放行    记录   白名单   等用户   拒绝    拒绝
                                校验   确认
```

**设计要点**：
- **关注点分离**：RiskAssessor 是纯逻辑（可单元测试），ApprovalGateway 负责用户交互
- **审计日志**：每次工具调用都记录 riskLevel、result、duration
- **安全分层**：shell-tool 有自己的白名单和绝对阻断模式，ApprovalGateway 是第二层防线
- **可配置**：`enabled: false` 时全部放行（开发模式）

### 5.4 策略模式（Observation Extractors）

**位置**: `core/observation.ts`

```
ToolResult → ObservationManager.dispatch()
                    │
        ┌───────────┼───────────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼
  FileRead      Search      Shell        Git       Generic
  Extractor    Extractor   Extractor   Extractor   Extractor
```

**设计要点**：
- 每种工具有专用的 Extractor，知道如何从原始输出中提取关键信息
- GenericExtractor 作为兜底，处理未知工具的输出
- 所有 Extractor 统一输出 `Observation` 结构：summary + keyFindings + severity + confidence + suggestedNextActions
- 新增工具类型只需添加新 Extractor，不修改现有代码（开闭原则）

### 5.5 状态机模式（State Machine）

**位置**: `core/state-machine.ts`

```
                  ┌───────────────────────────┐
                  │                           │
                  ▼                           │
┌─────────┐  ┌──────────┐  ┌───────────┐  ┌──┴─────────┐
│ PLANNING ├─►│ EXECUTING ├─►│ REFLECTING ├─►│ RECOVERING │
└─────────┘  └─────┬────┘  └─────┬─────┘  └─────┬──────┘
                   │             │               │
                   ▼             ▼               ▼
            ┌───────────┐  ┌──────────┐         │
            │ COMPLETED │  │  FAILED  │◄────────┘
            └───────────┘  └──────────┘
```

**设计要点**：
- 6 种状态覆盖 Agent 执行的完整生命周期
- 状态信息独立于 LLM 对话历史（节省 Token）
- 记录完整的执行步骤（StepRecord）和反思记录（ReflectionRecord）
- 支持快照（snapshot）和恢复（loadSnapshot），用于 checkpoint/replay

### 5.6 错误分类与恢复模式（Error Taxonomy）

**位置**: `core/error-taxonomy.ts`

| 错误类型 | 恢复策略 | 最大重试 |
|---------|---------|---------|
| tool_error | 换路径/换工具 (RETRY_WITH_ALTERNATIVE) | 3 |
| validation_error | 重新生成参数 (REGENERATE_PARAMS) | 2 |
| permission_error | 申请审批或跳过 (REQUEST_PERMISSION / SKIP_AND_REPLAN) | 1 |
| timeout | 缩小范围重试 (RETRY_WITH_SMALLER_SCOPE) | 2 |
| rate_limit | 指数退避 (BACKOFF_AND_RETRY) | 3 |
| context_overflow | 压缩上下文 (COMPRESS_CONTEXT) | 1 |
| network_error | 简单重试 (SIMPLE_RETRY) | 3 |
| schema_error | 修正后重试 (CORRECT_AND_RETRY) | 2 |
| hallucination | 修正后重试 (CORRECT_AND_RETRY) | 2 |

**设计要点**：
- 基于关键词模式匹配快速分类，附带 confidence 评分
- 每种错误类型有明确的恢复策略、延迟时间、最大重试次数
- 恢复策略的 `hintForLLM` 字段会注入下一轮 Prompt，引导 LLM 自我修正
- 高 confidence 直接使用分类结果，低 confidence 降级到通用恢复策略

### 5.7 反思模式（Reflection Engine）

**位置**: `core/reflection.ts`

**触发条件**：
1. 同一目标连续失败 2 次
2. 总步数超过阈值但目标未完成
3. 恢复策略连续失败
4. DoomLoopDetector 检测到死循环

**反思输出**：
```json
{
  "reflection": "对当前情况的分析",
  "diagnosis": "失败的根本原因", 
  "newStrategy": "新的执行策略"
}
```

**设计要点**：
- 反思结果注入下一轮 LLM 调用的 Prompt，引导 Agent 换思路
- 反思引擎本身不做决策，只提供建议（LLM 仍然自主决定是否采纳）
- 反思触发由 StateMachine 和 DoomLoopDetector 协同检测

### 5.8 可衰减记忆模式（Working Memory with Decay）

**位置**: `core/working-memory.ts`

**记忆生命周期**：
```
Observation → addFinding() → 记忆创建（strength = 默认值）
    │
    ▼
每步执行 → decayAll() → strength -= decayPerStep
    │
    ▼
strength ≤ minStrength → 自动淘汰
```

**设计要点**：
- 每条记忆带完整溯源：source（工具名、文件路径、步骤 ID）、confidence、lastSeenStep、strength
- 高 severity / confidence 的 Observation 自动升权
- 同源覆盖：相同 file/source 的旧记忆可被新证据替代
- 两种输出格式：`formatForLLM()`（全量，用于对话上下文）和 `formatForPlanning()`（精简，用于任务规划）

### 5.9 上下文压缩模式（Context Assembly + Compression）

**位置**: `core/context-assembler.ts` + `core/history-compressor.ts`

```
完整对话历史
    │
    ▼
ContextAssembler.assemble()
    │
    ├── 最近 N 轮 → 保持完整
    ├── 更早的轮次 → HistoryCompressor 规则压缩为摘要
    ├── Working Memory → formatForLLM() 注入
    ├── State Snapshot → 注入
    └── Token 预算控制 → 超出时从旧到新丢弃消息
```

**设计要点**：
- **规则压缩而非 LLM 压缩**：更便宜、更快、更可控
- **Token 预算管理**：contextWindowTokens - reserveForResponse = 可用预算
- **历史检查点**：重大压缩时保存快照，支持 Replay
- **变化日志**：每次 assemble 记录变化原因，方便诊断

### 5.10 适配器模式（LLM Adapter）

**位置**: `llm/types.ts` + `llm/openai-adapter.ts`

```typescript
interface LLMAdapter {
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<LLMResponse>;
}

class OpenAIAdapter implements LLMAdapter {
  // 流式 tool_call 分块累积
  // tool message 格式严格匹配
  // 错误重试（指数退避）
}
```

**设计要点**：
- `LLMAdapter` 是单一方法的接口，极易替换为其他 LLM 提供商
- `OpenAIAdapter` 处理了流式响应中 tool_call 分块到达的复杂性
- 错误重试策略：可重试错误（429、500、502、503、504、网络错误）指数退避，不可重试错误直接抛出

### 5.11 任务分解模式（Task Decomposition）

**位置**: `core/task-router.ts` + `core/task-planner.ts` + `core/step-executor.ts`

```
用户目标
    │
    ▼
TaskRouter.route() → DIRECT / PLAN
    │                    │
    ▼                    ▼
Agent.run()        TaskPlanner.plan()
    │                    │
    │              ┌─────┴─────┐
    │              ▼           ▼
    │         Goal Analysis  Task Tree
    │              │           │
    │              ▼           ▼
    │         Dependency    Flatten to
    │         Discovery     Execution Steps
    │                          │
    │                          ▼
    │                   StepExecutor.execute()
    │                          │
    │                   ┌──────┼──────┐
    │                   ▼      ▼      ▼
    │               Step 1  Step 2  Step 3
    │               (each calls Agent.run())
    │                   │
    └───────────────────┘
```

**设计要点**：
- **路由分离**：TaskRouter 只判断"走哪条路"，TaskPlanner 只负责"如何规划"
- **树形分解**：从线性列表改为树形结构，支持并行执行
- **原子任务**：叶子节点是"一次执行即可完成的原子操作"
- **状态隔离**：StepExecutor 每步前 resetForStep()，但保留 Working Memory 跨步骤共享

### 5.12 死循环检测模式（Doom Loop Detector）

**位置**: `core/agent.ts` → `DoomLoopDetector`

```typescript
class DoomLoopDetector {
  private recentFailures: Map<string, number>;
  private threshold: number; // 默认 3

  record(toolCall: ToolCall, success: boolean): boolean;
  // 返回 true 表示检测到死循环
}
```

**设计要点**：
- 以 `toolName:arguments` 为 key 追踪失败次数
- 同一工具+同一参数连续失败达到阈值 → 触发 Doom Loop 检测
- 成功执行自动清除该工具的失败记录
- 检测到死循环后触发 ReflectionEngine 强制反思

### 5.13 运行时度量模式（Runtime Metrics）

**位置**: `core/runtime-metrics.ts`

```typescript
class RuntimeMetrics {
  // 采集维度：
  // - 循环数 (loops)
  // - 工具调用数 (toolCalls)
  // - 重试数 (retries)
  // - 反思数 (reflections)
  // - 压缩数 (compressions)
  // - Token 消耗 (promptTokens, completionTokens, totalTokens)
  // - 工具使用分布 (toolUsage: Record<string, number>)
  // - 错误分布 (failureCategories: Record<string, number>)
  // - 警告 (warnings: string[])
}
```

**设计要点**：
- Run-level 粒度，每次 Agent.run() 采集一份
- 支持不同策略效果对比
- 错误分布和工具使用分布帮助优化 Agent 行为
- RunReport 提供标准化输出，方便评估体系

---

## 附录：Phase 演进历史

| Phase | 主要特性 | 核心模块 |
|-------|---------|---------|
| Phase 1 | ReAct 循环 + 循环控制 + Doom Loop 检测 | agent.ts |
| Phase 2 | 审批网关 + 观察层 | approval-gateway.ts, risk-assessor.ts, observation.ts |
| Phase 3 | 状态机 + 错误分类 + 反思机制 | state-machine.ts, error-taxonomy.ts, reflection.ts |
| Phase 4 | 历史压缩 + 工作记忆 + 上下文组装 | history-compressor.ts, working-memory.ts, context-assembler.ts |
| Phase 4.5 | 结构化 Observation + Working Memory 衰减 | observation.ts(升级), working-memory.ts(升级) |
| Phase 4.6 | Runtime Metrics + History Checkpoints + Context Changelog | runtime-metrics.ts, history-checkpoints.ts, context-changelog.ts |
| Phase 4.7 | StateMachine 快照/恢复 | state-machine.ts(升级) |
| Phase 5 | 任务路由 + 树形分解 + 步骤执行 | task-router.ts, task-planner.ts, step-executor.ts |

---

*文档生成于 2025 年，基于 thinking-agent v0.4.6 源码分析。*
