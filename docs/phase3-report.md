# Phase 3 完成报告 — 分级审批系统

## 设计决策

**核心思路**：不是在每个工具内部做安全检查，而是在工具执行之前加一个独立的审批层。

```
LLM 返回 tool_call
       ↓
  RiskAssessor（风险评估）
       ↓
  ApprovalGateway（审批决定）
       ↓
  ┌── ALLOW → 自动执行
  ├── CONFIRM → 询问用户 → 批准则执行，否则拒绝
  └── DENY → 直接拒绝，返回错误信息给 LLM
```

## 风险分级

| 等级 | 示例 | 处理方式 |
|------|------|----------|
| READ | read_file, grep, list_dir, git_status | 自动放行 |
| WRITE | write_file | 放行 + 记录日志 |
| EXECUTE | npm test, git commit | 白名单校验 + 放行 |
| DESTRUCTIVE | rm, git push --force, git reset --hard | 弹出确认 |
| BLOCKED | rm -rf /, curl \| sh, mkfs | 直接拒绝 |

## 新增文件

- `src/core/risk-assessor.ts` — 风险评估器（纯逻辑，无副作用）
- `src/core/approval-gateway.ts` — 审批网关（决策 + 审计日志）
- `src/test-phase3.ts` — Phase 3 测试（11 个风险评估用例全部通过）

## 修改文件

- `src/core/agent.ts` — Agent Loop 集成审批网关
- `src/cli/index.ts` — CLI 新增确认交互 + audit/stats 命令
- `package.json` — 新增 test:phase3 脚本

## 测试结果

```
风险评估器: 11/11 通过 ✅
审批网关:   ALLOW/CONFIRM/DENY 三种路径 ✅
开发模式:   审批关闭时的降级行为 ✅
审计日志:   记录完整操作历史 ✅
统计信息:   按风险等级和结果分类 ✅
```

## 新增 REPL 命令

| 命令 | 功能 |
|------|------|
| `audit` | 查看最近 10 条审计日志 |
| `stats` | 查看风险统计（按等级/结果分类） |
| `state` | 查看 Agent 状态（步骤数、token 消耗） |

## 试用方式

```bash
# REPL 模式（审批开启）
npm run repl

# 开发模式（审批关闭，所有操作自动放行）
npm run dev -- --no-approval

# 详细日志
npm run repl -- --verbose
```

在 REPL 中尝试：
1. "读取 package.json" → 自动放行
2. "运行 rm -rf dist" → 弹出确认
3. 输入 "audit" → 查看操作记录
4. 输入 "stats" → 查看风险分布
