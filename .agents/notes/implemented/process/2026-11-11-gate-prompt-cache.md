# Agent Note: Gate system prompt 与节点切换

Status: implemented

工作项：让 `gate:protocol` 在一个 protocol variant 内保持字节稳定；把动态状态移到只读 `gate_status`，把节点方法改成静态表，减少状态/节点更新造成的整段 prompt 重复与前缀失效。

## Problem

Gate 在 `gate:protocol` 中同时注入三类内容（[index.js:1033-1052](../../../../packages/gate/index.js)）：

- 静态阶段协议：`DISCUSS_ORCHESTRATION`、`PLAN_ORCHESTRATION`、`IMPLEMENT_ORCHESTRATION`、`FIX_BUG_ORCHESTRATION`、`NOTE_LIFECYCLE_ORCHESTRATION`、派发/收尾规则；
- 动态状态：`statusText(state)` 输出的 phase/node/task/work/blockReason/planReady/rounds/notePaths/verification/exhausted（[index.js:545](../../../../packages/gate/index.js)）；
- 旧实现中随节点插值的 `phaseMethodText` 和 `dispatchRule`：前者写“当前节点：X。每次派发前加载：Y。”，后者写“节点 X”。

DSH 的 system prompt 不是请求字段，而是 surface 上的 `system/message` 节点：首个 prompt 是节点 0，之后的变化按路由能力提交（[system-prompt.md:46](../../../../deepseek-harness/docs/subsystems/system-prompt.md)）：

- 路由声明 `systemPromptUpdate: 'in-history'` 时，变化后的整段渲染 prompt 追加到已缓存历史之后，模型把最新的 `system` 消息读作有效 prompt（[runtime-context.ts:93-108](../../../../deepseek-harness/packages/core/agent-loop/src/runtime-context.ts)，[request-reconstruction.spec.ts:599-633](../../../../deepseek-harness/packages/core/agent-loop/tests/request-reconstruction.spec.ts)）。前缀缓存不失效，但每变一次就往历史里多压一份完整 prompt。默认 catalog 的 `deepseek-flash` 声明该能力（[models.ts:14](../../../../deepseek-harness/packages/llm/llm-deepseek/src/models.ts)）。
- 路由没有声明时，变化会替换节点 0 并开始新的 request series（[request-reconstruction.spec.ts:569-597](../../../../deepseek-harness/packages/core/agent-loop/tests/request-reconstruction.spec.ts)）；从 message 0 起的整段前缀失效。默认 catalog 的 `deepseek-v4-pro` 没有声明该能力（[models.ts:17-22](../../../../deepseek-harness/packages/llm/llm-deepseek/src/models.ts)）。

一个典型工作项（discuss → plan → plan-review → plan-revise → plan-review → discuss → implement → code-review → implement-revise → code-review → verify → note-lifecycle → discuss）有 13 次状态/节点变化。按这 13 个状态渲染 `gate:protocol`，13 次全部改变 prompt；其中 12 次的变化同时切换 phase/node，正常路径中只有 note-lifecycle 里的 `noteVerified` 翻转是同节点状态变化（测试用真实命令序列复核）。

因此，只移除 `statusText` 只能消掉 1 次变化（note-lifecycle 的 verified 行），并让每次 prompt 少约 150 字符；`phaseMethodText`/`dispatchRule` 的节点插值仍让 plan/plan-review/plan-revise 以及 implement/code-review/implement-revise/verify 之间的 prompt 变化。这不足以抵消新增 tool 与状态滞后风险，也解释不了“状态更新破坏缓存”的主要成本。

真正的结构性浪费是：规划期与实现期本来各自共享一套阶段协议，但节点名、节点方法和状态被写进了每次渲染的 prompt。把这些内容改为静态表 + 按需读取后，同一 variant 内的节点切换不再改 prompt。

## Decision

### 1. `gate:protocol` 按 protocol variant 稳定

- 定义 `protocolVariant(state)`，root prompt 的文本只由 variant 决定：`discuss`；`plan`（plan/plan-review/plan-revise）；`implement`（implement/code-review/implement-revise/verify）；`note-lifecycle`；`fix-bug`；`docs`；`reviewing-code`（code-review-standalone）；`reviewing-proposal`（proposal-review）；`reviewing-verify`（verify-standalone）；`blocked`；`complete`；
- 保留各 variant 的现有协议文本，包括 reviewing 三个节点的不同禁令；
- 移除 `statusText` 及其派生字段；
- 用静态 `## 节点方法` 表替换 `phaseMethodText`：表列出每个节点对应的技能，不插值当前节点；
- 用静态 `## 派发规则` 替换节点插值规则：每次派 subagent 前，先调用 `gate_status` 确认当前节点，再从表里加载该节点的技能；不要使用记忆中的节点或技能，多轮/压缩后必须重新确认；
- `note-lifecycle` 只渲染 `NOTE_LIFECYCLE_ORCHESTRATION` 一次，不再叠加 `IMPLEMENT_ORCHESTRATION`，也不重复同一段。

结果：plan/implement 内的节点切换不再改变 root prompt；phase 或 variant 切换仍会改变 prompt。worker prompt 仍按 worker 自己的 node 渲染（worker 生命周期内 node 固定，不会产生节点切换 churn），不在 AC 1/3 的范围内。

### 2. 增加只读 `gate_status` tool

`gate_status()` 无参数，返回当前状态文本，沿用 `statusText` 的可读格式，不另造 JSON 合同：

- root 和 worker 都能调用；worker 用 `rootAgentOf` 定位所属 root 后再 `store.read`，不是读自己的空 projection；
- 只读：不写 state、不 append 任何 session event、不带 `presentationMeta.gate.state`；
- 与 `/gate-status` command 共用同一渲染函数；command 也解析 root，worker 会话中两者输出一致；
- 输出合同：成功 `{ok:true, text}`，`render` 返回该文本；失败 `{ok:false, code, reason}`。`root-unresolved` 的判据是 `header.origin === 'subagent'` 且 `rootAgentOf` 返回自身，或解析出的 root 没有 `session`（synthetic fallback）；`state-unavailable` 只在 `gate.root` 无法解析时返回。不能依赖 `store.read` 报错：它读不到状态时会返回 `defaultState()`；
- 工具在插件加载时注册一次，之后工具目录稳定。

### 3. 静态节点方法表

- `NODE_INFO` 是一份节点到 `{variant, method}` 的映射；`NODE_METHODS` 由它派生并作为 named export 暴露给测试，运行时只读；
- 表只渲染一次，不随 state 变化；只出现在 root prompt，worker prompt 不渲染节点表和派发规则；
- `verify-standalone` 的主 agent 方法保持“无”，worker 由 brief 使用 `gate-user-verify`；表里不把它写成主 agent 要加载的技能；
- 测试断言表覆盖 `gate_record` 的 node enum（含 docs；docs 显式写“无”），而不是只覆盖 `WORKER_NODES`，避免新增非 worker 节点时漏配；
- `gate_status` 只返回状态文本；模型从状态文本拿当前节点，再查静态表拿方法。

P0-2 的回归证据（worker prompt 使用 root node，[gate-p0-correctness.md:27](../../implemented/bug-fix/2026-11-10-gate-p0-correctness.md)）不再由 prompt 里的 `节点：plan` 承担：改由 `gate_status` 的 worker 测试证明“worker 读到 root 状态”，并由 `workerProtocol` 的节点分支测试证明 root node 仍传给 worker prompt（plan 分支含 `gate_note_write`，verify-standalone 分支含 `gate-user-verify`，fix-bug 分支含 `Process 1-9`）；worker prompt 的 `Gate worker` 标记和不渲染 root 协议/节点表继续证明 root 与 worker 的 prompt 分开。

### 4. 验证

已执行并通过：`node --check packages/gate/index.js`、`npm test`（`ALL CHECKS PASSED`，composition manifest 通过）、`npm run verify-notes`（8 篇通过）。

- 13 步真实序列（真实 gate 命令/tool 调用，不用手改 state 夹具；两次 plan-review 分别带 findings 与空 findings；verify 后显式 finalize/verify/note-lifecycle）断言 root prompt 变化点恰好 5 个；
- 同一 variant 内切换节点（plan ↔ plan-review ↔ plan-revise，implement ↔ code-review ↔ implement-revise ↔ verify），root prompt 文本字节不变；
- worker prompt 仍按 node 渲染：plan worker 含 `gate_note_write`，verify-standalone worker 含 `gate-user-verify`，fix-bug worker 含 `Process 1-9`；
- docs、fix-bug、reviewing-code/proposal/verify、blocked、complete 的 variant 文本各有断言；
- `gate_status` 与 `/gate-status` 输出一致；root 与 worker 会话中两者都读 root 状态；调用前后 state 不变，且用 append spy 断言不 append 任何 session event；
- DSH 的路由级结果由字节不变推出：同一 variant 内不新增 `system/message`、不替换节点 0；路由行为由 DSH 上游 admission 测试保证，本仓库不重复 boot DSH；真实 profile 的 live 观察仍是可选证据；
- 真实 API 的 cache 指标只作可选证据，不作为交付门禁。

### 5. 文档

- `packages/gate/README.md` 记录了 `gate_status`、`/gate-status` 与 root prompt / worker prompt 的行为；
- 未新增 session event type，未改 `normalizeState`，未改 phase 流转。

## Alternatives considered

**只移除 `statusText`（原提案）。** 最强理由是改动最小，节点方法仍然每步渲染，模型始终看到当前节点。但按序列渲染只能消掉 1/13 次 prompt 变化（note-lifecycle 的 verified 行），其余变化来自节点插值；为此新增 tool 和状态滞后风险不划算。不采用。

**把节点方法/状态放进 runtime-context 快照。** 最强理由是它作为 user 消息只在变化时追加，能保住前缀，模型无需主动查询，也不会忘记。没选它，因为 DSH 的 runtime-context 是一整份快照：任何节点变化都会把 cwd、sandbox、subagent 等其他 context 一起重发；而且 workflow 指令进入 user-role 通道，对门禁来说权威性弱于 system prompt。

**完全静态 prompt：所有 phase 协议也放进 `gate_status`。** 最强理由是 prompt 从头到尾不变，缓存收益最大。没选它，因为 phase 协议是门禁的核心规则，移到 tool 结果里会让模型在没查询时缺少行为约束，也会让 tool 结果膨胀；收益不足以覆盖风险。

**保持现状。** 最强理由是零风险、模型每步都能看到状态与节点。但一次工作项要产生 13 次整段 prompt 变化；如果实测成本可接受，这是合理选择。本工作项只应在确认成本值得降低时推进。

## Consequences

收益：root prompt 在典型工作项中的变化从 13 次降到 5 次；in-history 路由减少整段 prompt 追加，leading-only 路由减少前缀失效。代价：新增一个 tool declaration，模型必须在派发前查询 `gate_status`，节点来源从 prompt 移到查询或最近结果。

### Acceptance criteria

1. 同一 variant 内，plan ↔ plan-review ↔ plan-revise 以及 implement ↔ code-review ↔ implement-revise ↔ verify 的 root `gate:protocol` 渲染文本字节不变；worker prompt 不在本条范围内（它仍按 worker 的 node 渲染）。
2. variant 变化可以改变 prompt：discuss、plan、implement、note-lifecycle、fix-bug、docs、reviewing-code、reviewing-proposal、reviewing-verify、blocked、complete。
3. 13 步真实序列的 root prompt 变化点恰好是 5 个；单测断言变化点集合，而不是只断言“变化更少”。
4. `NODE_METHODS` 覆盖 `gate_record` 的 node enum（含 docs，docs 显式为“无”），没有遗漏；新增节点时有测试失败。
5. `gate_status` 返回的行集与 `statusText` 一致：始终有 phase/node/task/work/blockReason/planReady/rounds；`notePaths` 非空或 mechanical 时增加 notes 行；`exhausted` 为真时增加 exhausted 行；`verification` 非空时增加 verify 行；blocked 时增加“解冻后”行。worker 调用返回所属 root 的状态。
6. `gate_status` 只读：调用前后 state 相同，且不 append `system/message` 或任何自定义 session 事件。
7. `/gate-status` 与 `gate_status` 使用同一渲染函数；root 与 worker 会话中输出一致（command 也解析 root）。
8. direct implement 路径、review 轮次、note lifecycle、fix-bug、docs 行为不回归；reviewing 三个 variant 保留现有的不同禁令文本；note-lifecycle 只渲染 `NOTE_LIFECYCLE_ORCHESTRATION` 一次，不叠加 `IMPLEMENT_ORCHESTRATION`。
9. 静态协议写明“每次派发前先 `gate_status` 确认节点、再按表加载方法；compaction 后重新确认”。
10. P0-2 的 worker/root 分离仍有测试证据：worker 调用 `gate_status` 返回 root 状态；worker prompt 含 `Gate worker`，不含 root 协议与节点表；`workerProtocol` 的 plan / verify-standalone / fix-bug 分支文本仍有断言。
11. README 记录 `gate_status` 与新的 prompt 行为。

### Risks

- 模型可能不查询 `gate_status`，直接用记忆中的节点，导致加载错方法。缓解：静态派发规则写成强制；`gate_record` 结果继续带 node；不确定时查询。这是本方案相对现状的主要行为风险。
- 弱化了“当前节点直接出现在 prompt 里”的保障。现有决定要求每次派发前重新加载方法（[gate-dsh-native.md:107](../../implemented/architecture/2026-11-10-gate-dsh-native.md)）；本方案保留重新加载，但节点来源从 prompt 改为查询/最近结果，接受这一 tradeoff 以换取 prompt 稳定。
- 静态表增加固定 prompt token；`gate_status` 的 tool declaration 每个请求都会带上，虽然进缓存，但仍是固定成本。收益必须来自省下的整段 prompt append，不能只按一次 tool 调用估算。
- variant 切换仍改变 prompt（正常序列约 5 次；blocked/resume 会额外增加），不能消除所有变化。
- 存在一个已发现的边界：`gate-enter-implement`/`gate_start_phase` 在 `enterPhase` 拒绝前就写入 task/notePaths（[index.js:1074-1094](../../../../packages/gate/index.js)，[index.js:1272-1303](../../../../packages/gate/index.js)），失败命令可能留下同节点的状态变化。移除 status 后它不再改 prompt，但这个状态一致性问题不在本工作项范围内。
- worker 读 root 状态依赖 `rootOf`/`parentSession` 回退；subagent 关系不可判定时 `gate_status` 返回 `root-unresolved`，不能返回 worker 自己的空状态。
- 收益随路由能力不同：in-history 省的是重复 prompt token，leading-only 省的是缓存前缀。未实测前不宣称命中率一定提升。
