# dsh-gate-agent

`implement-gate` 的独立替代插件：阶段状态、写权限门禁、`/gate-*` 命令与插件专项技能。

命令只负责**进入或退出阶段**，不直接执行实现；执行由主代理派发 worker，再用 `gate_record` 推进节点。

## 命令

| 命令 | 参数 | 作用 |
|---|---|---|
| `/gate-init` | 无 | 在当前项目根创建 `.agents/gate.json`，保持 `discuss` |
| `/gate-enter-plan` | 无 | 进入 `orchestrating/plan`；工作项在规划中确定 |
| `/gate-enter-implement` | 无 | 进入 `orchestrating/implement`；复用已通过 planning 的 task |
| `/gate-docs <范围>` | 范围 | 文档治理，只允许文档/notes |
| `/gate-code-review <范围>` | 范围 | 单独只读 code review，只输出 findings |
| `/gate-block [原因]` | 可选 | 手动冻结当前阶段 |
| `/gate-resume` | 无 | 恢复 block 前状态 |
| `/gate-return-discuss` | 无 | 用户手动回到 discuss |
| `/gate-status` | 无 | 只读状态，包括 plan 就绪与 review 轮次 |

不再使用 `/gate-plan <工作项>`、`/gate-implement <工作项>`：进入阶段不等于执行，工作项也不应在 enter 时重复输入。

## 典型用法

### 初始化

```text
/gate-init
```

从 `discuss` 开始，不进入 planning/implement。

### Planning

```text
/gate-enter-plan
```

主代理按注入协议派 `gate-planning`，创建/更新 proposed Agent Note。worker 完成后：

```text
gate_record({ node: 'plan', task: 'gate-test' })
```

task 由 planning 产出，不需要用户预先输入。

随后派 `gate-plan-review`：

```text
gate_record({ node: 'plan-review', findings, requiresDiscussion })
```

findings 空 → 回 discuss，planReady=true；需要用户决定 → discuss。

### Implementation

```text
/gate-enter-implement
```

前提：

- 已有 task；
- planReady=true。

主代理派 `gate-implement`，然后两轴 review、verify：

```text
gate_record({ node: 'implement' })
gate_record({ node: 'code-review', findings })
gate_record({ node: 'verify', verification })
```

`/gate-enter-implement` 不接受工作项参数，避免与 planning 结果不一致。

### 单独 code review

```text
/gate-code-review src/
```

- 只读；
- 不进入 implement；
- 不修复；
- 不 verify；
- 只输出 findings。

### 文档治理

```text
/gate-docs docs/
```

只允许文档/notes，不允许代码。

### 暂停与恢复

```text
/gate-block 等作者确认方案
/gate-resume
```

blocked 时写入被拒绝；resume 恢复原来的 phase/node。

## Marker

新项目使用 `.agents/gate.json`；状态在 `.agents/state/gate/`。

旧 `implement-gate` 保持冻结，直到新插件通过真实链路测试。切换时创建 `.agents/gate.json`，启用新插件、停用旧插件，然后删除旧 marker/state。

## 技能

插件专项技能：

```text
gate-planning
gate-plan-review
gate-implement
gate-code-review-standards
gate-code-review-spec
gate-verify
```

主代理只传 skill 名称和资源路径；worker 自己加载技能、读取资源，主代理不读方法正文。

planning worker 额外使用：

```text
<skills-root>/write-agent-notes/SKILL.md
<skills-root>/write-agent-notes/templates/proposed.md
```

implement worker 额外使用：

```text
<gate-implement-dir>/tickets.md
```

## gate_record

主代理派发 worker 后记录结果：

```text
gate_record({
  node,
  task,
  findings,
  requiresDiscussion,
  discussionReason,
  verification
})
```

Gate 负责 phase、写权限、review 轮次、plan 就绪、verify 证据、blocked/complete。

`requiresDiscussion=true` 或 user-owned finding：

```text
gate_record({ ..., requiresDiscussion: true })
```

Gate 设 `discuss`、`blockReason=needs-user-decision`。工具失败时提示用户执行 `/gate-return-discuss`。

## Verify 证据

```json
{
  "verification": {
    "commands": ["命令"],
    "evidence": ["证据路径"],
    "passed": true
  }
}
```

- commands、evidence 不能为空；
- evidence 路径必须存在；
- PASS 才 complete；
- 缺失返回 `verification-required`。

## 轮次

Plan Review 与 Implementation Review 各自最多 5 轮；达到上限仍有 findings 时 blocked，不视为通过。
