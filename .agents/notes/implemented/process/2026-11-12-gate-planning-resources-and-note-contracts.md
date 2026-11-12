# Agent Note: Planning 必读 rfc 与 Note/verify 契约

Status: implemented

工作项：本次会话“Gate root 写策略与 planning 资源加载”。root 写权限由 [architecture Note](../architecture/2026-11-12-gate-root-write-policy.md) 承接；本 Note 承接 planning 资源加载、`notePaths`、verify `toolResults` 与 finalize 自引用契约。

## Problem

真实会话 `session-ad7b174a-1db2-47b3-a57f-a10016283e93` 暴露了四个问题。

### 1. gate-planning 没有读 rfc.md

主代理确实加载了 `gate-planning` 和 `gate-write-agent-notes`（seq 153/155），但只读了 worker brief 和 `proposal.md`（seq 161/163），没有读 `rfc.md`；它在 seq 160 的思考里写的是“read proposal.md / rfc.md as needed”，随后自行判断“小功能不需要”。

原因不是 procedure 显式压过 skill，而是三者叠加：

- `skill` 工具只返回 `SKILL.md` 和资源根目录，链接的 `proposal.md`/`rfc.md` 不会自动加载；
- `gate-planning/SKILL.md` 第 19 行说“技术设计按 rfc.md”，但第 51/59 行把 rfc 写成“技术可行性会实质影响范围时/需要重要技术决定时”，留下了“as needed”的解释空间；
- `PLAN_STEP_1` 只点名 `assets/worker-briefs/gate-enter-plan.md`，没有点名 `proposal.md` 或 `rfc.md`，模型便把注意力放在 brief 上。

主代理最终写了 `## Design` 节，说明 rfc 的检查项本来适用；它还自己定了 CLI/测试/错误处理等设计，root 也没有把 rfc 检查点转交给 planning worker（worker 不加载 gate 技能）。这是方法加载的缺口，不是模型“忘了”。

### 2. `notePaths` 路径契约不一致

`gate_note_write` 接受相对于 `.agents/notes` 的 `proposed/...` 或 `feature/...`；`gate_record({notePaths})` 只接受 `.agents/notes/<lifecycle>/<class>/...`。seq 196 第一次 plan record 因此返回 `invalid-note-path`，seq 204 改为完整路径后才通过。同一个 Note 在两处要求不同写法，纯属可避免的摩擦。

### 3. verify `toolResults` 契约不明确

seq 536 第一次 verify record 的 `verification.toolResults` 传入的是描述字符串（worker session id + 说明），返回 `unboundToolResults`；主代理随后翻代码、读 worker session log，才在 seq 671 用真实 `call_...` id 通过。

`gate_record` 要求 `toolResults` 绑定到 verify worker session log 里的真实 `tool/result` callId，但 procedure 只在 `IMPLEMENT_STEP_3` 写了 `gate_record({node:'verify', verification, workerSessionIds})`，没有说 `toolResults` 必须是 `call_...`；`REVIEWING_VERIFY_PROCEDURE` 和 README 的 Verify 证据示例还保留 `tool-result-id`/`selfReported: true` 的旧写法，worker brief 也没要求返回 callId。绑定逻辑是对的，缺的是契约说明，verify-standalone 也会遇到同样的摩擦。

### 4. finalize 留下过期自引用

seq 715 `gate_note_finalize` 把 Note 移到 implemented 后，正文第 215 行仍写“本 Note 位于 proposed/feature/...”。`gate_note_verify` 只跑格式/lifecycle，不检查正文自引用，所以通过；主代理在 seq 766 想修正时又被旧 root 写限制拒绝（由 architecture Note 解决）。

finalize 已经知道 source/target 路径，完全可以在移动时替换该 Note 自己的相对路径，而不是把过期引用留给下一次会话。

### 已有 Note 审计

- [2026-11-07 gate-planning 与 Agent Note 整合](../../proposed/process/2026-11-07-implement-gate-orchestrated-phases.md) 与本 Note 部分重叠；它记录的是 proposal/rfc/write-agent-notes 的整合方向，本 Note 补上“写设计节前必读 rfc”和 worker 转交契约。两篇互链，不合并。
- [2026-11-10 内置 write-agent-notes 与 lifecycle](../../implemented/process/2026-11-10-gate-notes-builtin-lifecycle.md) 拥有 `notePaths` 与 finalize 的生命周期；本 Note 只改路径归一与 finalize 自引用这两个事实，实施时原地同步该篇并加互链。
- [2026-11-10 Gate B](../../implemented/architecture/2026-11-10-gate-dsh-native.md) 的 T3 已定义 `toolResults` 绑定；本 Note 只补 procedure/worker brief/参数说明，不改绑定逻辑，实施时在该篇加契约指针。
- [2026-11-12 方法论与 procedure 分层](../../implemented/architecture/2026-11-12-gate-methodology-procedure.md) 没有覆盖本 Note 的资源加载与 note 契约；无冲突。

## Decision

### 范围与非目标

本次：

- 把 `rfc.md` 变成 planning 的显式必读资源：写设计节（`## Design`/`### 设计`/自由设计节）前必须读取并按其检查项收敛，且把适用检查点写进 planning worker prompt；
- 统一 `notePaths` 的输入写法，`gate_record` 在 plan/plan-revise/implement 接受完整路径、notes-relative 与 class-relative 路径，state 统一存完整路径；
- 明确 verify `toolResults` 必须是真实 `call_...` tool result id，`evidence` 是 workspace 内普通文件，并同步 verify-standalone/README；
- `gate_note_finalize` 在移动时替换该 Note 自身的 `proposed/...` 引用；
- 更新 procedure、skill、worker brief、README、测试和已有 Note 的指针。

非目标：

- 不改变 gate 的 phase/node 状态机；
- 不改变 worker 角色限制；
- 不改变 verify 的绑定逻辑（只补说明）；
- 不把 rfc 的全文复制进 procedure 或 skill；只要求读取和转交检查点；
- 不引入 Config、不读取仓库 `.agents/GATES.md`/`AGENTS.md` 作为运行时资源目录。

### 变更

**1. `PLAN_STEP_1`**

改为：

```text
主 agent 加载技能 gate-planning 和 gate-write-agent-notes；读取 gate-planning 的 SKILL.md、proposal.md 和 assets/worker-briefs/gate-enter-plan.md 写 planning 任务。
若本工作项要写设计节（Note 的 `## Design` / `### 设计` / 设计自由节），必须先读取 rfc.md，按其检查项（位置/输入/探索草案/技术设计/定稿）收敛，并把适用检查点写进 worker prompt；mechanical 或不写设计节的工作项不强制读 rfc。
先按 write-agent-notes §3 检索历史...
```

`notePaths` 示例同时说明完整路径和 notes-relative 两种写法。

**2. `gate-planning/SKILL.md`**

- 在开头加“必读资源”段：写设计节（不限于标题 `## Design`，也包括 `### 设计` 或自由设计节）前必须读取 `proposal.md` 和 `rfc.md`；rfc 的检查项必须进入 worker prompt，不能以“as needed”跳过。
- 第 19 行改为“技术设计按 rfc.md；写设计节前必读”。
- 第 51/59 行保留“探索草案/重要技术决定”的条件，但补充“只要写设计节，就必须先读 rfc.md”，消除规模小即可跳过的歧义。
- `assets/worker-briefs/gate-enter-plan.md` 增加 `## Design 检查项` 占位，root 把适用的 rfc 检查点填入；worker 仍不加载 gate 技能。

**3. `notePaths` 归一**

在 `gate_record` 所有接受 `notePaths` 的写入点（plan、plan-revise、implement）校验前归一：

- `.agents/notes/<lifecycle>/<class>/<yyyy-mm-dd-topic>.md`：原样；
- `<lifecycle>/<class>/<yyyy-mm-dd-topic>.md`：补 `.agents/notes/`；
- `<class>/<yyyy-mm-dd-topic>.md`：补 `.agents/notes/<entry.lifecycle>/`；
- 其他形式：仍按现有规则拒绝。

归一后仍用 `entry.class`/`entry.lifecycle` 校验；如果补出的 lifecycle/class 与 entry 不一致，按 `invalid-note-path` 拒绝，不做“按 class 猜 lifecycle”。state 的 `notePaths` 统一存完整路径；`gate_note_write` 的返回路径本来就是完整路径，worker 返回 notes-relative 或 class-relative 时也能被接收。补相对路径、class-relative 与 canonical 状态测试。

**4. verify `toolResults`**

- `IMPLEMENT_STEP_3` procedure 明确：`verification.toolResults` 必须是 verify worker session log 中真实 `tool/result` 的 `call_...` id；`verification.evidence` 是 workspace 内的普通文件路径。
- `gate-verify` worker brief 的“输出”增加：返回实际使用的 `call_...` 列表，供 root 填 `gate_record`。
- `gate-user-verify` 的 `assets/worker-briefs/gate-code-verify.md` 同样增加“返回实际 `call_...` id”的输出要求；verify-standalone worker 不能只给描述。
- `verify-standalone` 的 reviewing procedure（`index.js` 的 `REVIEWING_VERIFY_PROCEDURE`）和 README “Verify 证据”示例同步：`toolResults: ["call_..."]`，不是 `tool-result-id`；`selfReported:false`/`executionBound:true` 与实际绑定一致。
- `gate_record` 的 `verification.toolResults`/`evidence` 参数增加 description；绑定逻辑不变。

**5. finalize 自引用替换**

`finalizeNote` 在 `transformImplemented` 和可选 `decisionBody` 之后，对该 Note 自身执行：

- `.agents/notes/proposed/<class>/<file>` → `.agents/notes/implemented/<class>/<file>`；
- `proposed/<class>/<file>` → `implemented/<class>/<file>`。

只替换该 Note 自己的 source/target 路径，不改对其他 proposed Note 的引用。补测试：正文含自身 `proposed/...`，finalize 后不存在该自引用，且 `verify-notes` 通过。

### 决策与未决

已决定：

- rfc 在写设计节前必读，不是全局无条件读；不写设计节/mechanical 工作项不强制；
- 由 root 读取 rfc 并把检查点转交 worker，worker 不加载 gate 技能；
- `notePaths` 归一而不是只报错；
- verify `toolResults` 只补契约说明，不削弱绑定；
- finalize 自动替换自身路径，不依赖 root 事后修。

未决：

- 无。

## Implementation evidence

- `npm test` ALL CHECKS PASSED；`node --check` 通过；`npm run verify-notes` 11 篇通过。
- 单元测试覆盖：plan procedure 的 `rfc.md`/`proposal.md`/设计节；`gate-planning/SKILL.md` 必读资源；worker brief 的 Design 检查项；plan 的 notes-relative/class-relative `notePaths` 归一；implement 的 `notePaths` 归一；finalize 自身 `proposed/...` 替换且保留其他 Note 引用；两个 verify brief 和 README 的 `call_...` 契约。
- `git diff --check` 通过；未新增 Config，未读取仓库 `.agents/GATES.md`/`AGENTS.md`。

## Alternatives considered

1. **保留“as needed”。** 最强理由：小功能不需要完整设计检查，强制读 rfc 会增加上下文。否决：live session 已经证明模型会在写了设计节的情况下跳过；只要写设计节，rfc 适用，不能靠规模判断。
2. **让 planning worker 读取 rfc.md。** 最强理由：worker 写设计节，最接近资源。否决：gate 的 worker 明确不加载 gate 技能，资源加载由 root 负责；让 worker 自己读会重新引入“worker 加载技能”的分叉，且 root 无法保证方法一致。
3. **只接受完整 `.agents/notes/...` 路径。** 最强理由：契约单一、校验简单。否决：`gate_note_write` 的自然返回是 notes-relative，worker 也不该被迫知道 workspace 前缀；归一比教育所有调用方更稳。
4. **让 gate_note_verify 检测并拒绝 proposed 自引用。** 最强理由：不改 finalize 的文本。否决：finalize 已经持有 source/target，能在一次原子写入中修正；让 verify 事后失败会把可自动修复的问题留给人工。
5. **放宽 toolResults 绑定，接受任意字符串。** 最强理由：减少摩擦。否决：验证证据必须能绑定到真实 tool/result，否则 verify 退化为自报；只补说明。

## Consequences

### Acceptance criteria

1. `PLAN_STEP_1` 明确点名 `gate-planning/SKILL.md`、`proposal.md`、`gate-enter-plan.md`；并把 rfc.md 的读取绑定到“写设计节”（`## Design`/`### 设计`/自由设计节），要求按 rfc 收敛、把检查点写进 worker prompt；mechanical/不写设计节不强制。
2. `gate-planning/SKILL.md` 有“必读资源”段，明确“写设计节前必须读取 rfc.md”，不再出现可跳过的 as-needed 解释；`gate-enter-plan.md` 有 Design 检查项占位。
3. `gate_record` 在 plan/plan-revise/implement 所有接受 `notePaths` 的写入点接受 `.agents/notes/<lifecycle>/<class>/...`、`<lifecycle>/<class>/...`、`<class>/...`，用 entry 的 lifecycle/class 归一为完整路径；不一致、非法 class/lifecycle/symlink/文件名仍拒绝；测试覆盖相对路径、class-relative、canonical 状态与 implement 写入点。
4. `IMPLEMENT_STEP_3`、`REVIEWING_VERIFY_PROCEDURE`、`gate-verify` worker brief、`gate-user-verify` 的 `gate-code-verify.md` brief、README “Verify 证据”示例和 `gate_record` 的 `verification` 参数说明都明确 `toolResults` 是真实 `call_...` tool result id、`evidence` 是 workspace 文件，且 `selfReported:false`/`executionBound:true`；绑定逻辑不变，现有 unbound 测试仍通过。
5. `gate_note_finalize` 替换 Note 自身的 `proposed/...` 引用为 `implemented/...`；不替换其他 Note 的引用；测试覆盖、`verify-notes` 通过。
6. 测试：plan procedure 文本包含 `rfc.md`/`proposal.md` 和“设计节”条件；skill 文件包含必读语句；notePaths 在 plan 与 implement 写入点归一；finalize 自引用；verify-standalone/README 的 callId 文案；`node --check`、`npm test`、`npm run verify-notes` 全绿。
7. 实施时同步 `2026-11-10-gate-notes-builtin-lifecycle`（notePaths/finalize 事实）、`2026-11-10-gate-dsh-native`（T3 toolResults 指针）和 README 的 Verify 证据示例；与 `2026-11-07` 旧提案互链，不无痕覆盖。
8. 不新增 Config；不读取仓库 `.agents/GATES.md`/`AGENTS.md` 作为运行时资源来源。

### Risks

- rfc 必读会增加 planning 上下文和一次 read；对写设计节的工作项是必要成本，对 mechanical/不写设计节的工作项不触发。
- root 需要把 rfc 检查点转交 worker，prompt 会更长；worker 不加载技能，仍由 root 保证方法一致。
- `notePaths` 归一可能把错误路径“修正”为意外文件；归一后仍用 class/lifecycle/文件名/存在性/Status/同 topic/symlink 校验兜底，并补测试。
- finalize 自引用替换是文本操作；只替换该 Note 自身的 source/target，测试覆盖其他 proposed 引用不被误改。
- `toolResults` 只补说明，模型仍可能传错；`unboundToolResults` 错误保留，作为最后一道拒绝。
