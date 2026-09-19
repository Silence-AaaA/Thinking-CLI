# ADR-022: Information Lifecycle（从 Memory System 升维）

> Phase 6 | 状态：已实现

## 背景

Phase 6 原计划实现三层记忆（Session / Project / Long-term Memory），但分析 Claude Code 的四层记忆架构后，发现"记忆系统"这个抽象层级过低。真正需要管理的是**信息的完整生命周期**，Memory 只是其中的 Storage 环节。

## 决策

从 "Memory System" 升维到 "Information Lifecycle"，采用五层架构：

### Layer 1: Instruction Layer
- **职责**: Discovery → Merge → Priority → InstructionContext
- **四种指令源**: Managed（框架内置）→ Global（~/.thinking/）→ Project（项目目录）→ Local（.local.md）
- **优先级反转加载**: 低优先级先注入，利用 LLM 的 recency bias
- **目录遍历**: 从根目录向 CWD 逐级发现 THINKING.md
- **@include 支持**: 模块化指令组织 + 循环引用检测

### Layer 2: Knowledge Layer（Framework 核心）
- **Flat Storage**: 所有知识条目用 uuid.json 扁平存储，分类全靠 metadata
- **KnowledgeEntry**: content + reason + type/scope/importance/confidence/tags
- **reason 字段**: Claude Code 没有做好的设计 — 不只知道"是什么"，还知道"为什么"
- **Storage 越 Dumb 越好**: 存取删操作，分类交给 Retrieval Engine
- **index.json**: 轻量索引，避免全量加载

### Layer 3: Agent Notebook（Runtime State，不是 Summary）
- **关键转变**: Claude Code 的 Session Memory 是 Summary（描述发生了什么），Agent Notebook 是 Runtime State（描述现在是什么状态）
- **结构化字段**: Goal / Plan / Step / Blocked / Decision / Observation / Worklog
- **Multi-Agent 可直接共享**: 结构化数据，其他 Agent 不需要 LLM 解读
- **每步自动更新**: 不依赖 LLM 填写模板

### Layer 4: Retrieval Engine
- **模块化管线**: MetadataFilter → ImportanceFilter → RelevanceRanker
- **策略模式**: 每个 filter 可独立替换
- **未来扩展**: 接入 Embedding 只需替换 Ranker，不动其他模块

### Layer 5: Prompt Builder
- **从 ContextAssembler 重构**: 拆分出"构建 prompt"职责
- **Agent 类型差异化**: coding / research / general 各有不同的 system prompt 附加指令
- **保留 ContextAssembler 的可解释性**: AssembleReport / HistoryCheckpoint / ContextChangelog

## 关键设计原则

1. **Storage 越 Dumb 越好** — 所有分类、过滤、排序交给上层
2. **Classification 全靠 Metadata** — 不用物理目录结构
3. **每条知识带 reason** — 不只知道"是什么"，还知道"为什么"
4. **Notebook 是 Runtime State 不是 Summary** — 结构化数据，Multi-Agent 可共享
5. **借鉴 Claude 的架构思想，不复刻 Claude 的实现细节**

## 与现有模块的关系

| 现有模块 | 在新架构中的位置 |
|---|---|
| WorkingMemory (v2) | Agent Notebook 的基础（decay/strength 机制保留） |
| ContextAssembler (v3) | 拆分为 Retrieval Engine + Prompt Builder |
| HistoryCompressor | Prompt Builder 的 history 子模块 |
| ObservationManager | Knowledge Layer 的提取源 |
| ReflectionEngine | Agent Notebook 的状态更新源 |

## 关键文件

- `src/memory/instruction-layer.ts` — Layer 1
- `src/memory/knowledge-layer.ts` — Layer 2
- `src/memory/agent-notebook.ts` — Layer 3
- `src/memory/retrieval-engine.ts` — Layer 4
- `src/memory/prompt-builder.ts` — Layer 5
- `src/memory/extraction-scheduler.ts` — 双阈值触发
- `src/memory/index.ts` — 模块导出
