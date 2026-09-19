/**
 * Memory Module — Information Lifecycle
 *
 * ============================================================
 * Phase 6: 从 "Memory System" 升维到 "Information Lifecycle"
 *
 * 【五层架构】
 * L1: Instruction Layer    — 层级发现 + 合并
 * L2: Knowledge Layer      — 跨会话持久化知识
 * L3: Agent Notebook       — 运行时状态（Runtime State）
 * L4: Retrieval Engine     — 模块化检索管线
 * L5: Prompt Builder       — 按 Agent 类型组装最终 prompt
 * ============================================================
 */

// Layer 3: Agent Notebook
export {
  type AgentNotebookConfig,
  type AgentNotebookData,
  AgentNotebookManager,
  type BlockedState,
  type Decision,
  type GoalState,
  type NotebookObservation,
  type PlanState,
  type StepState,
  type WorklogEntry,
} from "./agent-notebook.js";
// Extraction Scheduler
export { ExtractionScheduler, type ExtractionTriggerConfig } from "./extraction-scheduler.js";
// Layer 1: Instruction Layer
export {
  type InstructionContext,
  InstructionLayer,
  type InstructionLayerConfig,
  type InstructionSource,
} from "./instruction-layer.js";
// Layer 2: Knowledge Layer
export {
  type IndexEntry,
  type KnowledgeEntry,
  type KnowledgeIndex,
  type KnowledgeScope,
  type KnowledgeSource,
  KnowledgeStore,
  type KnowledgeStoreConfig,
  type KnowledgeType,
} from "./knowledge-layer.js";

// Layer 5: Prompt Builder
export {
  type AgentType,
  type AssembledPrompt,
  type AssembleReport,
  PromptBuilder,
  type PromptBuilderConfig,
  type PromptComponents,
} from "./prompt-builder.js";
// Layer 4: Retrieval Engine
export {
  ImportanceFilter,
  MetadataFilter,
  RecencyFilter,
  RelevanceRanker,
  RetrievalEngine,
  type RetrievalEngineConfig,
  type RetrievalFilter,
  type RetrievalQuery,
  type RetrievalRanker,
  type RetrievalResult,
  type ScoredEntry,
} from "./retrieval-engine.js";
