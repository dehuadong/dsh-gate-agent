# Agent Note: Gate 方法论与 procedure 分层

Status: implemented

工作项：把 Gate 的 root system prompt 改为静态阶段方法论；把当前 phase/node 的操作过程、工具协议、方法加载与轮次移到 tool result / command follow-up。目标是 root prompt 不随阶段切换变化，同时保留“阶段该做什么”的方法论权威；权限仍由 guard/sandbox 强制。

## Problem

当前 `gate:protocol` 按 protocol variant 渲染（[index.js:1033-1052](../../../../packages/gate/index.js#L1033-L1052)），同一个 section 同时承载：

- **阶段方法论**：阶段目的、工作产物、决策/质量标准、评审/验收期望、交接条件；
- **阶段 procedure**：Step、工具与字段、`reviewAxes`、`workerSessionIds`、rounds、note 字段、方法表、派发/收尾规则。

后果：

- prompt 在 variant 切换时变化：in-history 追加整段 prompt，leading-only 替换节点 0；典型工作项 5 次。实测会话 `session-f1ec6bcd-6a98-4816-8ecb-e30ade86be17`（provider `deepseek-account` / model `deepseek-flash`，in-history）只有 2 个 system message、98.73% cache hit；这说明 in-history 下旧前缀没有失效，但 phase 频繁切换仍有整段 prompt 的追加/重放成本，leading-only 更明显。
- 方法论与 procedure 混在一起；插件作为“阶段性工作定义”的核心价值被工具字段与 phase 变化耦合。插件的目的不是只限制读写，而是定义每个阶段该做什么；权限由 guard/sandbox 负责。
- 把全部 procedure 放进静态 prompt（A）会让多个阶段的命令同时在场，跨 phase 混淆；只放静态索引（B）又让 system prompt 失去方法论，模型只剩 tool result 数据。
- 现有 `PLAN_ORCHESTRATION`/`IMPLEMENT_ORCHESTRATION` 等主要是 procedure；真正的方法论文本需要新写，不能把仓库 `.agents/GATES.md`/`AGENTS.md` 当来源。具体方法仍属 `gate-*/SKILL.md`，procedure 只负责“加载哪个技能”。

## Decision

### 1. 静态 root 方法论

`gate:protocol` section 保留名称与 order；root 分支返回静态常量 `GATE_METHODOLOGY`，所有 phase/node variant 共用、字节不变。worker 分支是该 section 的显式例外，仍返回 node-specific `workerProtocol`（[index.js:1040](../../../../packages/gate/index.js#L1040)），不在 root 字节稳定范围内。

`GATE_METHODOLOGY` 内容：

- 按 phase 分节：discuss、plan（plan/plan-review/plan-revise）、implement（implement/code-review/implement-revise/verify）、note-lifecycle、fix-bug、docs、reviewing-code/proposal/verify、blocked、complete；
- 每节写方法论：阶段目的、工作产物、决策/质量规则、评审/验收期望、交接条件；
- 不写当前 phase/node、Step、精确字段名、轮次、读写权限清单；
- 一条固定总则：当前 phase/node/procedure/method 来自最近一次 `gate_status`、`gate_record` 或命令 follow-up；只执行当前 phase 的 procedure，其他阶段方法论仅作背景参考；compaction 后必须重新获取。总则可以点名 `gate_status`/`gate_record`，但不写它们的字段或调用步骤；
- 插件自有、项目无关；不运行时读取仓库 `.agents/GATES.md`/`AGENTS.md`；本工作项不引入项目级方法论覆盖/Config/gate root 接口，若需要另开工作项；
- 方法论不复制 `gate-*/SKILL.md` 的详细方法；它只定义阶段目的与质量/交接标准。

方法论大纲（实现时扩写为文本，不是 procedure）：

| phase | 静态方法论 | procedure 举例（动态，不进入静态 prompt） |
|---|---|---|
| discuss | 界定问题、约束、备选与权衡；不进入实施 | 短 procedure：无 worker/write；用户授权后 `gate_start_phase` |
| plan | 收敛成可实施 Note；范围/验收/备选/风险；独立 plan review | 派 planning worker、`gate_note_write`、`gate_record` 字段 |
| implement | 按已确认范围实施；测试；独立 review；verify；note lifecycle | 派 implement/review/verify worker、`reviewAxes`、`verification` |
| code-review | 独立判断；只报 findings，不替作者修 | 派 review worker、轴结果 |
| verify | 以可执行证据判定 PASS/FAIL | commands/evidence/toolResults |
| note-lifecycle | Note 收尾与校验 | `gate_note_finalize`/`gate_note_verify` |
| fix-bug | 复现、回归覆盖、根因、最小修复、独立 review | 派 fix/review worker |
| docs | 文档治理，不改行为 | 短 procedure：`gate_record({node:'docs'})` |
| reviewing-standalone | 只读验收/提案评审/独立 review | 对应 worker 与轴 |
| blocked/complete | 等待 resume 或新授权 | 短 procedure：`/gate-resume` / 等待新授权 |

### 2. 动态 procedure

新增 `procedureFor(state, { reviewLimit })`，返回 `{ phase, node, method, text }`；**root 的每个 phase 都有当前 procedure**，discuss/docs/blocked/complete 是短的状态/交接 procedure，不允许出现“没有当前 procedure”的 root 状态：

- `text` 是**返回 state 的当前 procedure**：Step、工具与字段、`reviewAxes`、`workerSessionIds`、rounds、note 字段、派发/收尾；包含 node-specific 的派发/禁止内容（例如 verify-standalone 的 worker 使用 `gate-user-verify`，不能只靠 `NODE_METHODS.method='无'` 推导）；discuss/docs/blocked/complete 只写最小交接（例如“用户授权后 gate_start_phase”“等待 /gate-resume”“文档治理后 gate_record docs”）；
- `method` 是当前 node 要加载的技能，由 `NODE_METHODS` 派生；node 为 null（discuss/docs/blocked/complete）时为 `无`；`text` 负责其余内容；
- **与返回的 state 对齐**：`gate_status` 返回当前 state 的 procedure；`gate_record` 先应用 transition，再返回**新 state** 的 procedure；`gate_start_phase` 返回新 state 的 procedure；命令 follow-up 返回当前 state 的 procedure；
- **失败**：`gate_record`/`gate_start_phase` 失败时 state 未变，返回当前 state 的 procedure；绝不以失败结果返回尚未到达的下一 phase procedure。`gate_status` 自身失败返回错误码，由静态总则要求重试/修复；
- **root only**：worker 调用 `gate_status` 返回 root 状态但 `procedure:null`；root procedure 不下发给 worker；worker prompt 保持 node-specific brief；
- 所有 procedure 文本只来自 `procedureFor`；命令 handler 不再手写 procedure 片段；procedure 渲染为文本块，第一行是 `当前 phase/node`，后接 procedure，再附 state JSON；`gate_status`/`gate_record`/`gate_start_phase` 和 `wakeGateAgent` 使用同一渲染器；
- 不走 wake 的命令（block/return-discuss/status）不推送 procedure；模型按静态总则调用 `gate_status`，guard 拒绝越权动作。
- procedure 是 tool result / user 消息，追加在已缓存历史之后；system prompt 不变；blocked 的短 procedure 需要 `blockedFrom`/`blockReason`。

### 3. 分层与所有权

| 层 | 内容 | 属主 |
|---|---|---|
| root system prompt | 各阶段方法论 | `GATE_METHODOLOGY` |
| tool result / follow-up | 当前 procedure、phase/node、method | `procedureFor` + gate tools |
| `gate_status` | 状态与 procedure 兜底 | gate tool |
| `gate-*/SKILL.md` | 具体方法正文 | 技能文件 |
| guard/sandbox | 读写/派发权限 | 现有 guard/sandbox |

一条事实只有一个属主：方法论不复制 procedure 的步骤，procedure 不重写方法论的理由，也不复制技能正文；当前 phase 不在静态 prompt 中。

### 4. 跨 phase 混淆的缓解

- 方法论按 phase 分节、条件化表述（“在 review 中……”），不写无阶段限定的全局命令；
- procedure 结果第一行是 `当前 phase/node`，并声明“只执行本段；其他阶段方法论仅作参考”；
- 当前 phase 只来自 state；静态方法论不写“当前是 plan”；
- 成功 transition 推送返回 state 的 procedure；命令入口使用同一 procedure；失败返回当前 procedure 或 `gate_status` 指令；
- guard/sandbox 继续硬拦写/派发；模型误用其他阶段方法论时会被拒绝；
- 快速切换测试 + 一次真实会话的 prompt/cache 观测。

### 5. 迁移与文档

- 一次性把 per-variant protocol 文本替换为静态方法论 + procedure；不做双轨运行；回滚是恢复旧的 per-variant 文本/实现，需在实施中记录切换点；
- 更新 [README.md:39](../../../../packages/gate/README.md#L39) 及 `gate_status`/工具文档，使其描述 root 方法论 + 当前 procedure，而不是 per-variant prompt；
- 旧 Note 的 per-variant 选择被本 Note 取代；按 `write-agent-notes` 在实施完成时归档旧篇并标注 superseded-by 本 Note；旧篇的 route/cache 分析保留引用，不丢失；
- 不运行时读取仓库 `.agents` 治理文档；本工作项不增加 Config 字段。

## Implementation evidence

- 静态 `GATE_METHODOLOGY`：约 1.2k 字符 / 约 313–322 DSH tokens（渲染后的 section 文本为 1,235；含源码格式约 1,272）；root system prompt 估算约 1.8k tokens（当前 per-variant plan 实测 2,027）。
- 节点 procedure：plan 655/168、plan-review 704/180、plan-revise 246/66、implement 348/91、code-review 611/157、implement-revise 235/63、verify 364/95、note-lifecycle 360/94、fix-bug 860/219、docs 90/27、reviewing 255–279/68–74、blocked 66/21、complete 19/9（字符/DSH tokens）。
- `npm test`：ALL CHECKS PASSED；`verify-notes` 通过。测试覆盖 variant 矩阵、快速切换、失败 current procedure、worker `procedure:null`、命令 follow-up、`reviewLimit` 下的静态 prompt 不变。
- 真实 profile 的 input/cache 测量未在本批执行；需要把插件重载进 profile 后补测。未测不宣称命中率。

## Alternatives considered

**A：静态全阶段 protocol（所有 procedure 也放进 system）。** 最强理由是零查询、system 权威、前缀绝对稳定；但全部阶段步骤同时在场，跨 phase 混淆和注意力稀释风险高；本方案只把方法论放进去，procedure 保持当前，故不采用 A。

**B：静态索引 + 按需 protocol。** 最强理由是 prompt 最小、不会跨 phase 混淆；但插件作为“阶段性工作定义”的价值被移出 system，模型只看到工具数据，且依赖查询；不采用纯 B，采用 B 的推送部分。

**保持当前 per-variant protocol。** 最强理由是改动最小、已实现并验证；但 phase 切换仍改 prompt、方法论与 procedure 仍混合，不满足插件把阶段工作内化的目标；本方案取代其 per-variant 选择。

**把 procedure 放进 `systemPrompt.context`（runtime-context）。** 最强理由是自动注入、无需查询；但 procedure 进入 user-role 通道、整份 runtime-context 快照重发、权威性弱；tool result/follow-up 更贴近命令/工具语义，故不采用。

**只把方法留在 `gate-*/SKILL.md`，system prompt 不写方法论。** 最强理由是避免重复、技能是方法正文的属主；但插件就只剩状态与权限，失去“阶段该做什么”的自身价值；方法论与技能必须分层，不能合并。

## Consequences

### Acceptance criteria

1. root `gate:protocol` 在全部 phase/node variant、不同 task/rounds/notes/blocked 状态及不同 `reviewLimit` 下渲染字节相同；测试不读取 state；worker 分支明确排除，继续按 node 返回 `workerProtocol`。
2. `gate_status`、`gate_record`、`gate_start_phase` 与 waking 命令 follow-up 都使用同一 `procedureFor` 渲染器；procedure 与同一返回的 state 对齐（`gate_record` 是 transition 后的新 state），只含该 state 的 phase/node；waking 命令 follow-up 首行是 `当前 phase/node`；`gate_record`/`gate_start_phase` 失败返回当前 state 的 procedure，不返回未到达的下一 procedure；`gate_status` 失败返回错误码；不走 wake 的命令由 `gate_status`/guard 兜底。
3. 静态方法论覆盖全部 phase 的目的/产物/决策/评审/验收/交接；不含当前 phase/node、精确 Step、字段名、轮次或权限清单；总则中可以点名 `gate_status`/`gate_record`。用结构检查（禁止 procedure 字段/token）+ 人工评审清单验证。
4. root/worker 分离：worker prompt 保持 node-specific；worker `gate_status` 返回 root 状态但 `procedure:null`；worker 不接收 root procedure。
5. `procedureFor` 接收 `{reviewLimit}` 与完整 state；`verify-standalone` 等 node-specific 派发指令出现在 procedure 中，不能只靠 `NODE_METHODS` 推导。
6. discuss/docs/blocked/complete 返回短 procedure（不是 null），确保 root 不存在“没有当前 procedure”的状态；静态方法论负责目的，短 procedure 负责交接。
7. direct/planned implement、review 轮次、note lifecycle、fix-bug、docs、blocked/resume 行为不回归；快速切换矩阵（含 blocked/complete/docs/fix-bug/direct implement）中 static prompt 不变、procedure 正确；“无跨 phase 泄漏”定义为 procedure 文本等于 `procedureFor(state).text`，且不包含其他 phase/node 的 short procedure 标记。
8. 迁移与文档：README 与 `gate_status`/工具文档更新；旧 Note 在实施完成时按 `write-agent-notes` 归档并标注 superseded-by 本 Note；回滚切换点记录；不读取仓库 `.agents` 治理文档；不增加 Config 字段。
9. 记录静态方法论、procedure、完整 system prompt 的字符/token；在真实 profile 记录 in-history（deepseek-flash）与 leading-only（deepseek-v4-pro，若可用）的 input/cache；报告数字，不设固定 cache 阈值，未测不宣称命中率；Problem 中的 98.73% 已标注 session/provider/route 和旧设计背景。Gate 静态段 ≤ ~4,000 字符、procedure ≤ ~1,600 字符/阶段是 **advisory 目标**：记录实际值，超目标时说明压缩计划，不静默接受。
10. 本 Note 取代 [2026-11-11-gate-prompt-cache.md](../../archived/process/2026-11-11-gate-prompt-cache.md) 的 per-variant 选择；旧篇的 route/cache 理由保留引用。

### Risks

- 模型可能忽略 procedure 或套用其他阶段方法论；缓解：procedure 置顶、静态总则、state 唯一来源、guard、快速切换测试。
- 静态方法论包含所有阶段，可能注意力稀释；按 phase 分节、条件化、短句；设目标：Gate 静态段 ≤ ~4,000 字符（DSH ~1,000 tokens），procedure ≤ ~1,600 字符/阶段；超出时压缩重复而不是删除阶段覆盖，并记录测量。
- 方法论与 `gate-*/SKILL.md` 可能重复/漂移；方法论只写目的/质量/交接，procedure 只引用技能，review 时检查。
- procedure 每次 transition 追加，长会话有重复成本；只在当前 state 推送，compaction 兜底；measure。
- 迁移期间两套 prompt 文本并存；实施需一次性替换、记录回滚点，旧 Note 同批归档，README 同批更新。
- worker 若拿到 root procedure 会与“只执行当前 node”冲突；通过 root-only procedure 与 `procedure:null` 防住。
- DSH 路由差异：procedure 是 tool result/user 消息，前缀保留；不在本方案内宣称 cache 指标，需实测。
- 项目级方法论定制不在本工作项；若需要，另开工作项定义 Config/gate root 接口，避免本 Note 留下未决接口。

[历史快照：Gate system prompt 与节点切换](../../archived/process/2026-11-11-gate-prompt-cache.md)
