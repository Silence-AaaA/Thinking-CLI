# ADR-007: 安全漏洞修复 — shell 白名单与审批冲突 + 脚本绕过

> Phase 2 补丁 | 状态：已实现

## 背景

用户测试"删除 test.txt"时暴露了 3 个问题：

1. **shell-tool 白名单把 `rm` 拦了，但审批网关已放行** — 两层安全机制冲突
2. **LLM 绕过了安全机制** — `rm` 被拦后，LLM 用 `python -c "os.remove()"` 删除文件
3. **重复执行浪费 token** — 文件已删除后还重试，10 步花了 30000 tokens

## 决策 1：把 rm/del 加入 shell 白名单

之前 `rm` 不在白名单里，所以即使审批网关确认了用户批准，shell-tool 还是会拒绝。

修复：把 `rm`, `del`, `rmdir` 加入白名单。风险控制完全交给审批网关。

**设计原则**：白名单管"哪些命令可以执行"，审批网关管"哪些命令需要确认"。职责分离。

## 决策 2：脚本语言绕过检测

LLM 太聪明了——如果 `rm` 被拦，它会用 `python -c "os.remove()"` 来做同样的事。

在 RiskAssessor 里新增 `detectScriptBypass()` 方法，检测等价危险操作：

| 脚本操作 | 等价命令 | 检测方式 |
|----------|---------|---------|
| `os.remove()` | `rm` | `/os\.remove/i` |
| `shutil.rmtree()` | `rm -rf` | `/shutil\.rmtree/i` |
| `fs.unlinkSync()` | `rm` | `/fs[\W_]*\.unlinkSync/i` |
| `fs.rmSync()` | `rm` | `/fs[\W_]*\.rmSync/i` |
| `rimraf` | `rm -rf` | `/rimraf/i` |

**踩坑**：正则 `/fs\.unlinkSync/i` 匹配不到 `require('fs').unlinkSync`，因为 `fs` 后面是 `').` 不是 `.`。修复为 `/fs[\W_]*\.unlinkSync/i`，允许 `fs` 和方法名之间有任意非字母字符。

## 决策 3：绝对拒绝 vs 需要确认

shell-tool 现在分两层：
- **绝对拒绝**（ABSOLUTE_BLOCK_PATTERNS）：`rm -rf /`, `mkfs` 等，不管审批结果都不执行
- **需要审批**（NEEDS_APPROVAL_PATTERNS）：`rm`, `git push --force` 等，由审批网关决定

## 关键文件

- `src/tools/shell-tool.ts` — 白名单更新 + 双层拦截
- `src/core/risk-assessor.ts` — 新增 detectScriptBypass()
- `src/test-bypass.ts` — 7 个绕过检测测试用例
