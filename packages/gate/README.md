# dsh-gate-agent

Host 插件：按阶段控制 agent 的写入与评审流程，提供 `/gate-*` 命令、`gate_record` 工具和 5 个专项技能。

> 这是流程门禁，不是 OS 级安全边界。硬拒绝由 `ctx.tools.guard` 提供；gate 会 append `sandbox/mode`（planning/implement workspace-write，review/verify read-only），但真正需要强制隔离时仍使用 DSH 的 sandbox/approval。未知工具与任意 shell 语义不会被完整分析。

## 安装

- 安装：用 `plugin_manager` 的 `install_bundle`，target 指向包含本 `package.json` 的目录绝对路径。
- 用 `plugin_manager` 的 `install_bundle` 安装，target 指向该目录的绝对路径。
- 在项目根执行 `/gate-init` 创建 `.agents/gate.json`；缺 marker 的项目完全不启用。
- planning 需要项目提供 `write-agent-notes`：默认找 `<gate root>/.agents/skills/write-agent-notes`，或在 marker 的 `notesSkillPath` 指定相对路径。

## 命令

| 命令 | 参数 | 作用 |
|---|---|---|
| `/gate-init` | 无 | 在当前项目根创建 `.agents/gate.json`，保持 `discuss`，并 follow-up 汇报初始化结果 |
| `/gate-enter-plan [需求/约束]` | 可选 | 进入 `orchestrating/plan`；用户输入随 follow-up 交给 planning |
| `/gate-enter-implement [实施约束]` | 可选 | 进入 `orchestrating/implement`；复用已通过 planning 的 task |
| `/gate-docs <范围>` | 范围 | 文档治理，只允许文档/notes |
| `/gate-code-review <范围>` | 范围 | 单独只读 code review，只输出 findings |
| `/gate-block [原因]` | 可选 | 手动冻结当前阶段 |
| `/gate-resume` | 无 | 恢复 block 前状态 |
| `/gate-return-discuss` | 无 | 用户手动回到 discuss |
| `/gate-status` | 无 | 只读状态，包括 plan 就绪、轮次与 verify 结果 |

只有**启动或继续编排**的命令在一次 handler 内写状态并立即 `agent.followup`：`/gate-enter-plan`、`/gate-enter-implement`、`/gate-docs`、`/gate-code-review`，以及回到 active phase 的 `/gate-resume`。`/gate-init` 也 follow-up 一次，用于首次初始化反馈。消息携带 `rawInput`、当前 phase 和命令名，source 是 `gate-command`。`/gate-block`、`/gate-return-discuss` 只改状态，`/gate-status` 只读，都不 follow-up。首页提交命令由宿主创建 session；命令本身不创建 session。

进入阶段不等于执行。主代理派发 worker，再用 `gate_record` 推进节点。

planning worker 用 `gate_note_write` 写 `.agents/notes/proposed`；通用 `write`/`edit`/`apply_patch`/shell 在 planning 被 guard/restrict 拒绝。

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
gate_record({ node: 'plan', task: 'gate-test', workerSessionIds: ['<child-session-id>'] })
```

`task` 必须由 planning 产出；它可以是工作项标题，也可以是 `mechanical:<说明>`。随后派 `gate-plan-review`：

```text
gate_record({ node: 'plan-review', findings, reviewAxes, workerSessionIds, requiresDiscussion })
```

findings 空 → 回 discuss，`planReady=true`；需要用户决定 → 进入 `blocked`，等待 `/gate-resume`。

### Implementation

```text
/gate-enter-implement
```

前提：已有 task、`planReady=true`、没有耗尽 review 轮次，并且 task 有同 topic 的 proposed Note 或 `mechanical:` 前缀。

主代理派 `gate-implement`，然后两轴 review、verify：

```text
gate_record({ node: 'implement', workerSessionIds: ['<child-session-id>'] })
gate_record({ node: 'code-review', findings, reviewAxes, workerSessionIds })
gate_record({ node: 'verify', verification, workerSessionIds })
```

`/gate-enter-implement` 不接受工作项参数，避免与 planning 结果不一致。

### 单独 code review

```text
/gate-code-review src/
```

- 只读；不进入 implement；不修复；不 verify；只输出 findings。
- 结束后 `gate_record({ node: 'review', findings, reviewAxes, workerSessionIds })`，回到 discuss。

### 文档治理

```text
/gate-docs docs/
```

只允许文档/notes，不允许代码。完成后：

```text
gate_record({ node: 'docs' })
```

回到 discuss，不需要用户再执行 slash command。

### 暂停与恢复

```text
/gate-block 等作者确认方案
/gate-resume
```

blocked 时写入被拒绝；resume 恢复 `blockedFrom`。review 轮次耗尽也会进入 blocked，但 `exhausted` 标记保留；`/gate-resume` 不会清除它，需要重新 `/gate-enter-plan` 开新规划。

## gate_record

只允许 root agent 调用。child worker 调用返回 `root-only`。

```text
gate_record({
  node,
  task,
  workerSessionIds,
  findings,
  reviewAxes,
  requiresDiscussion,
  discussionReason,
  verification
})
```

- `node`：`plan`、`plan-review`、`plan-revise`、`implement`、`code-review`、`implement-revise`、`verify`、`docs`、`review`。
- `plan` 必须带 `task`。
- worker 节点必须带 `workerSessionIds`；id 必须是当前 root 的 subagent tree child 且已 settled，否则拒绝推进。
- review 节点必须带 `reviewAxes.standards` 与 `reviewAxes.spec`；缺一轴不能通过 review。
- `requiresDiscussion=true`：进入 `blocked`，`blockReason=needs-user-decision`；用户 `/gate-resume` 后继续 discuss。
- review 达到 `reviewLimit` 仍有 findings：进入 blocked，设置 `exhausted.plan/code`；不能靠重新 `/gate-enter-implement` 绕过。

## Verify 证据

```json
{
  "verification": {
    "commands": ["node packages/gate/test/unit.mjs"],
    "evidence": ["artifacts/verify.txt"],
    "toolResults": ["tool-result-id"],
    "passed": true
  }
}
```

- `commands`、`evidence`、`toolResults` 不能为空；
- evidence 必须是 gate workspace 内的普通文件；
- gate 记录每个 evidence 的 `path`、`size`、`sha256`；
- P0 不执行 commands，因此结果一律标记 `selfReported: true`；真正的执行绑定在后续 B 阶段。

## 配置

项目 marker `.agents/gate.json`（version 2，可选字段）：

```json
{
  "enabled": true,
  "version": 2,
  "codeExtensions": [".ts", ".mjs"],
  "codePaths": ["package.json", ".github/workflows/"],
  "protected": [".agents/gate.json", ".agents/state/gate"],
  "notesSkillPath": ".agents/skills/write-agent-notes"
}
```

- `codePaths`：额外按“代码”处理的路径；`/gate-init` 默认包含包配置、lockfile、`tsconfig.json`、`cordis.patch.yml`、`Makefile`、`Dockerfile`、`.github/workflows/`。
- `protected`：默认 marker 与 state 无条件保护；可追加项目路径。目标为保护路径的祖先目录（如 `.agents`、`.`）也会被拒绝。
- `notesSkillPath`：相对 gate root；用于 planning 的 `write-agent-notes`。缺省时尝试 `<gate root>/.agents/skills/write-agent-notes`。
- 插件级 `Config.reviewLimit`：1–20，默认 5；在 profile 的 bundle config 中设置。

## 技能

```text
gate-planning
gate-plan-review
gate-implement
gate-code-review
gate-verify
```

主代理在**每次派 worker 前**加载当前节点对应的技能，不依赖之前的加载或记忆（多轮/压缩后尤其如此），再把任务和提炼后的方法要求写进 subagent prompt；worker 不再加载 gate 技能或方法文件。code review 只有一个 `gate-code-review` 技能，由一个 review worker 同时覆盖 Standards 与 Spec 两轴。

| 当前 node | 主 agent 加载的技能 |
|---|---|
| `plan` / `plan-revise` | `gate-planning` + `write-agent-notes` |
| `plan-review` | `gate-plan-review` |
| `implement` / `implement-revise` | `gate-implement` |
| `code-review` | `gate-code-review`（单技能，含 Standards + Spec 两轴） |
| `verify` | `gate-verify` |
| `review` | `gate-code-review` |
| `discuss` / `docs` | 无 |

## Marker 与迁移

新项目使用 `.agents/gate.json`；生产状态由 session projection 从 `gate_record`/`/gate-*` 日志重建，不再写 `.agents/state/gate/`。

迁移步骤：

1. profile 依赖移除 `@dsh-nove/implement-gate`，并删除 `@dsh-nove/gate` 的 link；不要保留旧 gate 的 bundle。
2. 安装目标改为 `packages/gate`；安装/升级后重启 DSH 使 bundle 生效。
3. 删除旧 `.agents/implement-gate.json`、`.agents/state/implement-gate`；旧 `@dsh-nove/gate` 与新插件共用 `.agents/gate.json`，迁移时只保留一个新的 gate 实现。
4. 同一项目只允许一个 gate。检测到上述 legacy marker，或工具面仍有 `implement_gate` 时，新 gate 以 `legacy-gate-present` / `legacy-implement-gate-active` 报 invalid，并拒绝写入与推进；`/gate-init` 也会拒绝。
5. 回滚：`plugin_manager remove_bundle dsh-gate-agent`，恢复 profile 依赖/lockfile 到迁移前状态；回滚时不要同时启用旧 gate。

## 已知限制

- 写门禁是流程约束，不是完整安全边界；`apply_patch` 已覆盖，其他未列出的写工具不会被识别。
- shell 只识别显式写动词、重定向和部分管道；`node -e`、`python -c`、构建脚本等仍可能写盘。
- verify 的 `toolResults` 会用 `sessionQuery.readSession` 在 worker session log 中绑定到真实 `tool/result` callId；`commands`/`evidence` 仍是主代理转述，不能当成完整独立执行证明。
- `ctx.tools.restrict` 只掩全局工具；scoped 写工具仍可能出现在工具面，硬拒绝由 `ctx.tools.guard` 保证。
- 旧 gate 迁移仍属后续 B 工作项；session projection、guard/restrict/sandbox、worker tree 证据与 review axes 已在 T1/T2/T3 实现。

