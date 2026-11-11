# dsh-gate-agent

Host 插件：按阶段控制 agent 的写入与评审流程，提供 `/gate-*` 命令、`gate_record` 工具和 5 个专项技能。

> 这是流程门禁，不是 OS 级安全边界。硬拒绝由 `ctx.tools.guard` 提供；gate 会 append `sandbox/mode`（planning/implement workspace-write，review/verify read-only），但真正需要强制隔离时仍使用 DSH 的 sandbox/approval。未知工具与任意 shell 语义不会被完整分析。

## 安装

- 安装：用 `plugin_manager` 的 `install_bundle`，target 指向包含本 `package.json` 的目录绝对路径。
- 用 `plugin_manager` 的 `install_bundle` 安装，target 指向该目录的绝对路径。
- 插件由“开发者模式”preset 启用；`/gate-init` 初始化项目 notes、AGENTS.md、`verify-notes` 与 CI。
- planning 使用插件内置的 `gate-write-agent-notes`。`/gate-init` 创建 `.agents/notes/` 的四个 lifecycle 根、AGENTS.md managed block、`.agents/gate/verify-notes.mjs`、`.agents/gate/ci/`，在 `package.json` 确保 `verify-notes` 脚本，并生成 `.github/workflows/verify-notes.yml`。

## 命令

| 命令 | 参数 | 作用 |
|---|---|---|
| `/gate-init` | 无 | 初始化 notes 根、AGENTS.md、`verify-notes`、`.github/workflows/verify-notes.yml`，保持 `discuss` |
| `/gate-enter-plan [简单需求]` | 可选 | 进入 `orchestrating/plan`；用户简述随 follow-up 交给 planning |
| `/gate-enter-implement [简单说明]` | 可选 | 进入 `orchestrating/implement`；复用已通过 planning 的 task，或直接用简述作为当前事项 |
| `/gate-docs` | 无 | 文档治理，不调用技能 |
| `/gate-implement-review [范围]` | 可选 | 单独只读 code review，只输出 findings；无参数时按上下文确定范围 |
| `/gate-code-verify [范围]` | 可选 | 单独只读验收；子代理使用 to-verify，主 agent 不加载 |
| `/gate-propose-review [提案]` | 可选 | 单独提案评审，走 gate-plan-review 三轴 |
| `/gate-note-verify` | 无 | 只读检查 notes tree/format/lifecycle/archived |
| `/gate-note-archive <note> [--superseded-by <new>]` | 必需 Note 路径 | 归档 implemented Note，写 Archived、移动、封印、报告入站链接 |
| `/gate-note-board [输出路径] [标题]` | 可选 | 生成决策看板 `board.html`，连接本地 notes 目录 |
| `/gate-note-seal` | 无 | 只给 `archived/` 中已有 Note 补写 `manifest.json` 的 SHA-256 封印；不归档、不改 Note 内容 |
| `/gate-block [原因]` | 可选 | 手动暂停：保留当前节点；手动 block 后用 `/gate-resume` 回原节点 |
| `/gate-resume` | 无 | 解冻 block：回到 block 前的节点；轮次耗尽回 discuss |
| `/gate-return-discuss` | 无 | 用户手动回到 discuss |
| `/gate-status` | 无 | 只读状态，包括 plan 就绪、轮次与 verify 结果 |

只有**启动或继续编排**的命令在一次 handler 内写状态并立即 `agent.followup`：`/gate-enter-plan`、`/gate-enter-implement`、`/gate-docs`、`/gate-implement-review`、`/gate-code-verify`、`/gate-propose-review`，以及回到 active phase 的 `/gate-resume`。`/gate-init` 也 follow-up 一次，用于首次初始化反馈。消息携带 `rawInput`、当前 phase 和命令名，source 是 `gate-command`。`/gate-block`、`/gate-return-discuss` 只改状态，`/gate-status` 只读，都不 follow-up。首页提交命令由宿主创建 session；命令本身不创建 session。

进入阶段不等于执行。主代理派发 worker，再用 `gate_record` 推进节点。

离开 discuss 不要求用户输入 slash command：用户在对话或 `ask_user_question` 中明确授权后，主 agent 可调用 `gate_start_phase({node:'plan'|'implement', brief})` 进入阶段。`/gate-enter-plan` / `/gate-enter-implement` 仍是用户直接进入的入口。

Verify PASS 后进入 `note-lifecycle`，完成后回 discuss，不停留在 complete。回 discuss 前执行一次 `git add -A` + `git commit`（非 git 或没有改动跳过；提交失败不切 discuss）：

1. `gate_note_finalize` 把 proposed Note 移到 `implemented/` 并更新头块；
2. `gate_note_verify` 跑四条校验并在通过后设置 `noteVerified`；
3. `gate_record({node:'note-lifecycle'})` 完成。

`mechanical:<说明>` 工作项跳过；`archived/manifest.json` 的封印由用户执行 `/gate-note-seal`，模型不自动写。

planning worker 用 `gate_note_write` 写 `.agents/notes/proposed`；原地同步既有 implemented Note 时路径写 `implemented/<class>/...`；通用 `write`/`edit`/`apply_patch`/shell 在 planning 被 guard/restrict 拒绝。

## 典型用法

### 初始化

```text
/gate-init
```

从 `discuss` 开始，不进入 planning/implement。\n\n同时生成 `.agents/gate/ci/` 下的校验脚本副本和 `.github/workflows/verify-notes.yml`；CI 使用这些项目内副本，不依赖插件安装路径。

### Planning

```text
/gate-enter-plan
```

主代理按注入协议派 `gate-planning`，创建/更新 proposed Agent Note。worker 完成后：

```text
gate_record({ node: 'plan', task: 'gate-test', workerSessionIds: ['<child-session-id>'] })
```

`task` 可以由 planning 产出，也可以来自 `/gate-enter-implement` 的用户简述；planning 的 task 可以是标题或 `mechanical:<说明>`。随后派 `gate-plan-review`：

```text
gate_record({ node: 'plan-review', findings, reviewAxes, workerSessionIds, requiresDiscussion })
```

findings 空 → 回 discuss，`planReady=true`；需要用户决定 → 进入 `blocked`，等待 `/gate-resume`。

### Implementation

```text
/gate-enter-implement
```

前提：已有 task 或用户给出一句简述，且没有耗尽 review 轮次；`planReady` 不是硬前置。

主代理派 `gate-implement`，然后两轴 review、verify：

```text
gate_record({ node: 'implement', workerSessionIds: ['<child-session-id>'] })
gate_record({ node: 'code-review', findings, reviewAxes, workerSessionIds })
gate_record({ node: 'verify', verification, workerSessionIds })
```

有已通过 planning 的 task 时，简述作为实施约束；没有规划时，简述直接作为工作项进入 implement。命令不要求用户写工作项格式，也不要求 `mechanical:` 前缀。

直接 implement 时由主 agent 按 `gate-write-agent-notes` 判断改动性质：机械改动用 `gate_record({node:'implement', noteDecision:'mechanical'})` 标记并跳过 lifecycle；非机械改动先补 Note 或带上 `notePaths`。

### 单独 code review

```text
/gate-implement-review src/
```

- 只读；不进入 implement；不修复；不 verify；只输出 findings。
- 结束后 `gate_record({ node: 'code-review-standalone', findings, reviewAxes, workerSessionIds })`，回到 discuss。

### 单独验收

```text
/gate-code-verify
```

- 只读；主 agent 不加载 `to-verify`，只派子代理。
- 子代理按 `to-verify` 执行验收并按 Step 6 汇报；可运行测试/命令作为证据，但不得修改测试、产品代码、需求或设计，也不要自行提交。主 agent 汇总后输出给用户。
- PASS 后 `gate_record({ node: 'verify-standalone', verification, workerSessionIds })` 会先执行一次 `git add -A` + `git commit`，再回 discuss；非 git 或没有改动跳过。
- 不进入 note-lifecycle；这是独立验收，不替代 implement 流程的最终 Verify。

### 提案评审

```text
/gate-propose-review
```

- 只读；加载 `gate-plan-review`，覆盖 Standards、Spec、Architecture 三轴。
- 主 agent 按规模决定一个或多个 review worker。
- 结束后 `gate_record({ node: 'proposal-review', findings, reviewAxes, workerSessionIds })`，回到 discuss。
- 不自动 plan-revise；findings 由用户决定后续。

### 归档与封印

`/gate-note-verify` 只读检查现有 Note：

```text
tree / format / lifecycle / archived
```

`/gate-note-archive` 才是归档：

```text
/gate-note-archive implemented/<class>/<old>.md --superseded-by implemented/<class>/<new>.md
```

它会：

- 给旧 Note 插入 `Archived: YYYY-MM-DD`；
- 移到 `archived/<class>/`；
- 写入 `archived/manifest.json` 的 SHA-256 封印；
- 报告仍指向旧 Note 的入站链接；
- `--superseded-by` 只在**新 Note** 里补互链，不改归档正文。

什么时候归档，按原始 `write-agent-notes` 规则：

- 旧方案被新方案**完全取代**，但旧篇仍有独立参考价值（否定性保证、所有权边界、重新引入条件）→ 吸收旧篇独有理由后归档；
- 一次性设计、已废弃平台的窄适配、已闭环的简单修补 → 可归档；
- 旧篇被完全吸收、没有独立价值 → 删除，不归档；
- 部分取代 → 两篇都保留并互链，不归档。

`/gate-note-seal` 不是归档入口：

```text
/gate-note-seal
```

只给 `archived/` 中**已有但缺 manifest/封印**的 Note 补 SHA-256；通常在 verify 报 `manifest.json missing` 或历史导入时执行一次。正常用 `/gate-note-archive` 时，归档脚本已经写入封印，不需要再 seal。

### 决策看板

```text
/gate-note-board [输出路径] [标题]
```

默认生成 `board.html`（约 69KB 轻量版）。用浏览器打开后点击“连接本地目录”选择 `.agents/notes`，之后新增/修改 Note 会自动热刷新。

不指定标题时使用项目目录名加“决策看板”。

### 文档治理

```text
/gate-docs
```

只做文档治理，不调用技能；范围由模型按项目实际文档需要判断。完成后：

```text
gate_record({ node: 'docs' })
```

回到 discuss，不需要用户再执行 slash command。

### 暂停、恢复与讨论

`/gate-block [原因]` 是**手动暂停**，不是沟通模式：

- 保留当前 `phase/node`；
- 冻结写入和 worker 派发；
- 会话不关闭，仍然可以正常聊天、提问、确认方案；
- 命令本身不 follow-up，agent 不会自动继续。

暂停后的选择：

| 目的 | 操作 |
|---|---|
| 同一事项，确认后继续原节点 | `/gate-resume` |
| 方案变了，回讨论重新开始 | `/gate-return-discuss` |
| 讨论完直接实施 | `/gate-return-discuss` → `/gate-enter-implement <一句说明>` |
| 需要重新规划 | `/gate-return-discuss` → `/gate-enter-plan <一句需求>` |

`requiresDiscussion` 产生的自动 block 与手动 block 一样保存当时的 `phase/node`，`/gate-resume` 回到原节点继续；只有 review 轮次耗尽产生的 block 不保存原节点，`/gate-resume` 回到 discuss。`gate-status` 会显示“解冻后：…”。

```text
/gate-block 等作者确认方案
（继续对话确认）
/gate-resume              # 同节点继续
# 或
/gate-return-discuss
/gate-enter-implement 按确认后的方案改
```

blocked 时写入被拒绝；review 轮次耗尽进入 blocked 后 `exhausted` 保留，不能靠 `/gate-resume` 绕过，需要重新 `/gate-enter-plan`。

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
- `plan-review` 与 `proposal-review` 必须带 `reviewAxes.standards`、`reviewAxes.spec`、`reviewAxes.architecture` 三轴；`code-review`/`review` 必须带 `standards` 与 `spec` 两轴；缺轴不能通过 review。
- 每个轴的 `reviewAxes.<axis>.findings` 必须是数组；`workerSessionIds` 与实际派发的 review worker 数量一致，由主 agent 按规模决定。
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

## 迁移

预设启用即生效，没有项目 marker。生产状态由 session projection 从 `gate_record`/`/gate-*` 日志重建，不写 `.agents/state/gate/`。

迁移步骤：

1. profile 依赖移除 `@dsh-nove/implement-gate`，并删除 `@dsh-nove/gate` 的 link；不要保留旧 gate 的 bundle。
2. 安装目标改为 `packages/gate`；安装/升级后重启 DSH 使 bundle 生效。
3. 删除旧 `.agents/implement-gate.json`、`.agents/state/implement-gate`；只保留一个新的 gate 实现。
4. 工具面仍有 `implement_gate` 时，先移除旧实现。
5. 回滚：`plugin_manager remove_bundle dsh-gate-agent`，恢复 profile 依赖/lockfile 到迁移前状态；回滚时不要同时启用旧 gate。

## 已知限制

- 写门禁是流程约束，不是完整安全边界；`apply_patch` 已覆盖，其他未列出的写工具不会被识别。
- shell 只识别显式写动词、重定向和部分管道；`node -e`、`python -c`、构建脚本等仍可能写盘。
- verify 的 `toolResults` 会用 `sessionQuery.readSession` 在 worker session log 中绑定到真实 `tool/result` callId；`commands`/`evidence` 仍是主代理转述，不能当成完整独立执行证明。
- `ctx.tools.restrict` 只掩全局工具；scoped 写工具仍可能出现在工具面，硬拒绝由 `ctx.tools.guard` 保证。
- 旧 gate 迁移仍属后续 B 工作项；session projection、guard/restrict/sandbox、worker tree 证据与 review axes 已在 T1/T2/T3 实现。






















