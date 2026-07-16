# ADR-006: Observation Layer 设计

> Phase 2 | 状态：已实现

## 背景

工具返回的原始数据可能很长（npm test 输出 3000 行），也可能很结构化。
直接把原始数据塞给 LLM 会导致：
1. Token 浪费
2. 注意力稀释
3. LLM 抓不住重点

需要一个"翻译层"，把工具输出翻译成 LLM 能高效理解的格式。

## 决策 1：区分"内容工具"和"动作工具"

这是最重要的设计决策，也是踩坑后修正的。

| 类型 | 工具 | LLM 调用目的 | Observation 处理 |
|------|------|-------------|-----------------|
| 内容工具 | read_file, grep | 就是为了看内容 | 返回 rawContent（实际内容） |
| 动作工具 | shell, git_status | 执行操作，看结果 | 只返回结构化摘要 |

**最初的错误设计**：所有工具都只返回摘要，不返回原始内容。
结果：LLM 调 `read_file` 读 package.json，Observation 只返回 "Read lines 1-10 (247 chars)"，
LLM 看不到文件内容，以为"被截断了"，疯狂重试，7 步花了 19000 tokens。

**修正**：Observation 接口新增 `rawContent` 字段，内容工具必须填充它。

## 决策 2：专用提取器 + 通用兜底

```
ObservationManager
  ├── FileReadExtractor（read_file, file_summary）
  ├── SearchExtractor（grep, find_files）
  ├── ShellExtractor（run_shell）
  ├── GitExtractor（git_status, git_diff, git_log）
  └── GenericExtractor（其他所有工具）
```

每种工具有不同的提取逻辑：
- shell 测试结果 → 提取 pass/fail 数量
- grep 结果 → 提取匹配数 + 前 5 个位置
- git status → 提取分支 + 变更文件列表

## 决策 3：错误分类与恢复建议

Observation 层附带两个附加信息：

1. **errorType** — 错误类型（file_not_found / permission_error / timeout 等）
2. **suggestedAction** — 恢复建议（"Check the file path" / "Wait before retrying"）

这些信息帮助 LLM 做出更好的下一步决策，而不是盲目重试。

## 决策 4：formatForLLM 输出格式

LLM 看到的最终格式：

```
## ✅/❌ 摘要

Key findings:
- 关键信息 1
- 关键信息 2

Error type: xxx（如果失败）
Suggested: xxx（如果有建议）

---
Content:
实际内容（如果是内容工具）
```

结构化格式比纯 JSON 更容易被 LLM 理解。

## 踩过的坑

| 问题 | 原因 | 解决 |
|------|------|------|
| read_file 后 LLM 疯狂重试 | Observation 丢掉了文件内容 | 新增 rawContent 字段 |
| shell 输出淹没上下文 | 没有截断 | ShellExtractor 只提取摘要 |
| LLM 分不清错误类型 | 原始错误信息太长 | errorType 分类 + 恢复建议 |

## 关键文件

- `src/core/observation.ts` — Observation Layer（5 个提取器 + ObservationManager）
