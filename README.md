# Thinking Agent

一个从零实现的 CLI 编码 Agent：ReAct 循环 + 分级审批 + 状态机与错误恢复 + 上下文工程 + 树形规划 + 信息生命周期（指令 / 知识 / 运行状态 / 检索），并用真实评估驱动优化。

## 快速开始

```bash
cp .env.example .env  # 填入 OPENAI_API_KEY（DeepSeek / OpenAI 兼容）
npm install
npm run build
npx thinking "你的任务"        # 自动路由 DIRECT / PLAN
npx thinking plan "复杂任务"   # 显式走规划
npx thinking --repl            # 交互模式
```

## 质量门

```bash
npm test          # 全量测试（脚本测试 + vitest）
npm run coverage  # 单元测试覆盖率
npm run lint      # Biome 检查
npm run check     # tsc + lint + test 一键门
```

## 架构速览

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
│            Infrastructure Layer              │  ← 日志 / 安全 / 配置
│       (Logger / Sandbox / Config)            │
└─────────────────────────────────────────────┘
```

## 证据与报告

- `docs/reports/` — 真实任务基线报告与优化对比（持续更新）
- `docs/phase1-6-report*.md` — 各阶段报告
- `docs/decisions/` — ADR-001 ~ ADR-022 决策记录

## 路线图

见 `docs/roadmap.md`（Phase 7 评估 / 遥测 / 预算为当前重点）。
