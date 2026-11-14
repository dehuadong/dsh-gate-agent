import { DEFAULT_REVIEW_LIMIT } from './config.js'
import type { GateState } from './state.js'
import { isMechanicalDecision } from './note-decisions.js'

export const DISCUSS_ORCHESTRATION = `## discuss

discuss 是默认阶段，不需要命令进入。

讨论不是被动访谈；优先自行分析已有项目上下文，不把可判断的问题交给用户。不要要求用户重复已有信息，也不要求在 discuss 中确定所有实现细节。

- 先读相关代码、文档、历史 Note 与项目约束。
- 明确实际问题、约束、已有决定与冲突。
- 给出有实质差异的可行方案、推荐与关键权衡。
- 只对未决的产品、范围、兼容性、成本、风险等价值判断提问。
- 不创建提案、Note 或规格文件；文件默认只读，不写工作区。提交已有改动（git add/commit/push）不受文件只读影响。
- 汇报：已解决事项、剩余未决事项、建议的下一阶段。
- 不自行离开 discuss；离开必须由用户明确授权。授权可以在对话中要求用户再输入 slash command或 ask_user_question 中给出；获得授权后进入 plan/implement。`

export const PLAN_ORCHESTRATION = `## /gate-enter-plan 编排
主代理派 worker；gate 不派。

## Step 1 — Planning
主 agent 首次进入 planning 时加载技能 gate-planning 和 gate-write-agent-notes；若本会话已加载且内容仍在上文，直接复用，不要重复调用 skill。读取 gate-planning 的 SKILL.md、proposal.md 和 assets/worker-briefs/gate-enter-plan.md 写 planning 任务。
若工作项要写设计节（Note 的 “## Design” / “### 设计” / 自由设计节），必须先读取 rfc.md，按其检查项收敛，并把适用检查点写进 worker prompt；mechanical 或不写设计节的工作项不强制读 rfc。
先按 write-agent-notes §3 检索历史，再按 §4 判定归属与 class；用 gate_note_write 写 Note，路径与 class 必须一致。发现旧 implemented Note 被新决定完全取代时，记下归档候选；新 Note 尚未落地前不要归档。
把工作项、约束和提炼后的规划方法写进 subagent prompt；planning worker 不加载 gate 技能。
完成后调 gate_record({node:'plan', task, notePaths, noteDecision, noteSearch, workerSessionIds})。
notePaths 是 [{path,class,lifecycle}] 数组；path 接受 .agents/notes/<lifecycle>/<class>/...、<lifecycle>/<class>/... 或 <class>/...，gate_record 归一为完整路径；mechanical 用 noteDecision:'mechanical' 且 notePaths 为空；不需要 task 前缀。

## Step 2 — Plan Review
主 agent 首次进入 plan-review 时加载技能 gate-plan-review；若本会话已加载且内容仍在上文，后续多轮 review 直接复用，不要重复调用 skill。读取该技能的 assets/worker-briefs/plan-review.md 写 review 任务，按任务规模和风险自行决定派一个或多个只读 review worker，覆盖 Standards、Spec、Architecture 三轴。
给 worker 工作项、Note、固定点和评审方法；不要在 review worker prompt 中附带项目环境验证（package.json、Node 版本、git 状态、文件存在性、初始化 smoke 结果）。
完成后调 gate_record({node:'plan-review',findings,reviewAxes,workerSessionIds,requiresDiscussion})。
reviewAxes 必须包含 standards、spec、architecture 三轴。
需要用户决定：进入 blocked，等待 /gate-resume；仍有 findings：先 gate_record 本轮 plan-review，确认 node 已变为 plan-revise，再复用已加载的 gate-planning，只带 findings 和 Note 路径派 revise，再 review。

## Step 3 — 回到 Discuss
review 为空时回到 discuss，planReady=true。
实施需要用户另行执行 /gate-enter-implement；不要在 planning 里开始实现。`

export const IMPLEMENT_ORCHESTRATION = `## /gate-enter-implement 编排
主代理派 worker；gate 不派。

## Step 1 — Implement
主 agent 首次进入 implement 时加载技能 gate-implement；若本会话已加载且内容仍在上文，直接复用，不要重复调用 skill。读取该技能的 assets/worker-briefs/gate-enter-implement.md 写 implement 任务。采用测试优先时同时加载 gate-tdd，并把相关规则交给 implement worker。
worker 不加载 gate 技能。
完成后调 gate_record({node:'implement', workerSessionIds})。

## Step 2 — Implementation Review
主 agent 首次进入 code-review 时加载技能 gate-code-review；若本会话已加载且内容仍在上文，后续 review 轮次直接复用，不要重复调用 skill。读取该技能的 assets/worker-briefs/gate-implement-review.md 写 review 任务，按改动规模自行决定派一个或多个只读 review worker，覆盖 Standards 与 Spec 两轴。
完成后调 gate_record({node:'code-review', findings, reviewAxes, workerSessionIds})；有 findings 时先记录，确认 node 已变为 implement-revise，再派 revise worker。
审查要求满足后继续 Step 3，无需再次授权。
实现中发现范围外问题、合同变化或需要重新讨论时，worker 停止并返回 receipt；主 agent 向用户说明，使用 gate_record 的 requiresDiscussion 或提示用户执行 /gate-return-discuss。不要停在 implement 里继续扩大范围。

## Step 3 — Verify
主 agent 首次进入 verify 时加载技能 gate-verify；若本会话已加载且内容仍在上文，直接复用，不要重复调用 skill。读取该技能的 assets/worker-briefs/gate-verify.md 写 verify 任务，派 verify worker 完成最终验收。
完成后调 gate_record({node:'verify', verification, workerSessionIds})；verification.toolResults 必须是 verify worker session log 中真实 tool/result 的 call_... id，evidence 是 workspace 内的普通文件。
只有最终 PASS 才完成交付；FAIL 回到 implement-revise。
状态更新遵循项目登记的工作项与决策记录生命周期。

## Step 4 — Note lifecycle
Verify PASS 后进入 note-lifecycle，不得直接 complete。
主 agent 调 gate_note_finalize，再调 gate_note_verify；通过后 gate_record({node:'note-lifecycle'})。
mechanical 工作项自动跳过；跨会话 journal 只报告不恢复；archived manifest 只由用户执行 /gate-note-seal。note-lifecycle 完成后建议提交本次实现与 Note；gate 不自动执行 git add/commit。`

export const DOCS_ORCHESTRATION = `## /gate-docs 编排
范围由模型按项目实际文档需要判断。
完成后调 gate_record({node:'docs'}) 回到 discuss。`

export const NOTE_LIFECYCLE_ORCHESTRATION = `## Note lifecycle
Verify 已 PASS；当前不派 worker，也不写业务代码。
按顺序执行：gate_note_finalize → gate_note_verify → gate_record({node:'note-lifecycle'})。
finalize/verify 失败留在本节点修复；archived manifest 缺失时提示用户执行 /gate-note-seal。
只有 noteVerified=true 才能 gate_record 完成；mechanical 工作项可跳过 finalize。完成后建议提交本次实现与 Note；gate 不自动 git add/commit。完成后检查本次新 Note 是否完全取代了某篇 implemented Note：有独立参考价值就在最终汇报中给出归档候选和目标命令，没有独立价值则建议删除；不要自动归档。`


export const GATE_RECORD_NODES = ['plan', 'plan-review', 'proposal-review', 'plan-revise', 'implement', 'code-review', 'implement-revise', 'verify', 'verify-standalone', 'note-lifecycle', 'docs', 'code-review-standalone']

/** Per-node prompt metadata: protocol variant and the method the root agent loads before dispatch. */
export const NODE_INFO: Record<string, { variant: string; method: string }> = {
  plan: { variant: 'plan', method: '`gate-planning` + `gate-write-agent-notes`' },
  'plan-review': { variant: 'plan', method: '`gate-plan-review`' },
  'plan-revise': { variant: 'plan', method: '`gate-planning` + `gate-write-agent-notes`' },
  'proposal-review': { variant: 'reviewing-proposal', method: '`gate-plan-review`（三轴）' },
  implement: { variant: 'implement', method: '`gate-implement`' },
  'implement-revise': { variant: 'implement', method: '`gate-implement`' },
  'code-review': { variant: 'implement', method: '`gate-code-review` (one skill, both axes)' },
  'code-review-standalone': { variant: 'reviewing-code', method: '`gate-code-review` (one skill, both axes)' },
  verify: { variant: 'implement', method: '`gate-verify`' },
  'verify-standalone': { variant: 'reviewing-verify', method: '无' },
  'note-lifecycle': { variant: 'note-lifecycle', method: '`gate-write-agent-notes`（lifecycle 工具，不是 worker）' },
  docs: { variant: 'docs', method: '无' },
}

/** Node-to-method view used by procedures and coverage tests. */
export const NODE_METHODS: Record<string, string> = Object.fromEntries(Object.entries(NODE_INFO).map(([node, info]) => [node, info.method]))

/** Nodes that dispatch a worker; docs and note-lifecycle finish in the root agent. */
export const WORKER_NODES = new Set(GATE_RECORD_NODES.filter(node => node !== 'docs' && node !== 'note-lifecycle'))

export const DISPATCH_RULE = `## 技能加载规则
- 本会话已经通过 skill 工具加载过的技能，内容仍在上文时直接复用，不要重复调用 skill。
- 只有以下情况才重新加载：本会话首次进入该技能；compaction 后内容已不在上下文；技能文件/版本发生变化；用户明确要求刷新。
- gate_record / gate_status 返回新的 procedure 只代表 node、轮次或 findings 变化，不代表要重新加载技能。
- 多轮 review/revise 复用同一份技能内容；把新的 findings、文件范围和要求传给 worker，不要重新加载技能。`

export const REVIEWING_CODE_PROCEDURE = `## /gate-implement-review 编排
主 agent 首次进入时加载 gate-code-review；已加载则复用，不要重复调用 skill。派只读 review worker 覆盖 Standards 与 Spec 两轴；完成后 gate_record({node:'code-review-standalone', findings, reviewAxes, workerSessionIds}) 回 discuss。`

export const REVIEWING_PROPOSAL_PROCEDURE = `## /gate-propose-review 编排
主 agent 首次进入时加载 gate-plan-review；已加载则复用，不要重复调用 skill。派只读 review worker 覆盖 Standards/Spec/Architecture 三轴；完成后 gate_record({node:'proposal-review', findings, reviewAxes, workerSessionIds}) 回 discuss。`

export const REVIEWING_VERIFY_PROCEDURE = `## /gate-code-verify 编排
派子代理加载使用 gate-user-verify 按 Step 6 汇报；verification.toolResults 必须是 verify worker session log 中真实 tool/result 的 call_... id，evidence 是 workspace 内的普通文件；完成后 gate_record({node:'verify-standalone', verification, workerSessionIds}) 回 discuss。`

export function stepSection(text: string, from: string, to: string | undefined) {
  const start = text.indexOf(from)
  if (start < 0) return ''
  const end = to === undefined ? text.length : text.indexOf(to, start)
  return text.slice(start, end < 0 ? text.length : end).trim()
}

export const PLAN_STEP_1 = stepSection(PLAN_ORCHESTRATION, '## Step 1', '## Step 2')
export const PLAN_STEP_2 = stepSection(PLAN_ORCHESTRATION, '## Step 2', '## Step 3')
export const IMPLEMENT_STEP_1 = stepSection(IMPLEMENT_ORCHESTRATION, '## Step 1', '## Step 2')
export const IMPLEMENT_STEP_2 = stepSection(IMPLEMENT_ORCHESTRATION, '## Step 2', '## Step 3')
export const IMPLEMENT_STEP_3 = stepSection(IMPLEMENT_ORCHESTRATION, '## Step 3', '## Step 4')

export const NODE_PROCEDURES: Record<string, string> = {
  plan: PLAN_STEP_1,
  'plan-review': PLAN_STEP_2,
  'plan-revise': `## Plan revise\n根据 findings 用 gate_note_write 更新 Note；完成后 gate_record({node:'plan-revise'}) 回到 plan-review，再按 plan-review procedure review。`,
  implement: IMPLEMENT_STEP_1,
  'code-review': IMPLEMENT_STEP_2,
  'implement-revise': `## Implement revise\n修复 findings；重跑测试；完成后 gate_record({node:'implement-revise'}) 回到 code-review，再按 code-review procedure review。`,
  verify: IMPLEMENT_STEP_3,
  'note-lifecycle': NOTE_LIFECYCLE_ORCHESTRATION,
  'code-review-standalone': REVIEWING_CODE_PROCEDURE,
  'proposal-review': REVIEWING_PROPOSAL_PROCEDURE,
  'verify-standalone': REVIEWING_VERIFY_PROCEDURE,
}

export const METHODOLOGY_KEYS = [
  'discuss',
  'orchestrating/plan',
  'orchestrating/plan-review',
  'orchestrating/plan-revise',
  'orchestrating/implement',
  'orchestrating/code-review',
  'orchestrating/implement-revise',
  'orchestrating/verify',
  'orchestrating/note-lifecycle',
  'docs',
  'reviewing/code-review-standalone',
  'reviewing/proposal-review',
  'reviewing/verify-standalone',
  'blocked',
  'complete',
  'orchestrating',
  'reviewing',
] as const

const METHODOLOGY_KEY_SET = new Set<string>(METHODOLOGY_KEYS)

export function methodologyKeyFor(state: GateState): string {
  if (state.phase === 'orchestrating' || state.phase === 'reviewing') {
    const key = state.node === null ? state.phase : `${state.phase}/${state.node}`
    return METHODOLOGY_KEY_SET.has(key) ? key : state.phase
  }
  return state.phase
}

export const GATE_METHODOLOGY = `## Gate 方法论
本段只定义各阶段的工作方法与质量标准。当前 phase/node、procedure 和要加载的技能来自最近一次 gate_status、gate_record 或命令结果；只执行当前 phase 的 procedure，其他阶段的方法论仅作背景参考；compaction 后必须重新获取 procedure，并确认技能内容是否仍在上下文：首次需要时加载，已在上文则复用，不要因 procedure 更新重复加载。不确定有哪些 /gate-* 命令或工具用途时，调用只读 gate_help。

${DISCUSS_ORCHESTRATION}

## orchestrating/plan · orchestrating/plan-review · orchestrating/plan-revise
把讨论共识、既有决策与用户需求收敛成可实施计划与 proposed Note；计划必须写清范围、验收、备选与风险。Plan Review 独立判断；findings 先记录再 revise；review 通过后回 discuss。不要在规划里开始实现。

## orchestrating/implement · orchestrating/implement-revise
按已确认的计划或讨论后的实施说明实施并完成测试；实现后做独立 review，再用可执行证据 verify；最后完成 Note lifecycle。不扩大范围，不在实现中重新规划。

## orchestrating/code-review
独立判断改动是否满足合同与标准；只报 findings，不修代码、不替代 verify；findings 记录后再进入 revise。

## orchestrating/verify
用可执行证据判定 PASS/FAIL；不修改产品/测试让结果变绿；FAIL 回 implement-revise。

## orchestrating/note-lifecycle
完成 Note 的 finalize 与校验；不写业务代码；检查是否产生归档候选；完成后回 discuss。


## docs
文档治理；不改变功能行为；范围由模型按项目实际文档需要判断；完成后回 discuss。

## reviewing/code-review-standalone
只读 code review：独立判断 Standards 与 Spec 两轴，只输出 findings，不修代码、不替代 verify。

## reviewing/proposal-review
只读提案评审：覆盖 Standards、Spec、Architecture 三轴，只输出判断，不修改规划、不自动 revise。

## reviewing/verify-standalone
只读独立验收：不改代码、不替代 implement，只输出 PASS/FAIL 与证据判断。

## blocked
blocked 表示冻结：等待 /gate-resume。

## complete
complete 表示当前任务完成，新任务需要重新授权。

## orchestrating
当前处于 orchestrating 但没有匹配 node；调用 gate_status 重新读取；若仍不一致，回 discuss 修复 Gate 状态。

## reviewing
当前处于 reviewing 但没有匹配 node；调用 gate_status 重新读取；若仍不一致，回 discuss 修复 Gate 状态。`

/**
 * Procedure variant for the current phase/node. The root prompt is static; this
 * key only selects the current procedure and its method.
 * @param {object} state - normalized gate state.
 * @returns {string} variant key.
 */
export function protocolVariant(state: GateState) {
  if (state.phase === 'orchestrating') return NODE_INFO[state.node ?? '']?.variant ?? state.phase
  if (state.phase === 'reviewing') return NODE_INFO[state.node ?? '']?.variant ?? 'reviewing-code'
  return state.phase
}

/**
 * Current root procedure for one state. Every root phase has a procedure:
 * discuss/docs/blocked/complete are short handoff procedures.
 * @param {object} state - normalized gate state.
 * @param {{reviewLimit?: number}} options - review limit for round text.
 * @returns {{phase: string, node: string|null, method: string, text: string, hasRounds: boolean}}
 */
export function procedureFor(state: GateState, { reviewLimit = DEFAULT_REVIEW_LIMIT }: { reviewLimit?: number } = {}) {
  const variant = protocolVariant(state)
  const method = NODE_METHODS[state.node ?? ''] ?? '无'
  let text
  if (variant === 'discuss') {
    text = 'discuss 不派 worker；文件默认只读，提交已有改动不受影响；用户授权后调用 gate_start_phase 进入 plan/implement。'
  } else if (variant === 'blocked') {
    text = `Gate 已冻结：${state.blockReason ?? 'unknown'}；解冻后回 ${state.blockedFrom?.phase ?? 'discuss'} / ${state.blockedFrom?.node ?? '无'}；用 /gate-resume。`
  } else if (variant === 'complete') {
    text = 'Gate 已完成；新任务需要重新授权。'
  } else if (variant === 'docs') {
    text = DOCS_ORCHESTRATION
  } else {
    text = NODE_PROCEDURES[state.node ?? ''] ?? ''
  }
  if (text === '') {
    text = '当前 phase/node 没有匹配的 procedure；调用 gate_status 重新读取；若仍不一致，回 discuss 修复 Gate 状态。'
  }
  if (['plan', 'implement', 'reviewing-code', 'reviewing-proposal', 'reviewing-verify'].includes(variant)) {
    text = [text, DISPATCH_RULE].filter(Boolean).join('\n\n')
  }
  if (variant === 'plan' || variant === 'implement') {
    text = [text, `## 当前轮次\n${roundsText(state, reviewLimit)}`].filter(Boolean).join('\n\n')
  }
  return { phase: state.phase, node: state.node, methodologyKey: methodologyKeyFor(state), method, text, hasRounds: variant === 'plan' || variant === 'implement' }
}

export function procedureFailure(state: GateState, reviewLimit: number, fields: Record<string, unknown>) {
  const procedure = procedureFor(state, { reviewLimit })
  return { ok: false, ...fields, procedure, method: procedure.method }
}




export function roundNumbers(state: GateState) {
  const inPlan = state.node === 'plan-review'
  const inCode = state.node === 'code-review'
  return {
    inPlan,
    inCode,
    planRound: (state.rounds?.planReview ?? 0) + (inPlan ? 1 : 0),
    codeRound: (state.rounds?.codeReview ?? 0) + (inCode ? 1 : 0),
  }
}

export function roundsText(state: GateState, reviewLimit: number) {
  const { inPlan, inCode, planRound, codeRound } = roundNumbers(state)
  return `plan ${planRound}/${reviewLimit}${inPlan ? '（当前）' : ''}, code ${codeRound}/${reviewLimit}${inCode ? '（当前）' : ''}`
}

export function statusText(state: GateState, reviewLimit = DEFAULT_REVIEW_LIMIT, { includeRounds = true }: { includeRounds?: boolean } = {}) {
  const { inPlan, inCode } = roundNumbers(state)
  const lines = [
    `状态：${state.phase}`,
    `节点：${state.node ?? '无'}`,
    `事项：${state.task ?? '无'}`,
    ...(state.phase === 'blocked' ? [`解冻后：${state.blockedFrom?.phase ?? 'discuss'}${state.blockedFrom?.node === null || state.blockedFrom?.node === undefined ? '' : ` / ${state.blockedFrom.node}`}`] : []),
    `work：${state.work}`,
    `blockReason：${state.blockReason ?? '无'}`,
    `planReady：${state.planReady ? '是' : '否'}`,
    ...(includeRounds ? [`rounds：${roundsText(state, reviewLimit)}`] : []),
  ]
  if (state.notePaths?.length > 0 || isMechanicalDecision(state.noteDecision)) {
    lines.push(`notes：${state.noteDecision ?? '无'} ${state.notePaths?.length ?? 0} 篇，verified=${state.noteVerified === true ? '是' : '否'}`)
  }
  if (state.exhausted?.plan === true || state.exhausted?.code === true) {
    lines.push(`exhausted：plan ${state.exhausted.plan ? '是' : '否'}, code ${state.exhausted.code ? '是' : '否'}`)
  }
  if (state.verification !== null) {
    lines.push(`verify：${state.verification.passed === true ? 'PASS' : 'FAIL'}（${state.verification.selfReported === true ? 'self-reported' : 'verified'}）`)
  }
  return lines.join('\n')
}

export interface Procedure { phase: string; node: string | null; methodologyKey: string; method: string; text: string; hasRounds: boolean }

export function procedureBlock(procedure: Procedure) {
  return `当前 phase/node：${procedure.phase} / ${procedure.node ?? '无'}\n方法论：${procedure.methodologyKey}\n方法：${procedure.method}\n\n${procedure.text}`
}

export function procedureResultText(procedure: Procedure, trailing: string) {
  return [procedureBlock(procedure), trailing].filter(Boolean).join('\n\n---\n\n')
}

export function renderProcedureResult(value: any) {
  const { procedure, ...rest } = value ?? {}
  const trailing = JSON.stringify(rest)
  return [{ type: 'text', text: procedure !== null && procedure !== undefined ? procedureResultText(procedure, trailing) : trailing }]
}


