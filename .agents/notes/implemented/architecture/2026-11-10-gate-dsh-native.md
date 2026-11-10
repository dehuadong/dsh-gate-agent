# Agent Note: Gate B — DSH 原生状态与强制

Status: implemented

工作项：在 [P0](../bug-fix/2026-11-10-gate-p0-correctness.md) 完成后，把 gate 从“旁路状态文件 + `tools/pre-execute` 名称/正则”重构为 DSH 原生的可重建状态与可验证强制；不把 P0 的短期修复当成长期架构。

## Problem

P0 修的是确定错误，但保留了两个根问题：

- **状态不是日志派生的**：[src/state.js](../../../../packages/gate/src/state.js) 把 phase/node/task/rounds 写在 `.agents/state/gate/<hash>.json`，system prompt 直接读它。DSH 要求 model-visible 的输入可从 session log 重建（[architecture.md:130](../../../../deepseek-harness/docs/architecture.md#L130)）；fork、replay、外部改文件都会让 prompt 与日志分叉。
- **强制依赖工具名与命令正则**：[index.js](../../../../packages/gate/index.js) 只处理 `write`/`edit`/`pwsh`/`bash`，且 `tools/pre-execute` 是顺序敏感的 waterfall；其他插件或新的写工具可以绕过。DSH 的硬拒绝应使用 `ctx.tools.guard()`（monotonic，不依赖顺序），按 agent 的可见性用 `ctx.tools.restrict()`，真正的文件边界用 sandbox。

另外，P0 仍留下：`gate_record` 无法证明 worker 真的执行过、review 两轴只靠主代理汇总、`gate_record` 与 6 个技能在所有项目全局可见、verify 的 evidence 仍是自报。这些都属于“流程状态”和“执行强制”的职责混淆。

## Decision

### B-1 状态：从 session log 派生

- **决定：per-session**。用 `ctx.sessionProjections` 注册一个 host-only unit，折叠 `gate_record` 的 `tool/call` 参数与 `tool/result`；不 append 新的 session event type，也不读 `.agents/state/gate/*.json`。
- 项目 marker `.agents/gate.json` 只负责“是否启用”和项目策略（code/protected/notes 资源），不保存 phase。
- system prompt 从 projection 读取；fork/resume/replay 由 log 推导。
- 项目级跨会话冻结不在 B v1：需要时另加 storage/lease 并定义冲突与抢占；当前只保留 marker。

### B-2 强制：guard + restrict + sandbox

- 所有“无论 listener 顺序都必须成立”的拒绝改成 `ctx.tools.guard()`；`tools/pre-execute` 只保留需要 `ask`/`next()` 的交互策略。
- 按 agent 用 `ctx.tools.restrict()` 移除当前节点不允许的工具：discuss/review/verify 移除写与派发工具；planning 移除通用写/编辑/shell，只保留一个专用 `gate_note_write`（路径限制在 gate root 的 `.agents/notes/proposed`）；implement 恢复 workspace-write。
- 非写阶段用 sandbox `read-only`（discuss/review/verify）；planning 使用 `workspace-write` + 专用 note 写入口；implement 使用 workspace-write。shell 的完整性交给 sandbox/approval，插件不再静态解析任意 shell。
- **不在 B v1 包住 `ctx.fs`**：fs wrapper 会影响所有工具/插件，收益不确定；先用 guard/restrict/sandbox 与专用 note 工具。只有出现具体绕过证据时才评估 capability seam。
- 进程级 gate 与“写安全边界”的边界写进插件 README：插件是流程门禁与软约束；硬安全由 sandbox/approval 提供。

### B-3 Worker 验证

- `gate_record` 增加 `workerSessionId`（可选 `toolCallId`）；root 调用时，gate 用 `ctx.subagents.listDescendants(rootSessionId)`/树关系确认该 worker 属于当前 root，否则拒绝推进。
- review 结果按 axis（Standards/Spec 或等价两轴）结构化；缺 axis 不能标记 review 通过。
- verify 绑定到实际执行结果（tool result id、退出码、命令与证据 hash），而不是 `passed: true` 自报。
- `gate_record` 只对 root agent 可见或可用；child 不可调用；live 已观察到 auto-review 会先拦截 child 调用，插件仍保留自己的 root-only 校验。

### B-4 打包、测试与展示

- 真实 Loader 组合测试：安装、启用、禁用、升级、worker prompt、deny path。
- `locale/en.json`、`locale/zh.json`、`icon.svg`、`exports/files`。
- **Config 使用 native schemastery 图**，目标是在 `Config.listConfigs` 中 status=`schema`；不再把普通 Standard Schema 作为最终 Config。若无法在不引入外部依赖的情况下实现，则明确记录 limitation，并由用户决定是否加依赖。
- 可选服务（`subagents`、`commands`、`skills`）用 `ctx.inject`/`ctx.get`，不在模块级 `inject` 强制。

### B-5 迁移

- 移除旧 `@dsh-nove/gate` 与 `implement-gate` 的 link/bundle；同一项目只允许一个 gate 生效。
- profile 安装目标改为 `packages/gate`；安装/升级/重启验证。
- 本仓库是否自举启用 gate 单独决定；若启用，`AGENTS.md` 只写集成说明，不把仓库授权短语变成插件契约。

## 后续工作项

B 的正式实施应在 P0 完成后开始；B-1/B-2 的关键决定可以在 P0 期间先定，但不要与 P0 同时改同一段代码。B 的实现拆分为状态、强制、worker、打包、迁移五个独立工作项，每个都要有真实组合测试。

## Alternatives considered

**保留 P0 架构，只继续修工具名与正则。** 最强理由是改动小、可预测；但状态仍与日志分叉，硬拒绝仍依赖 listener 顺序，长期不可维护，故不采用。

**拆成两个插件：`dsh-gate-state`（phase/命令/技能）与 `dsh-gate-policy`（guard/sandbox）。** 最强理由是职责单一、可独立升级；但两者需要共享 phase 与 worker 证据，拆不好会产生跨插件协议，故作为 B 的备选而不是首选。

**复用 `plan-mode` + permission presets，不自己维护 gate 状态。** 最强理由是最少代码；但 plan-mode 只有单一“计划模式”，不能表达 review 轮次、docs、verify 证据和 GATES 的返回规则，故仍需自建一部分。

**项目级状态而不是会话级。** 最强理由是多个会话共享同一门禁；但需要 lease/冲突/抢占，且与 session log 的重建规则冲突；除非用户明确要求跨会话强制，否则采用 per-session。

**包住 `ctx.fs` 做路径强制。** 最强理由是最接近真正的文件边界；但会影响所有工具/插件，收益不确定，且 sandbox + restrict + 专用 note 工具已覆盖 B v1 的主要风险，故作为后续备选，不进入 B v1。

## Consequences

结果：B 的五个 ticket 已落地；生产 profile 使用 session projection、guard/restrict/sandbox、worker tree 证据、native Config 与单 gate 迁移。代价是 AC1 的 side-file fallback 与 AC5 的真实 Loader 自动化仍未补齐，作为 v1 residual 保留。

原验收条件（保留作核对）：

1. phase/node/rounds/planReady/exhausted 从 `sessionProjections` 的 host-only unit 读取；resume/replay 后 prompt 与日志一致，不再依赖 `.agents/state/gate/*.json`。
2. 硬拒绝由 `ctx.tools.guard()` 提供，调整 listener 顺序不能绕过；review/verify worker 不能写；planning 只保留 `gate_note_write`。
3. `gate_record` 要求并校验 `workerSessionId`（属于当前 root 的 subagent tree）；没有 worker 不能推进，缺 axis 不能过 review，verify 绑定实际执行结果。
4. `Config` 在 Config catalog 中 status=`schema`，`reviewLimit` 可从 profile 配置；不再以普通 Standard Schema 作为最终 Config。
5. 真实 Loader 下安装、启用、禁用、升级、root/worker prompt、deny path 全部通过；display metadata 正常。
6. 旧 gate 移除后同一项目只有一个 gate；`packages/gate` 安装路径与回滚路径明确；插件不读仓库 `.agents`。

## Plan Review

- Standards：与 `docs/AGENTS.md` 的仓库/插件边界、DSH 的 session-log、guard、restrict、sandbox 与 native Config 规则一致；没有把仓库流程写进插件。
- Spec：B-1 至 B-5 都有可观察验收；per-session、no fs wrapper v1、dedicated `gate_note_write`、native Config 已裁决；worker 证据的精确 API 与 Config native 图是实现细节，按验收验证。
- Architecture：状态、强制、worker、打包、迁移五个边界清楚；不把 P0 的修补继续堆在 `pre-execute` 上；拆分两个插件与 fs wrapper 作为备选，不进入 B v1。
- 结论：B 规划通过；实施已完成，最终 Verify 为 PASS with residuals。P0 已 implemented。

## Implementation

- **T4 native Config（已完成）**：用手写的 schemastery 兼容图（`Symbol.for('schemastery')`、`type`、`meta`、`dict.reviewLimit`）加原有 `~standard` 校验；真实安装后 `Config.listConfigs` status=`schema`，不再依赖外部 schema 包。
- **T1 state projection（已完成，production 路径）**：注册 host-only projection（手写 `stateSchema.parse`），折叠 `command/run`/`command/done` 与 `gate_record` 的 `tool/result.meta.gate.state`；system prompt/pre-execute/gate_record 从 projection 读状态。真实安装后 `gate_record` 返回 `stateSource:"projection"`。只有 `sessionProjections` 服务缺失时才保留 side-file fallback（本地测试/旧 profile）；生产 profile 不写 `.agents/state/gate`。
- **T2 guard/restrict/sandbox（完成，live 通过）**：硬拒绝改为 `ctx.tools.guard()`；`agent/pre-step` 用 `ctx.tools.restrict()` 按 root/worker 与 phase/node 收紧写工具；状态转移 append `sandbox/mode`（plan/docs/implement workspace-write，discuss/review/verify read-only）；planning worker 改用 `gate_note_write`，通用 write/edit/shell 在 planning 被 guard/restrict 拒绝。单元测试覆盖 guard、restrict 的 dispose、sandbox 模式切换和 note 写入。
- **T2 live 证据**：重启后安装 `application: applied`；无 marker 时插件加载且 `Config.listConfigs` status=`schema`；`gate_record` 返回 not-enabled。创建 marker 后 root prompt 显示 Gate/discuss；`gate_record` 返回 `stateSource:"projection"`；`write` 被拒绝（`当前阶段不允许写入；主代理在编排中不写文件`）；`gate_note_write` 返回 `planning-only`。live 发现：`write` 这类 scoped 工具仍出现在工具面，`restrict` 只掩全局工具；硬边界由 guard 保证。
- **T3 worker 证据（代码与单元测试完成；live 真实 worker tree 待复核）**：`gate_record` 增加 `workerSessionIds`，用 `ctx.subagents.listDescendants(root.id)` 校验每个 id 是当前 root 的 subagent tree child；缺 worker、树外 id 都拒绝。review 节点要求 `reviewAxes.standards` 与 `reviewAxes.spec` 的 `findings` 数组，并把两轴 findings 与顶层 findings 合并后驱动 pass/revise/block；verify 要求 `verification.toolResults` 非空，并用 `sessionQuery.readSession` 把每个 id 绑定到 worker session log 中的真实 `tool/result` callId。测试覆盖 worker-required、worker-not-descendant、缺 axis、缺 toolResults、未绑定 toolResults、成功路径。`commands`/`evidence` 仍是主代理转述，不是完整独立执行证明。
- **T5 旧 gate 迁移（完成）**：profile 移除 `@dsh-nove/implement-gate` 依赖与 `@dsh-nove/gate`/`implement-gate` junction；lockfile 不再引用两者，`session-driver`/`shell-guard` 保留。新插件检测 legacy `.agents/implement-gate.json`/`.agents/state/implement-gate` 与工具面 `implement_gate`，命中时报 `legacy-gate-present`/`legacy-implement-gate-active` 并 fail closed；`/gate-init` 拒绝 legacy trace。README 记录了 `packages/gate` 安装、profile 迁移、回滚与“同一项目只允许一个 gate”。
- B 的五个 ticket 均已实现（T3 的真实 worker live 与 verify toolResults 绑定仍有 residual）；下一步是 Implementation Review 与最终 Verify。
- **T2 live 插曲（已解决）**：首轮 live 安装后会话出错并残留 junction；清理后单元测试通过。定位并修复最可能的触发点：`ctx.tools.restrict` 不再包含 `subagent`/`subagent_fork`/`workflow` 等可能非全局/保留的名字，并对 `restrict` 调用整体 try/catch。重启 DSH 后 live 复核通过；插件、marker、state 和 junction 均已清理。
- 本 Note 已 implemented；AC1 的 service-missing fallback 与 AC5 的真实 Loader 自动化作为明确 residual 保留。

## Command wake

只有启动或继续编排的命令在写入状态后立即调用 `invocation.agent.followup`：`/gate-enter-plan`、`/gate-enter-implement`、`/gate-docs`、`/gate-code-review`，以及回到 active phase 的 `/gate-resume`。`/gate-init` 也 follow-up 一次，返回首次初始化反馈。消息带命令的 `rawInput`、当前 phase 和命令名，source 为 `gate-command`。`/gate-block` 冻结，`/gate-return-discuss` 纯状态回退，`/gate-status` 只读，这三类不 follow-up。没有延迟的第二段，也没有泛化的“继续”提示。首页提交命令由宿主创建 session；命令本身不创建 session。

## Method loading

主 agent 在**每次派 worker 前**加载当前节点对应的 gate 技能，不依赖之前的加载或记忆（多轮/压缩后尤其如此），把任务和提炼后的方法要求写进 subagent prompt；worker 的 system prompt 不再注入 `Skills` 或 `## Method files`，也不再要求 worker 重新加载 gate 技能。阶段映射：plan/plan-revise → `gate-planning` + `write-agent-notes`；plan-review → `gate-plan-review`；implement/implement-revise → `gate-implement`；code-review/review → `gate-implementation-review`；verify → `gate-verify`；discuss/docs 无技能。这样方法在主 agent 侧每次派发时刷新，worker 的多轮执行复用同一份任务上下文，避免每轮重复加载技能。code review 合并为一个 `gate-implementation-review` 技能，由主 agent 加载后派一个 review worker 同时产出 `standards` 与 `spec` 两轴。

## Implementation Review

- **Standards / Spec findings 已修**：Config 的 native symbol 恢复为 `Symbol.for('schemastery')`，并重新 live 验证 `Config.listConfigs status="schema"`；docs phase 的 sandbox 改为 `workspace-write`；review axes 现在要求 `findings` 数组并参与 pass/revise/block；`tools.restrict` 只提交当前 scope 已知的全局工具并逐名 fallback；`gate_note_write` 拒绝路径上的 symlink。
- **Review 后决定（不再让用户选）**：AC3 已补：verify 的 `toolResults` 通过 `sessionQuery.readSession` 绑定到 worker session log 的真实 `tool/result` callId，状态标记 `executionBound: true`、`selfReported: false`；未命中的 toolResults 被拒绝。AC1 的 side-file fallback 仅保留在 `sessionProjections` 缺失的测试/旧 profile 兼容路径，生产 profile 已验证走 projection；AC5 的真实 Loader 自动化未补，保留 manual install/remove + composition manifest 证据。两者作为 B v1 的明确 residual 接受，不阻塞交付；如果以后要 full AC，再单独开工作项。
- **Review 结论**：B 的五个 ticket 已实现，最终 Verify 以 PASS with residuals 记录；本 Note 转入 implemented。residual：AC1 的 service-missing fallback、AC5 的真实 Loader 自动化、T3 的真实 worker tree live（当前由 fake tree 单测覆盖）。

## Risks

- **DSH API 预稳定**：`sessionProjections`、`tools.guard`、`tools.restrict`、sandbox、`subagents.listDescendants` 的细节可能变化；实现前用 `cordis_inspect_query` 核对。
- **Config native 图**：手写 schemastery 兼容图可能无法完整投影；如果不可行，必须明确记录 limitation 或由用户批准加依赖，不能退回普通 Standard Schema 当作完成。
- **sandbox 与流程的耦合**：read-only 会阻断 planning 的笔记写入；`gate_note_write` 需要单独证明只写 `.agents/notes/proposed`，并处理路径/符号链接。
- **worker 证据**：`gate_record` 依赖 `workerSessionId` 与 subagent tree；外部/恢复的 worker 可能没有 resident session，需要明确不支持或降级策略。
- **迁移**：旧 gate 仍 link 在 profile；双 gate 同时运行会互相覆盖状态/拒绝，迁移必须先禁用旧 gate，再安装新包；`remove_bundle` 可能需要重启。
- **跨会话**：per-session 不满足“项目级冻结”；如果用户需要，必须另做 lease/冲突设计，不能默认声称支持。
- **测试成本**：真实 Loader 组合测试需要临时项目/profile fixture，可能比 P0 的代码改动更大。
