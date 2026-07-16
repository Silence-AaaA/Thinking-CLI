# ADR-005: 分级审批系统

> Phase 2 | 状态：已实现

## 背景

Agent 能执行 shell 命令、写文件，这是非常危险的。
需要一个机制来控制"哪些操作可以自动执行，哪些需要人确认"。

## 决策 1：在工具外面包一层，不改工具本身

```
LLM 返回 tool_call
       ↓
  ApprovalGateway（审批网关）
       ↓
  RiskAssessor（风险评估）→ 返回风险等级
       ↓
  根据等级决定：ALLOW / CONFIRM / DENY
       ↓
  ToolRegistry.execute()（实际执行）
```

**为什么不把安全检查写在工具内部？**
- 安全策略应该集中管理，不是分散在每个工具里
- 工具只负责干活，审批只负责决策，职责分离
- 可以跨所有工具统一应用规则

## 决策 2：5 级风险分类

| 等级 | 示例 | 处理 |
|------|------|------|
| READ | read_file, grep | 自动放行 |
| WRITE | write_file | 放行 + 记录 |
| EXECUTE | npm test | 白名单校验 |
| DESTRUCTIVE | rm, git push --force | 弹出确认 |
| BLOCKED | rm -rf /, curl \| sh | 直接拒绝 |

**为什么不用简单的白名单/黑名单？**
- 黑名单永远追不上新出现的危险命令
- 白名单太严会阻碍正常工作
- 风险分级可以处理"灰色地带"

## 决策 3：审计日志

每条操作都记录：时间、工具名、风险等级、决策、结果。
REPL 里输入 `audit` 可以查看，输入 `stats` 可以看统计。

## 踩过的坑

**问题**：开发模式下每次都要确认，太烦了。
解决：加 `--no-approval` 参数，跳过审批，所有操作自动放行。

## 关键文件

- `src/core/risk-assessor.ts` — 风险评估器（纯逻辑）
- `src/core/approval-gateway.ts` — 审批网关 + 审计日志
