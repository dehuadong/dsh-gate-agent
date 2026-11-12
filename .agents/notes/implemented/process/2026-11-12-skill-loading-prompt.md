# Agent Note: 技能加载改为会话内复用

Status: implemented

工作项：本次会话“技能加载提示词优化”。本 Note 承接 gate root prompt 的技能加载规则；不改变 gate phase/node、工具 schema 或技能内容。

## Problem

真实会话的 plan-review/plan-revise 多轮记录里，root 每轮都重新调用 `skill`：

```text
加载技能 · gate-plan-review
...
gate_record · plan-review
加载技能 · gate-planning
...
gate_record · plan-revise
加载技能 · gate-plan-review
...
```

原因不是模型无法判断，而是 gate prompt 明确要求重复加载：

- `DISPATCH_RULE` 原文：`每次派 subagent 前，按当前 procedure 的 method 重新加载技能；不要使用记忆中的节点或技能；多轮/压缩后重新确认。`
- `PLAN_ORCHESTRATION` Step 2 的 findings 分支：`再重新加载 gate-planning`。
- Step 1/2/3 反复写“主 agent 加载技能”。
- `GATE_METHODOLOGY` 把“要加载的技能”与 procedure 更新绑在一起。

这些文本被追加到每一轮 procedure，模型按字面执行，导致同一技能内容在上下文已存在时仍重复加载，浪费 token 和轮次。

## Decision

把规则改成“会话内已加载则复用；只在必要时刷新”。

### 通用规则

`DISPATCH_RULE` 改为：

```text
## 技能加载规则
1. 本会话已经通过 skill 工具加载过的技能，内容仍在上文时直接复用，不要重复调用 skill。
2. 只有以下情况才重新加载：本会话首次进入该技能；compaction 后内容已不在上下文；技能文件/版本发生变化；用户明确要求刷新。
3. gate_record / gate_status 返回新的 procedure 只代表 node、轮次或 findings 变化，不代表要重新加载技能。
4. 多轮 review/revise 复用同一份技能内容；把新的 findings、文件范围和要求传给 worker，不要重新加载技能。
```

### 步骤文案

- plan：首次进入时加载 `gate-planning`/`gate-write-agent-notes`；已加载复用；plan-revise 复用 `gate-planning`，不写“再重新加载”。
- plan-review：首次进入时加载 `gate-plan-review`；多轮 review 复用。
- implement/code-review/verify：首次进入时加载；后续轮次复用。
- fix-bug：首次进入时加载 `gate-fix-bug`；review 首次进入时加载 `gate-code-review`；已加载复用。
- standalone review/proposal review：首次进入时加载；已加载复用。
- `GATE_METHODOLOGY`：compaction 后重新获取 procedure，并确认技能内容是否仍在上下文；首次需要时加载，已在上文则复用，不因 procedure 更新重复加载。

### 测试

`procedure reuses already-loaded skills` 断言：

- procedure 包含 `## 技能加载规则`；
- 包含 `直接复用`、`不要重复调用`；
- 不包含旧的 `再重新加载 gate-planning`。

## Implementation evidence

- `pnpm typecheck`、`pnpm build`、`pnpm test` 通过。
- `pnpm test` 包含 `procedure reuses already-loaded skills`、split/registry 检查。
- 修改集中在 `packages/gate/src/protocol.ts` 的 prompt 文案与 `packages/gate/test/unit.mjs` 的断言；无工具 schema、phase/node、技能内容变化。

## Alternatives considered

1. **在 gate state 记录 `loadedSkills`**：看似可靠，但 `skill` 工具不在 gate 控制内，没有加载回调；compaction 后 state 仍会误判“已加载”。否决。
2. **只改 `DISPATCH_RULE`，不改 Step 1/2/3**：Step 2 的“再重新加载 gate-planning”仍会触发。否决。
3. **完全不写加载规则，依赖模型记忆**：首次/compaction/技能更新时会缺技能内容。否决。
4. **每次 `gate_record` 都强制刷新技能**：保证最新，但正是本次要消除的重复加载。否决。

## 已有 Note 审计

- [Gate DSH 原生](../architecture/2026-11-10-gate-dsh-native.md) 的 Method loading 段落原先要求“每次派 worker 前加载”；本 Note 改为首次/失效时加载、会话内复用，并在该篇加指针，不改写其历史决定。
- 没有其他 Note 承接技能加载规则；本 Note 是唯一属主。

## Consequences

- 同一会话内同一技能只加载一次；多轮 review/revise 只更新 findings/文件范围。
- 首次进入技能、compaction 丢失、技能文件/版本变化、用户要求时仍会重新加载。
- 提示词规则仍是软约束；如果模型误判，测试只能覆盖文案，不能保证运行时一定不重复调用。
- 没有新增 gate state 字段或工具 schema，现有 registry snapshot 不受影响。
