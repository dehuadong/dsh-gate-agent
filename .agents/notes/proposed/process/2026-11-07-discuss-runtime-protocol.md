# Agent Note: Gate 的 discuss 运行时协议

Status: proposed

工作项：把 `AGENTS.md` 的 Discuss 要求从语义约定变成 Gate 注入的运行时协议。

## Problem

当前 Gate 在 `discuss` 只做两件事：

- 拒绝代码/文档写入；
- 等待用户命令进入 planning/implement。

但 `AGENTS.md` Discuss 还要求：

- 先读代码、文档、历史决策；
- 明确问题、约束、已有决定；
- 给有实质差异的方案、推荐与权衡；
- 只对未决价值判断提问；
- 不创建规划工件；
- 汇报已解决、未决、建议下一阶段。

这些仍靠模型自己记得。system prompt 还在 discuss 输出“主代理编排中”，与实际不符；discuss 也没有禁止派 worker。

## 源工程证据

| 源工程证据 | 源工程行为 | 复刻落点与裁决 |
|---|---|---|
| `AGENTS.md#Discuss` | 讨论不是被动访谈；先读上下文；给方案与权衡；只问真正未决项 | Gate 注入 `DISCUSS_ORCHESTRATION` |
| `AGENTS.md#Discuss` | 讨论不足时不进入规划；成熟后由用户决定下一阶段 | discuss 不写文件、不派 worker；用户命令才能离开 |
| `d.agents/GATES.md` Step 1 | 用户显式命令进入 planning/implement | 保持命令入口；不自动推进 |
| 当前 `index.js` | discuss 拒写，但主代理仍可派 subagent；prompt 文案错误 | 增加 discuss 派发限制与正确文案 |

## Proposal

### 1. `DISCUSS_ORCHESTRATION`

Phase 为 `discuss` 时注入：

```text
## Discuss

discuss 是默认阶段，不需要命令进入。

只读讨论，不写文件、不派 worker。

1. 先读相关代码、文档、历史 Note 与项目约束。
2. 明确实际问题、约束、已有决定与冲突。
3. 给出有实质差异的可行方案、推荐与关键权衡。
4. 只对未决的产品、范围、兼容性、成本、风险等价值判断提问。
5. 不创建提案、Note 或规格文件。
6. 汇报：已解决事项、剩余未决事项、建议的下一阶段。
7. 不自行离开 discuss；离开必须由用户显式授权。
```

### 默认态与返回

- discuss 是默认态，不新增 `/discuss` 命令；
- Agent 需要返回讨论时调用 `gate_record({requiresDiscussion:true})`；
- 用户手动返回时使用 `/gate-return-discuss`；
- 进入 planning/implement/review 仍由用户显式命令授权。

### 2. 修正 system prompt 文案

按 phase 输出：

- discuss：`discuss：只读讨论，不写文件、不派 worker。`
- orchestrating：`主代理编排中；按节点协议派 worker。`
- reviewing：`只读 code review；只输出 findings。`
- docs：`文档治理；只写文档/notes。`
- blocked：`已冻结；等待 resume。`
- complete：`已完成；新任务需重新授权。`

### 3. discuss 禁止 worker 派发

`tools/pre-execute` 在 `discuss` 拒绝：

```text
subagent
subagent_fork
workflow
```

理由：discuss 只做分析、讨论与方案比较；需要 worker 时应先进入 planning/implement/reviewing。

### 4. 不新增讨论状态表

讨论摘要不写入 Gate state。

- 讨论内容留在当前会话；
- Gate 只记录 phase/task；
- 不新建 discussion-status、readiness 表；
- 用户命令决定是否进入 planning。

### 5. 授权复用

本项不实现自动授权复用。

- discuss 不能自行转 planning/implement；
- 用户仍用 `/gate-enter-plan` / `/gate-enter-implement` 显式授权；
- 复用旧授权需要单独设计，不在本项假装实现。

### 非目标

- 不记录讨论摘要；
- 不自动判断“讨论已成熟”；
- 不新增 slash command；
- 不修改旧 `implement-gate`。

## Alternatives considered

**只靠 AGENTS.md 语义。** 最强理由是零代码；模型仍会跳过讨论要求，故注入协议。

**允许 discuss 派只读 research worker。** 最强理由是调研方便；无法机械区分只读/实现，故先禁止，需要时再设计只读 worker 类型。

**把讨论摘要写入 state。** 最强理由是持久；会变成第二套状态表，故不做。

**自动复用授权。** 最强理由是少命令；无法可靠判断“此前请求已授权”，故保持显式命令。

## Acceptance criteria

1. discuss 注入只读讨论协议；
2. discuss 是默认态，不新增 `/discuss` 命令；
3. system prompt 不再在 discuss 说“编排中”；
4. discuss 拒绝 subagent/subagent_fork/workflow；
5. discuss 仍拒绝代码/文档写入；
6. discuss 不写讨论摘要到 state；
7. 用户命令才能进入 planning/implement；
8. Agent 用 `gate_record` 回 discuss，用户用 `/gate-return-discuss`；
9. 测试覆盖协议文案、派发拒绝、phase 转换。

## Plan Review

- Standards：协议归 Gate 注入，讨论内容归会话；不建第二套状态表。
- Spec：只读、禁派发、文案、阶段入口可观察。
- Architecture：`DISCUSS_ORCHESTRATION` + pre-execute + prompt 文案。
- 结论：通过，进入实施需 implement 授权。

## Risks

- 禁止 subagent 可能误伤纯调研；需要时可增加只读 worker 类型；
- 讨论成熟度仍依赖模型判断，Gate 不自动推进；
- 授权复用未实现，属于已知边界；
- 文案按 phase 分支需要测试覆盖。
