# Thinking Agent - 架构学习手册

## 项目定位

这不是一个"能跑就行"的项目。这是一个**让你深入理解 Agent 系统设计**的学习项目。
每一行代码都有其存在的理由，每一个设计决策都对应着一个 Agent 领域的核心问题。

## 核心架构：分层设计

```
┌─────────────────────────────────────────────┐
│                  CLI Layer                   │  ← 用户交互入口
│         (commander + REPL + streaming)       │
├─────────────────────────────────────────────┤
│               Agent Core Layer               │  ← 大脑：推理循环
│    (ReAct Loop / Planner / Context Mgr)      │
├─────────────────────────────────────────────┤
│               Tool System Layer              │  ← 手脚：执行能力
│      (Registry / Schema / Execution)         │
├─────────────────────────────────────────────┤
│             LLM Adapter Layer                │  ← 统一接口，模型可换
│        (OpenAI / Local / Compatible)         │
├─────────────────────────────────────────────┤
│            Infrastructure Layer              │  ← 日志/安全/配置
│       (Logger / Sandbox / Config)            │
└─────────────────────────────────────────────┘
```

## 模块职责

### 1. CLI Layer (`src/cli/`)
- 解析命令行参数
- REPL 模式（持续对话）
- 流式输出（token 到了就显示，不等全部生成完）

### 2. Agent Core (`src/core/`)
- **AgentLoop**: ReAct 循环的核心实现
- **Planner**: 任务分解与规划（Plan-then-Execute 模式）
- **ContextManager**: 上下文窗口管理，token 经济学
- **Memory**: 对话历史、文件缓存、检索

### 3. Tool System (`src/tools/`)
- **ToolRegistry**: 工具注册表，管理所有可用工具
- **Tool interface**: 统一的工具定义（name, description, schema, execute）
- **内置工具**: read_file, write_file, search, shell, git

### 4. LLM Adapter (`src/llm/`)
- 统一接口，屏蔽不同模型的差异
- 支持 function calling / tool use 协议
- 流式输出支持

### 5. Infrastructure (`src/utils/`)
- **Logger**: 结构化日志，每步都记录
- **Sandbox**: 文件访问控制，命令白名单
- **Config**: 配置管理

## 推理模式详解

### 模式 1: ReAct（Reasoning + Acting）
**适用场景**: 大多数任务，特别是需要探索的任务
**流程**: Think → Act → Observe → Think → ...

```typescript
// 伪代码
while (!done) {
  const thought = await llm.think(conversationHistory);
  // thought 包含: reasoning + tool_call
  
  if (thought.tool_call) {
    const result = await tools.execute(thought.tool_call);
    conversationHistory.addObservation(result);
  } else {
    // LLM 认为可以给出最终答案了
    return thought.answer;
  }
}
```

**学习要点**:
- LLM 通过 JSON 输出"下一步要做什么"
- 工具结果作为"观察"喂回给 LLM
- 循环直到 LLM 认为任务完成

### 模式 2: Plan-then-Execute
**适用场景**: 复杂多步骤任务，需要全局规划
**流程**: Plan → Execute Step 1 → Execute Step 2 → ...

```typescript
// 伪代码
const plan = await llm.createPlan(userTask);
// plan = ["1. 找到入口文件", "2. 分析函数调用", "3. 定位 bug"]

for (const step of plan) {
  const result = await executeStep(step);
  // 每步执行后可以调整后续计划
}
```

**学习要点**:
- 先让 LLM 列出步骤，再逐步执行
- 每步执行后可以"重新规划"（应对意外）
- 适合"我需要先了解全局再动手"的场景

### 模式 3: Reflexion（自我检查）
**适用场景**: 对结果质量要求高，需要自我纠错
**流程**: Execute → Reflect → Refine → ...

```typescript
// 伪代码
let result = await execute(task);
const reflection = await llm.reflect(result);
// reflection = { ok: false, issue: "...", suggestion: "..." }

if (!reflection.ok) {
  result = await execute(reflection.suggestion);
}
```

**学习要点**:
- 执行完后让 LLM 自己评价结果
- 发现问题就修正，形成"自我进化"
- 代价是更多的 token 消耗

## Token 经济学：怎么省 token

### 原则 1: 分层读取
```typescript
// ❌ 错误: 一次读完 5000 行
const content = readFile("src/main.ts"); // 消耗 ~15000 token

// ✅ 正确: 先看摘要，再定点读取
const summary = fileSummary("src/main.ts"); // 消耗 ~100 token
// summary: "5000 行, 主要函数: [processData, validate, export]"
const snippet = readFile("src/main.ts", { start: 100, end: 120 }); // 消耗 ~200 token
```

### 原则 2: 搜索优先于读取
```typescript
// ❌ 错误: 先读再找
const content = readFile("src/"); // 读整个目录
const matches = findInContent(content, "TODO"); // 在内存里找

// ✅ 正确: 先搜定位，再定点读取
const locations = grep("TODO", "src/"); // 返回: ["src/main.ts:42", "src/utils.ts:15"]
const context = readFile("src/main.ts", { start: 40, end: 45 }); // 只读上下文
```

### 原则 3: 工具返回值精简
```typescript
// ❌ 错误: 返回完整 JSON
gitLog().then(log => /* 100 条记录, ~3000 token */);

// ✅ 正确: 只返回需要的字段
gitLog({ limit: 5, format: "oneline" }).then(log => /* 5 条, ~100 token */);
```

### 原则 4: 上下文窗口管理
```typescript
// 对话太长时，压缩历史
if (tokenCount(history) > MAX_CONTEXT * 0.7) {
  const summary = await llm.summarize(history.slice(0, -5));
  history = [summary, ...history.slice(-5)];
}
```

## 项目文件结构

```
thinking-agent/
├── src/
│   ├── core/                    # 核心层
│   │   ├── agent.ts             # ReAct 循环主逻辑
│   │   ├── planner.ts           # Plan-then-Execute 规划器
│   │   └── context.ts           # 上下文管理
│   ├── tools/                   # 工具系统
│   │   ├── registry.ts          # 工具注册表
│   │   ├── types.ts             # 工具类型定义
│   │   ├── file-tools.ts        # 文件读写工具
│   │   ├── search-tools.ts      # 搜索工具
│   │   ├── shell-tool.ts        # 命令执行工具
│   │   └── git-tools.ts         # Git 工具
│   ├── llm/                     # LLM 适配层
│   │   ├── types.ts             # LLM 接口定义
│   │   └── openai-adapter.ts    # OpenAI 兼容实现
│   ├── utils/                   # 基础设施
│   │   ├── logger.ts            # 结构化日志
│   │   ├── sandbox.ts           # 安全沙盒
│   │   └── config.ts            # 配置管理
│   └── cli/                     # CLI 入口
│       ├── index.ts             # 命令行解析
│       └── repl.ts              # REPL 模式
├── docs/
│   └── architecture.md          # 本文档
├── tests/                       # 测试
├── package.json
└── tsconfig.json
```

## 学习检查清单

完成每个阶段后，问自己：

### 阶段 1: Agent Loop
- [ ] 我能解释"思考-行动-观察"循环吗？
- [ ] 我知道 tool use 的 JSON 协议怎么定义吗？
- [ ] 我能说清楚"为什么不让 LLM 直接执行代码"吗？

### 阶段 2: 推理模式
- [ ] 我知道什么时候用 ReAct，什么时候用 Plan-then-Execute 吗？
- [ ] 我能实现一个"先规划再执行"的流程吗？
- [ ] 我理解 Reflexion 的价值和代价吗？

### 阶段 3: Token 经济学
- [ ] 我能实现"先搜后读"的分层读取吗？
- [ ] 我知道怎么压缩对话历史吗？
- [ ] 我能设计一个"只返回必要信息"的工具吗？

### 阶段 4: 系统能力
- [ ] 我能实现一个沙盒，限制文件访问范围吗？
- [ ] 我能设计一个可插拔的工具注册系统吗？
- [ ] 我能实现结构化日志，记录每一步的输入输出吗？
