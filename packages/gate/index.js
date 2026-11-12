import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyPath, shellAccess } from './src/classify.js'
import { defaultState, loadState, normalizeState, saveState } from './src/state.js'

export const inject = ['tools']
const SKILLS = fileURLToPath(new URL('./skills', import.meta.url))
const NOTES_SKILL_DIR = path.join(SKILLS, 'gate-write-agent-notes')
const NOTES_LAUNCHER_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launchers', 'verify-notes.mjs')
const NOTES_CI_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launchers', 'verify-notes.yml')
const NOTES_CI_SCRIPTS = [
  'agent-note-tree.ts',
  'verify-agent-note-tree.ts',
  'verify-agent-note-format.ts',
  'verify-agent-note-lifecycle.ts',
  'verify-archived-agent-notes.ts',
]
const NOTES_BLOCK_START = '<!-- gate-notes:start -->'
const NOTES_BLOCK_END = '<!-- gate-notes:end -->'
const NOTES_AGENTS_TEXT = `${NOTES_BLOCK_START}
## 重要改动必须留笔记

1. 非平凡改动（行为、架构、跨文件契约、流程/工具链、测试策略、落盘/网络/配置格式）在动手前使用内置技能 \`gate-write-agent-notes\`，按 §3 检索、§4 判定归属与 class；机械性小改直接提交。
2. 既有决定未变时原地同步 \`implemented/\` Note；新想法先放 \`proposed/\`；落地随同代码转 \`implemented/\`。
3. 被放弃的方案先写最强理由再否决。
4. 提交前运行 \`npm run verify-notes\` 检查；gate 会话内也可用 \`/gate-note-verify\`。gate 的 lifecycle 由 \`gate_note_finalize\` → \`gate_note_verify\` → \`gate_record({node:'note-lifecycle'})\` 完成。
${NOTES_BLOCK_END}`
const DEFAULT_REVIEW_LIMIT = 5

const SCHEMASTERY = Symbol.for('schemastery')

/** Deployment-level knobs for this plugin installation. */
export const Config = {
  [SCHEMASTERY]: true,
  type: 'object',
  meta: { default: {} },
  dict: {
    reviewLimit: {
      [SCHEMASTERY]: true,
      type: 'number',
      meta: { default: DEFAULT_REVIEW_LIMIT, min: 1, max: 20, step: 1 },
    },
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-gate-agent',
    validate(value) {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'gate config must be an object' }] }
      }
      const unknown = Object.keys(value).filter(key => key !== 'reviewLimit')
      if (unknown.length > 0) {
        return { issues: [{ message: `unknown gate config keys: ${unknown.join(', ')}` }] }
      }
      const out = {}
      if (value.reviewLimit !== undefined) {
        if (!Number.isInteger(value.reviewLimit) || value.reviewLimit < 1 || value.reviewLimit > 20) {
          return { issues: [{ message: 'reviewLimit must be an integer from 1 to 20' }] }
        }
        out.reviewLimit = value.reviewLimit
      }
      return { value: out }
    },
  },
}

export const DISCUSS_ORCHESTRATION = `## Discuss

discuss 是默认阶段，不需要命令进入。

1. 先读相关代码、文档、历史 Note 与项目约束。
2. 明确实际问题、约束、已有决定与冲突。
3. 给出有实质差异的可行方案、推荐与关键权衡。
4. 只对未决的产品、范围、兼容性、成本、风险等价值判断提问。
5. 不创建提案、Note 或规格文件。
6. 汇报：已解决事项、剩余未决事项、建议的下一阶段。
7. 不自行离开 discuss；离开必须由用户明确授权。授权可以在对话或 ask_user_question 中给出；获得授权后进入 plan/implement，不要要求用户再输入 slash command。`

export const PLAN_ORCHESTRATION = `## /gate-enter-plan 编排
主代理派 worker；gate 不派。

## Step 1 — Planning
主 agent 加载技能 gate-planning 和 gate-write-agent-notes；读取 gate-planning 的 assets/worker-briefs/gate-enter-plan.md 写 planning 任务。
先按 write-agent-notes §3 检索历史，再按 §4 判定归属与 class；用 gate_note_write 写 Note，路径与 class 必须一致。发现旧 implemented Note 被新决定完全取代时，记下归档候选；新 Note 尚未落地前不要归档。
把工作项、约束和提炼后的规划方法写进 subagent prompt；planning worker 不加载 gate 技能。
完成后调 gate_record({node:'plan', task, notePaths, noteDecision, noteSearch, workerSessionIds})。
notePaths 是 [{path,class,lifecycle}] 数组；mechanical:<说明> 用 noteDecision:'mechanical' 且 notePaths 为空。

## Step 2 — Plan Review
主 agent 加载技能 gate-plan-review；读取该技能的 assets/worker-briefs/plan-review.md 写 review 任务，按任务规模和风险自行决定派一个或多个只读 review worker，覆盖 Standards、Spec、Architecture 三轴。
给 worker 工作项、Note、固定点和评审方法；不要在 review worker prompt 中附带项目环境验证（package.json、Node 版本、git 状态、文件存在性、初始化 smoke 结果）。
完成后调 gate_record({node:'plan-review',findings,reviewAxes,workerSessionIds,requiresDiscussion})。
reviewAxes 必须包含 standards、spec、architecture 三轴。
需要用户决定：进入 blocked，等待 /gate-resume；仍有 findings：先 gate_record 本轮 plan-review，确认 node 已变为 plan-revise，再重新加载 gate-planning，只带 findings 和 Note 路径派 revise，再 review。

## Step 3 — 回到 Discuss
review 为空时回到 discuss，planReady=true。
实施需要用户另行执行 /gate-enter-implement；不要在 planning 里开始实现。`

export const IMPLEMENT_ORCHESTRATION = `## /gate-enter-implement 编排
主代理派 worker；gate 不派。

## Step 1 — Implement
主 agent 加载技能 gate-implement；读取该技能的 assets/worker-briefs/gate-enter-implement.md 写 implement 任务。采用测试优先时同时加载 gate-tdd，并把相关规则交给 implement worker。
worker 不加载 gate 技能。
完成后调 gate_record({node:'implement', workerSessionIds})。

## Step 2 — Implementation Review
主 agent 加载技能 gate-code-review；读取该技能的 assets/worker-briefs/gate-implement-review.md 写 review 任务，按改动规模自行决定派一个或多个只读 review worker，覆盖 Standards 与 Spec 两轴。
完成后调 gate_record({node:'code-review', findings, reviewAxes, workerSessionIds})；有 findings 时先记录，确认 node 已变为 implement-revise，再派 revise worker。
审查要求满足后继续 Step 3，无需再次授权。
实现中发现范围外问题、合同变化或需要重新讨论时，worker 停止并返回 receipt；主 agent 向用户说明，使用 gate_record 的 requiresDiscussion 或提示用户执行 /gate-return-discuss。不要停在 implement 里继续扩大范围。

## Step 3 — Verify
主 agent 加载技能 gate-verify，读取该技能的 assets/worker-briefs/gate-verify.md 写 verify 任务，派 verify worker 完成最终验收。
完成后调 gate_record({node:'verify', verification, workerSessionIds})。
只有最终 PASS 才完成交付；FAIL 回到 implement-revise。
状态更新遵循项目登记的工作项与决策记录生命周期。

## Step 4 — Note lifecycle
Verify PASS 后进入 note-lifecycle，不得直接 complete。
主 agent 调 gate_note_finalize，再调 gate_note_verify；通过后 gate_record({node:'note-lifecycle'})。
mechanical 工作项自动跳过；跨会话 journal 只报告不恢复；archived manifest 只由用户执行 /gate-note-seal。回 discuss 前 gate 会执行一次 git add -A + git commit；非 git 或无改动跳过。`

export const FIX_BUG_ORCHESTRATION = `## /gate-fix-bug 编排
主 agent 读取 gate-fix-bug；主 agent 只汇总，不自行修复。

## Step 1 — Fix
主 agent 读取 gate-fix-bug 技能的 assets/worker-briefs/gate-fix-bug.md，派 fix worker。fix worker 使用 gate-fix-bug 执行 Process 1-9：复现、回归覆盖、根因、最小修复、原复现与相关测试。完成后返回修复 receipt；不要自行完成 Step 10-12，也不要提交。

## Step 2 — Independent review
主 agent 加载 gate-code-review，提炼两轴评审要求，再读取 gate-fix-bug 技能的 assets/worker-briefs/fix-bug-review.md，派一个独立 review worker；修复基线、选定失败、合同引用和完整 diff 写进简报。review 只报 findings。

## Step 3 — Resolve
把 material in-scope findings 交回 fix worker（send_message 或新 worker），完成 gate-fix-bug Step 11-12，重跑原复现和相关测试；重复 Step 2-3 直到没有 material findings。

## Step 4 — Record
完成后调 gate_record({node:'fix-bug', workerSessionIds})，workerSessionIds 包含 fix 与 review worker；gate 会 git add -A + git commit 后回 discuss。`

export const DOCS_ORCHESTRATION = `## /gate-docs 编排
不加载 gate 技能；范围由模型按项目实际文档需要判断。
完成后调 gate_record({node:'docs'}) 回到 discuss。`

export const NOTE_LIFECYCLE_ORCHESTRATION = `## Note lifecycle
Verify 已 PASS；当前不派 worker，也不写业务代码。
按顺序执行：gate_note_finalize → gate_note_verify → gate_record({node:'note-lifecycle'})。
finalize/verify 失败留在本节点修复；archived manifest 缺失时提示用户执行 /gate-note-seal。
只有 noteVerified=true 才能 gate_record 完成；mechanical 工作项可跳过 finalize。完成后检查本次新 Note 是否完全取代了某篇 implemented Note：有独立参考价值就在最终汇报中给出归档候选和目标命令，没有独立价值则建议删除；不要自动归档。`

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolveNotesSkill() {
  const skill = path.join(NOTES_SKILL_DIR, 'SKILL.md')
  if (!existsSync(skill)) return undefined
  const template = path.join(NOTES_SKILL_DIR, 'templates', 'proposed.md')
  return { skill, template: existsSync(template) ? template : undefined }
}

/** Nodes `gate_record` accepts. Shared by the tool schema, prompt metadata, and tests. */
export const GATE_RECORD_NODES = ['plan', 'plan-review', 'proposal-review', 'plan-revise', 'implement', 'code-review', 'implement-revise', 'verify', 'verify-standalone', 'note-lifecycle', 'docs', 'code-review-standalone', 'fix-bug']

/** Per-node prompt metadata: protocol variant and the method the root agent loads before dispatch. */
const NODE_INFO = {
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
  'fix-bug': { variant: 'fix-bug', method: '`gate-fix-bug`' },
}

/** Node-to-method view used by procedures and coverage tests. */
export const NODE_METHODS = Object.fromEntries(Object.entries(NODE_INFO).map(([node, info]) => [node, info.method]))

/** Nodes that dispatch a worker; docs and note-lifecycle finish in the root agent. */
export const WORKER_NODES = new Set(GATE_RECORD_NODES.filter(node => node !== 'docs' && node !== 'note-lifecycle'))

const DISPATCH_RULE = `## 派发规则
每次派 subagent 前，按当前 procedure 的 method 重新加载技能；不要使用记忆中的节点或技能；多轮/压缩后重新确认。`

const REVIEWING_CODE_PROCEDURE = `## /gate-implement-review 编排
主 agent 加载 gate-code-review；派只读 review worker 覆盖 Standards 与 Spec 两轴；完成后 gate_record({node:'code-review-standalone', findings, reviewAxes, workerSessionIds}) 回 discuss。`

const REVIEWING_PROPOSAL_PROCEDURE = `## /gate-propose-review 编排
主 agent 加载 gate-plan-review；派只读 review worker 覆盖 Standards/Spec/Architecture 三轴；完成后 gate_record({node:'proposal-review', findings, reviewAxes, workerSessionIds}) 回 discuss。`

const REVIEWING_VERIFY_PROCEDURE = `## /gate-code-verify 编排
派子代理加载使用 gate-user-verify 按 Step 6 汇报；完成后 gate_record({node:'verify-standalone', verification, workerSessionIds}) 回 discuss。`

function stepSection(text, from, to) {
  const start = text.indexOf(from)
  if (start < 0) return ''
  const end = to === undefined ? text.length : text.indexOf(to, start)
  return text.slice(start, end < 0 ? text.length : end).trim()
}

const PLAN_STEP_1 = stepSection(PLAN_ORCHESTRATION, '## Step 1', '## Step 2')
const PLAN_STEP_2 = stepSection(PLAN_ORCHESTRATION, '## Step 2', '## Step 3')
const IMPLEMENT_STEP_1 = stepSection(IMPLEMENT_ORCHESTRATION, '## Step 1', '## Step 2')
const IMPLEMENT_STEP_2 = stepSection(IMPLEMENT_ORCHESTRATION, '## Step 2', '## Step 3')
const IMPLEMENT_STEP_3 = stepSection(IMPLEMENT_ORCHESTRATION, '## Step 3', '## Step 4')

const NODE_PROCEDURES = {
  plan: PLAN_STEP_1,
  'plan-review': PLAN_STEP_2,
  'plan-revise': `## Plan revise\n根据 findings 用 gate_note_write 更新 Note；完成后 gate_record({node:'plan-revise'}) 回到 plan-review，再按 plan-review procedure review。`,
  implement: IMPLEMENT_STEP_1,
  'code-review': IMPLEMENT_STEP_2,
  'implement-revise': `## Implement revise\n修复 findings；重跑测试；完成后 gate_record({node:'implement-revise'}) 回到 code-review，再按 code-review procedure review。`,
  verify: IMPLEMENT_STEP_3,
  'note-lifecycle': NOTE_LIFECYCLE_ORCHESTRATION,
  'fix-bug': FIX_BUG_ORCHESTRATION,
  'code-review-standalone': REVIEWING_CODE_PROCEDURE,
  'proposal-review': REVIEWING_PROPOSAL_PROCEDURE,
  'verify-standalone': REVIEWING_VERIFY_PROCEDURE,
}

const GATE_METHODOLOGY = `## Gate 方法论
本段只定义各阶段的工作方法与质量标准。当前 phase/node、procedure 和要加载的技能来自最近一次 gate_status、gate_record 或命令结果；只执行当前 phase 的 procedure，其他阶段的方法论仅作背景参考；compaction 后必须重新获取。

## discuss
discuss 是默认阶段。先读相关代码、文档、历史 Note 与项目约束；明确实际问题、约束、已有决定与冲突；给出有实质差异的可行方案、推荐与关键权衡；只对未决的产品、范围、兼容性、成本、风险等价值判断提问；汇报已解决、未决事项和建议下一阶段。不进入实施，只有用户明确授权才离开。

## plan
把用户简述收敛成可实施计划与 proposed Note；计划必须写清范围、验收、备选与风险。Plan Review 独立判断；findings 先记录再 revise；review 通过后回 discuss。不要在规划里开始实现。

## implement
按已确认的计划实施并完成测试；实现后做独立 review，再用可执行证据 verify；最后完成 Note lifecycle。不扩大范围，不在实现中重新规划。

## code-review
独立判断改动是否满足合同与标准；只报 findings，不修代码、不替代 verify；findings 记录后再进入 revise。

## verify
用可执行证据判定 PASS/FAIL；不修改产品/测试让结果变绿；FAIL 回 implement-revise。

## note-lifecycle
完成 Note 的 finalize 与校验；不写业务代码；检查是否产生归档候选；完成后回 discuss。

## fix-bug
对已授权的实现缺陷：复现、回归覆盖、根因、最小修复、独立 review；不做新功能、不扩大范围；完成后回 discuss。

## docs
文档治理；不改变功能行为；范围由模型按项目实际文档需要判断；完成后回 discuss。

## reviewing-code
只读 code review：独立判断 Standards 与 Spec 两轴，只输出 findings，不修代码、不替代 verify。

## reviewing-proposal
只读提案评审：覆盖 Standards、Spec、Architecture 三轴，只输出判断，不修改规划、不自动 revise。

## reviewing-verify
只读独立验收：不改代码、不替代 implement，只输出 PASS/FAIL 与证据判断。

## blocked / complete
blocked 表示冻结：等待 /gate-resume 或 /gate-return-discuss。complete 表示当前任务完成，新任务需要重新授权。`

/**
 * Procedure variant for the current phase/node. The root prompt is static; this
 * key only selects the current procedure and its method.
 * @param {object} state - normalized gate state.
 * @returns {string} variant key.
 */
function protocolVariant(state) {
  if (state.phase === 'orchestrating') return NODE_INFO[state.node]?.variant ?? state.phase
  if (state.phase === 'reviewing') return NODE_INFO[state.node]?.variant ?? 'reviewing-code'
  return state.phase
}

/**
 * Current root procedure for one state. Every root phase has a procedure:
 * discuss/docs/blocked/complete are short handoff procedures.
 * @param {object} state - normalized gate state.
 * @param {{reviewLimit?: number}} options - review limit for round text.
 * @returns {{phase: string, node: string|null, method: string, text: string, hasRounds: boolean}}
 */
function procedureFor(state, { reviewLimit = DEFAULT_REVIEW_LIMIT } = {}) {
  const variant = protocolVariant(state)
  const method = NODE_METHODS[state.node] ?? '无'
  let text
  if (variant === 'discuss') {
    text = '无 worker/write；用户授权后调用 gate_start_phase 进入 plan/implement。'
  } else if (variant === 'blocked') {
    text = `Gate 已冻结：${state.blockReason ?? 'unknown'}；解冻后回 ${state.blockedFrom?.phase ?? 'discuss'} / ${state.blockedFrom?.node ?? '无'}；用 /gate-resume 或 /gate-return-discuss。`
  } else if (variant === 'complete') {
    text = 'Gate 已完成；新任务需要重新授权。'
  } else if (variant === 'docs') {
    text = DOCS_ORCHESTRATION
  } else {
    text = NODE_PROCEDURES[state.node] ?? ''
  }
  if (text === '') {
    text = '当前 phase/node 没有匹配的 procedure；调用 gate_status 重新读取；若仍不一致，回 discuss 修复 Gate 状态。'
  }
  if (['plan', 'implement', 'fix-bug', 'reviewing-code', 'reviewing-proposal', 'reviewing-verify'].includes(variant)) {
    text = [text, DISPATCH_RULE].filter(Boolean).join('\n\n')
  }
  if (variant === 'plan' || variant === 'implement') {
    text = [text, `## 当前轮次\n${roundsText(state, reviewLimit)}`].filter(Boolean).join('\n\n')
  }
  return { phase: state.phase, node: state.node, method, text, hasRounds: variant === 'plan' || variant === 'implement' }
}

function procedureFailure(state, reviewLimit, fields) {
  const procedure = procedureFor(state, { reviewLimit })
  return { ok: false, ...fields, procedure, method: procedure.method }
}



function commitGateChanges(root, state) {
  const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  try {
    git(['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { ok: true, skipped: 'not-git' }
  }
  try {
    if (git(['status', '--porcelain']).trim() === '') return { ok: true, skipped: 'clean' }
    git(['add', '-A'])
    const message = `gate: ${state.task ?? 'complete'}`.replace(/\s+/gu, ' ').slice(0, 200)
    git(['commit', '-m', message])
    return { ok: true, committed: true }
  } catch (error) {
    return { ok: false, reason: String(error?.stderr ?? error?.message ?? error).trim() }
  }
}

function resolveNodeBinary() {
  if (!process.versions?.electron) return process.execPath
  const configured = process.env.DSH_DESKTOP_NODE_EXECUTABLE
  if (typeof configured === 'string' && configured !== '' && existsSync(configured)) return configured
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    const bin = path.join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(bin)) return bin
  }
  return undefined
}

function runNotesScripts(root) {
  const node = resolveNodeBinary()
  if (node === undefined) return { ok: false, code: 'notes-runtime-unavailable', results: [] }
  const notes = path.join(root, '.agents', 'notes')
  const scripts = [
    'verify-agent-note-tree.ts',
    'verify-agent-note-format.ts',
    'verify-agent-note-lifecycle.ts',
    'verify-archived-agent-notes.ts',
  ]
  const results = []
  for (const name of scripts) {
    const script = path.join(NOTES_SKILL_DIR, 'scripts', name)
    try {
      const output = execFileSync(node, [script, '--root', notes], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      results.push({ name, ok: true, output: String(output).trim() })
    } catch (error) {
      return {
        ok: false,
        code: 'note-verification-failed',
        results: [...results, { name, ok: false, output: String(error?.stdout ?? '').trim(), error: String(error?.stderr ?? error?.message ?? error).trim() }],
      }
    }
  }
  return { ok: true, results }
}

function splitNoteSections(content) {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n')
  const preamble = []
  const sections = []
  let current = null
  let fenced = false
  for (const line of lines) {
    if (/^\s*```/u.test(line)) fenced = !fenced
    if (!fenced && /^## /u.test(line)) {
      current = { heading: line, body: [] }
      sections.push(current)
    } else if (current === null) {
      preamble.push(line)
    } else {
      current.body.push(line)
    }
  }
  return { preamble, sections }
}

export function transformImplemented(content) {
  const { preamble, sections } = splitNoteSections(content)
  const statusIndex = preamble.findIndex(line => /^Status:/u.test(line))
  if (statusIndex >= 0) preamble[statusIndex] = 'Status: implemented'
  const kept = []
  const extras = []
  let hasDecision = false
  let consequences = null
  for (const section of sections) {
    if (/^## Proposal\s*$/u.test(section.heading)) {
      section.heading = '## Decision'
      hasDecision = true
    }
    if (/^## Plan\s*$/u.test(section.heading)) continue
    if (/^## Acceptance criteria\s*$/u.test(section.heading)) {
      extras.push({ heading: '### Acceptance criteria', body: section.body.join('\n').trim() })
      continue
    }
    if (/^## Risks\s*$/u.test(section.heading)) {
      extras.push({ heading: '### Risks', body: section.body.join('\n').trim() })
      continue
    }
    if (/^## Consequences\s*$/u.test(section.heading)) consequences = section
    kept.push(section)
  }
  if (!hasDecision) throw new Error('Note 缺少 ## Proposal，无法转成 ## Decision')
  const extraText = extras.filter(item => item.body !== '').map(item => `${item.heading}\n\n${item.body}`).join('\n\n')
  if (extraText !== '') {
    if (consequences === null) {
      consequences = { heading: '## Consequences', body: [] }
      kept.push(consequences)
    }
    consequences.body.push('', extraText)
  }
  const out = [...preamble, ...kept.flatMap(section => [section.heading, ...section.body])]
  return `${out.join('\n').replace(/\s+$/u, '')}\n`
}

function replaceSectionBody(content, heading, body) {
  const { preamble, sections } = splitNoteSections(content)
  const target = sections.find(section => section.heading === heading)
  if (target === undefined) throw new Error(`缺少 ${heading}`)
  target.body = ['', body]
  return `${[...preamble, ...sections.flatMap(section => [section.heading, ...section.body])].join('\n').replace(/\s+$/u, '')}\n`
}

function recoverFinalize(root, sessionId) {
  const journal = path.join(root, '.agents', 'notes', `.gate-finalize-${sessionId}.json`)
  if (!existsSync(journal)) return []
  let data
  try { data = JSON.parse(readFileSync(journal, 'utf8')) } catch { return [] }
  if (data?.owner !== sessionId) return []
  const recovered = []
  const source = path.join(root, data.source)
  const backup = path.join(root, data.backup)
  const target = path.join(root, data.target)
  try {
    if (existsSync(backup)) {
      if (!existsSync(source) && !existsSync(target)) {
        renameSync(backup, source)
        recovered.push('restored-source')
      } else if (!existsSync(source) && existsSync(target)) {
        const check = runNotesScripts(root)
        if (!check.ok) {
          rmSync(target, { force: true })
          renameSync(backup, source)
          recovered.push('restored-source-after-bad-target')
        } else {
          rmSync(backup, { force: true })
          recovered.push('kept-target')
        }
      } else if (existsSync(source) && !existsSync(target)) {
        rmSync(backup, { force: true })
        recovered.push('removed-backup')
      }
    }
    const temp = typeof data.temp === 'string' ? path.join(root, data.temp) : undefined
    if (!existsSync(backup) && (temp === undefined || !existsSync(temp))) recovered.push('journal-orphan')
    rmSync(journal, { force: true })
  } catch { /* keep journal for manual recovery */ }
  return recovered
}

function finalizeNote(root, entry, sessionId, decisionBody) {
  const sourceRelative = entry.path.replaceAll('\\', '/')
  const source = path.join(root, sourceRelative)
  const targetRelative = sourceRelative.replace('.agents/notes/proposed/', '.agents/notes/implemented/')
  const target = path.join(root, targetRelative)
  if (existsSync(target)) throw new Error(`目标已存在：${targetRelative}`)
  if (pathHasSymlink(root, source) || pathHasSymlink(root, target)) throw new Error('finalize 路径含 symlink')
  const content = readFileSync(source, 'utf8')
  let next = transformImplemented(content)
  if (typeof decisionBody === 'string' && decisionBody !== '') next = replaceSectionBody(next, '## Decision', decisionBody)
  const dir = path.dirname(target)
  mkdirSync(dir, { recursive: true })
  const journalRelative = path.join('.agents', 'notes', `.gate-finalize-${sessionId}.json`).replaceAll('\\', '/')
  const journal = path.join(root, journalRelative)
  const backup = `${source}.gate-backup`
  const temp = path.join(dir, `.gate-finalize-${path.basename(target)}.tmp`)
  writeFileSync(journal, JSON.stringify({ owner: sessionId, source: sourceRelative, target: targetRelative, backup: path.relative(root, backup).replaceAll('\\', '/'), temp: path.relative(root, temp).replaceAll('\\', '/') }, null, 2))
  try {
    writeFileSync(temp, next)
    renameSync(source, backup)
    renameSync(temp, target)
    const check = runNotesScripts(root)
    if (!check.ok) throw new Error(`finalize 后的 notes 校验失败：${JSON.stringify(check.results)}`)
    rmSync(backup, { force: true })
    rmSync(journal, { force: true })
    return targetRelative.replaceAll('\\', '/')
  } catch (error) {
    rmSync(target, { force: true })
    rmSync(temp, { force: true })
    if (existsSync(backup) && !existsSync(source)) renameSync(backup, source)
    rmSync(journal, { force: true })
    throw error
  }
}


function provisionNotes(root) {
  const notes = path.join(root, '.agents', 'notes')
  if (pathHasSymlink(root, notes)) throw new Error('notes 路径包含 symlink')
  for (const lifecycle of ['proposed', 'implemented', 'rejected', 'archived']) {
    const dir = path.join(notes, lifecycle)
    if (pathHasSymlink(root, dir)) throw new Error(`${lifecycle} 路径包含 symlink`)
    mkdirSync(dir, { recursive: true })
    const keep = path.join(dir, '.gitkeep')
    if (!existsSync(keep)) writeFileSync(keep, '')
  }
  const agents = path.join(root, 'AGENTS.md')
  if (existsSync(agents) && lstatSync(agents).isSymbolicLink()) throw new Error('AGENTS.md 是 symlink')
  const existing = existsSync(agents) ? readFileSync(agents, 'utf8') : ''
  const block = /<!-- gate-notes:start -->[\s\S]*?<!-- gate-notes:end -->/u
  const next = block.test(existing)
    ? existing.replace(block, NOTES_AGENTS_TEXT)
    : `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}\n${NOTES_AGENTS_TEXT}\n`
  writeFileSync(agents, next)
  return { notes: path.relative(root, notes).replaceAll('\\', '/'), agents: path.relative(root, agents).replaceAll('\\', '/') }
}

function workerProtocol(node) {
  return [
    '## Gate worker',
    '你是 gate 为该节点派发的 worker。只执行该节点；不要调用 gate_record，不要推进 gate。',
    node === 'verify-standalone'
      ? '加载使用 gate-user-verify 完成验收，并按该技能 Step 6 汇报。任务与汇报模板见该技能 assets/worker-briefs/gate-code-verify.md。不修改产品代码、测试、需求或设计；可以运行测试/命令作为证据，但不得修改、放宽或重写测试；不要自行提交。'
      : node === 'fix-bug'
        ? '主代理已读取 gate-fix-bug；你执行 gate-fix-bug 的 Process 1-9（复现、回归覆盖、根因、最小修复、测试），返回修复 receipt；不要自行完成 Step 10-12，不要提交。不改产品合同、不扩大范围。'
        : '主代理已经加载所需 gate 技能，并把具体任务与相关方法要求交给你。不要自己加载 gate 技能。',
    node === 'plan' || node === 'plan-revise'
      ? '用 gate_note_write 在 .agents/notes/proposed 下创建或更新 proposed Agent Note；原地同步既有 implemented Note 时路径写 implemented/<class>/...；planning 中通用 write/edit/shell 被限制。'
      : '',
  ].filter(Boolean).join('\n\n')
}

function provisionProjectScripts(root) {
  const dir = path.join(root, '.agents', 'gate')
  const launcher = path.join(dir, 'verify-notes.mjs')
  mkdirSync(dir, { recursive: true })
  copyFileSync(NOTES_LAUNCHER_TEMPLATE, launcher)
  const packagePath = path.join(root, 'package.json')
  let pkg = { private: true }
  if (existsSync(packagePath)) {
    try { pkg = JSON.parse(readFileSync(packagePath, 'utf8')) } catch { throw new Error('package.json 不是有效 JSON') }
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json 必须是对象')
  }
  pkg.scripts = pkg.scripts !== null && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {}
  const command = 'node .agents/gate/verify-notes.mjs'
  const existing = pkg.scripts['verify-notes']
  if (existing === undefined) pkg.scripts['verify-notes'] = command
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  return {
    launcher: path.relative(root, launcher).replaceAll('\\', '/'),
    package: path.relative(root, packagePath).replaceAll('\\', '/'),
    command: existing === undefined ? command : String(existing),
    changed: existing === undefined,
  }
}



function provisionCi(root) {
  const ciDir = path.join(root, '.agents', 'gate', 'ci')
  mkdirSync(ciDir, { recursive: true })
  for (const name of NOTES_CI_SCRIPTS) {
    copyFileSync(path.join(NOTES_SKILL_DIR, 'scripts', name), path.join(ciDir, name))
  }
  const workflow = path.join(root, '.github', 'workflows', 'verify-notes.yml')
  mkdirSync(path.dirname(workflow), { recursive: true })
  const existing = existsSync(workflow)
  if (!existing) copyFileSync(NOTES_CI_TEMPLATE, workflow)
  return { workflow: path.relative(root, workflow).replaceAll('\\', '/'), scripts: path.relative(root, ciDir).replaceAll('\\', '/'), changed: !existing }
}

function workspaceBoundary(ctx, agent) {
  try {
    const policy = ctx.get('sandboxPolicy')
    const resolved = policy?.resolve?.({ session: agent?.session })
    if (resolved?.workspaceRoot !== undefined) return resolved.workspaceRoot
  } catch { /* fall through to the session header */ }
  return agent?.session?.header?.cwd
}

function pathHasSymlink(base, absolute) {
  const relative = path.relative(base, absolute)
  if (relative === '' || relative.startsWith('..')) return true
  let current = base
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true
  for (const part of relative.split(path.sep)) {
    if (part === '') continue
    current = path.join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true
  }
  return false
}

function resolveGate(ctx, agent) {
  const workspace = workspaceBoundary(ctx, agent)
  const root = workspace === undefined ? undefined : path.resolve(workspace)
  if (root === undefined) return { workspace, root: undefined }
  return { workspace: root, root }
}

function sessionCwd(ctx, agent, fallback) {
  try {
    const cwd = ctx.get('workingDirectory')?.get?.(agent?.session)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch { /* fall through */ }
  return fallback
}

function roundNumbers(state) {
  const inPlan = state.node === 'plan-review'
  const inCode = state.node === 'code-review'
  return {
    inPlan,
    inCode,
    planRound: (state.rounds?.planReview ?? 0) + (inPlan ? 1 : 0),
    codeRound: (state.rounds?.codeReview ?? 0) + (inCode ? 1 : 0),
  }
}

function roundsText(state, reviewLimit) {
  const { inPlan, inCode, planRound, codeRound } = roundNumbers(state)
  return `plan ${planRound}/${reviewLimit}${inPlan ? '（当前）' : ''}, code ${codeRound}/${reviewLimit}${inCode ? '（当前）' : ''}`
}

function statusText(state, reviewLimit = DEFAULT_REVIEW_LIMIT, { includeRounds = true } = {}) {
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
  if (state.notePaths?.length > 0 || state.noteDecision === 'mechanical') {
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

function procedureBlock(procedure) {
  return `当前 phase/node：${procedure.phase} / ${procedure.node ?? '无'}\n方法：${procedure.method}\n\n${procedure.text}`
}

function procedureResultText(procedure, trailing) {
  return [procedureBlock(procedure), trailing].filter(Boolean).join('\n\n---\n\n')
}

function renderProcedureResult(value) {
  const { procedure, ...rest } = value ?? {}
  const trailing = JSON.stringify(rest)
  return [{ type: 'text', text: procedure !== null && procedure !== undefined ? procedureResultText(procedure, trailing) : trailing }]
}

function applyCommandEvent(state, name, args) {
  const text = String(args ?? '').trim()
  switch (name) {
    case 'gate-enter-plan':
      return {
        ...state, phase: 'orchestrating', node: 'plan', task: null, work: 'active',
        blockReason: null, blockedFrom: null, rounds: { planReview: 0, codeReview: 0 },
        exhausted: { plan: false, code: false }, planReady: false, verification: null,
        notePaths: [], noteDecision: null, noteSearch: null, noteVerified: false, noteFinalizeRecovery: [],
      }
    case 'gate-enter-implement':
      return {
        ...state, phase: 'orchestrating', node: 'implement', work: 'active',
        task: state.planReady !== true && text !== '' ? text : state.task,
        blockReason: null, blockedFrom: null, verification: null, noteVerified: false, noteFinalizeRecovery: [],
      }
    case 'gate-fix-bug':
      return { ...state, phase: 'orchestrating', task: text === '' ? (state.task ?? '当前上下文中的缺陷') : text, node: 'fix-bug', work: 'active', blockReason: null, blockedFrom: null }
    case 'gate-docs':
      return { ...state, phase: 'docs', task: text, node: null, work: 'active', blockReason: null, blockedFrom: null }
    case 'gate-implement-review':
      return { ...state, phase: 'reviewing', task: text, node: 'code-review-standalone', work: 'active', blockReason: null, blockedFrom: null }
    case 'gate-code-verify':
      return { ...state, phase: 'reviewing', task: text, node: 'verify-standalone', work: 'active', blockReason: null, blockedFrom: null }
    case 'gate-propose-review':
      return { ...state, phase: 'reviewing', task: text, node: 'proposal-review', work: 'active', blockReason: null, blockedFrom: null }
    case 'gate-block':
      return {
        ...state, blockedFrom: { phase: state.phase, node: state.node }, phase: 'blocked',
        work: 'blocked', node: null, blockReason: text === '' ? 'user-blocked' : text,
      }
    case 'gate-resume':
      return {
        ...state, phase: state.blockedFrom?.phase ?? 'discuss', node: state.blockedFrom?.node ?? null,
        work: 'active', blockReason: null, blockedFrom: null,
      }
    case 'gate-return-discuss':
      return { ...state, phase: 'discuss', node: null, work: 'active', blockReason: null, blockedFrom: null }
    default:
      return state
  }
}

function applyProjectionEvent(state, event) {
  if (event.type === 'command/run' && typeof event.data?.name === 'string' && event.data.name.startsWith('gate-')) {
    return {
      ...state,
      pending: { ...(state.pending ?? {}), [event.data.commandId]: { name: event.data.name, args: event.data.args ?? '' } },
    }
  }
  if (event.type === 'command/done') {
    const pending = state.pending?.[event.data?.commandId]
    if (pending === undefined) return state
    const next = { ...state, pending: { ...state.pending } }
    delete next.pending[event.data.commandId]
    if (event.data.kind !== 'success') return next
    return applyCommandEvent(next, pending.name, pending.args)
  }
  if (event.type === 'tool/result') {
    const snapshot = event.data?.meta?.gate?.state
    if (snapshot !== undefined) return normalizeState(snapshot)
  }
  return state
}

function sandboxModeFor(state) {
  if (state.phase === 'docs') return 'workspace-write'
  if (state.phase !== 'orchestrating') return 'read-only'
  return ['plan', 'plan-revise', 'implement', 'implement-revise', 'fix-bug'].includes(state.node) ? 'workspace-write' : 'read-only'
}

function setSandbox(ctx, agent, state) {
  const mode = sandboxModeFor(state)
  try {
    const policy = ctx.get('sandboxPolicy')
    if (policy?.overrideOf?.(agent?.session) === mode) return
    agent?.session?.append('sandbox/mode', { mode })
  } catch { /* host may not expose sandbox/session append in a test harness */ }
}

function restrictionFilter(state, worker) {
  const writeTools = ['write', 'edit', 'apply_patch', 'pwsh', 'bash']
  if (worker) {
    if (state.node === 'implement' || state.node === 'implement-revise' || state.node === 'fix-bug') return undefined
    return { deny: writeTools }
  }
  if (state.phase === 'docs' || state.phase === 'orchestrating') return undefined
  return { deny: writeTools }
}

const restrictionState = new WeakMap()

function applyRestrictions(ctx, agent, store) {
  const tools = agent?.ctx?.tools
  if (typeof tools?.restrict !== 'function') return
  try {
    const gate = resolveGate(ctx, agent)
    const previous = restrictionState.get(agent)
    const effective = effectiveState(ctx, agent, gate, store)
    const filter = restrictionFilter(effective.state, effective.worker)
    const key = `${effective.state.phase}/${effective.state.node ?? ''}/${effective.worker ? 'worker' : 'root'}/${JSON.stringify(filter ?? null)}`
    if (previous?.key === key) return
    previous?.disposer?.()
    restrictionState.delete(agent)
    if (filter !== undefined) {
      const names = filter.deny.filter(name => {
        try {
          return typeof tools.get !== 'function' || tools.get(name) !== undefined
        } catch {
          return false
        }
      })
      if (names.length > 0) {
        let disposer
        try {
          disposer = tools.restrict({ deny: names })
        } catch {
          const disposers = []
          for (const name of names) {
            try {
              disposers.push(tools.restrict({ deny: [name] }))
            } catch { /* this name is not a global tool in this scope */ }
          }
          if (disposers.length > 0) disposer = () => { for (const release of disposers) release() }
        }
        if (disposer !== undefined) restrictionState.set(agent, { key, disposer })
      }
    }
  } catch {
    // Guard remains the hard boundary; a failed UX restriction must not fail the agent step.
  }
}

function createStateRuntime(ctx) {
  let handle
  ctx.inject(['sessionProjections'], async scope => {
    try {
      handle = await scope.sessionProjections.register({
        key: 'gate',
        stateSchema: { parse: normalizeState },
        init: () => defaultState(),
        apply: applyProjectionEvent,
        stateVersion: 1,
      })
    } catch {
      handle = undefined
    }
  })
  return {
    read(root, agent) {
      if (handle !== undefined && agent?.session !== undefined) {
        try {
          return normalizeState(handle.stateOf(agent.session))
        } catch { /* fall through to the in-memory store */ }
      }
      return loadState(root, agent)
    },
    write(root, agent, state) {
      setSandbox(ctx, agent, state)
      if (handle !== undefined) return state
      return saveState(root, agent, state)
    },
    get source() { return handle === undefined ? 'memory' : 'projection' },
    get projection() { return handle },
  }
}

function rootAgentOf(ctx, agent) {
  const header = agent?.session?.header
  const delegated = header?.origin === 'subagent' && typeof header.parentSession === 'string'
  try {
    const root = ctx.get('subagents')?.rootOf?.(agent)
    if (root !== undefined && root.id !== agent?.id) return root
  } catch { /* fall through to durable parent lineage */ }
  if (delegated) {
    try {
      const live = ctx.get('agents')?.get?.(header.parentSession)
      if (live !== undefined) return live
    } catch { /* fall through to the synthetic parent */ }
    return { id: header.parentSession }
  }
  return agent
}

function effectiveState(ctx, agent, gate, store) {
  const root = rootAgentOf(ctx, agent)
  return { root, state: store.read(gate.root, root), worker: root?.id !== agent?.id }
}

function workerWriteAllowed(state, target) {
  if (state.phase !== 'orchestrating') return false
  if (state.node === 'plan' || state.node === 'plan-revise') return false
  if (state.node === 'implement' || state.node === 'implement-revise' || state.node === 'fix-bug') return true
  return false
}

function workerShellAllowed(state, access) {
  if (state.phase !== 'orchestrating') return false
  return state.node === 'implement' || state.node === 'implement-revise' || state.node === 'fix-bug'
}

function isMechanical(task) {
  return /^mechanical:/iu.test(String(task ?? '').trim())
}

function enterPhase(ctx, agent, node, reviewLimit, store, current) {
  const gate = resolveGate(ctx, agent)
  const state = current ?? store.read(gate.root, agent)
  if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
  if (state.work === 'blocked' || state.blockReason !== null) {
    return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
  }
  if (node === 'plan') {
    const notes = resolveNotesSkill()
    if (notes === undefined) return { kind: 'error', code: 'notes-builtin-missing', text: '内置 write-agent-notes 缺失；重装插件。' }
  }
  if (node === 'implement') {
    if (typeof state.task !== 'string' || state.task === '') return { kind: 'error', text: '没有可实施的内容：先用一句话说明要改什么' }
    if (state.exhausted?.plan === true || state.exhausted?.code === true) {
      return { kind: 'error', text: 'review 轮次已耗尽；需要用户决定后重新 /gate-enter-plan' }
    }
  }
  state.phase = 'orchestrating'
  state.node = node
  state.work = 'active'
  state.blockReason = null
  state.blockedFrom = null
  if (node === 'plan') {
    state.rounds = { planReview: 0, codeReview: 0 }
    state.exhausted = { plan: false, code: false }
    state.task = null
    state.planReady = false
    state.verification = null
    state.notePaths = []
    state.noteDecision = null
    state.noteSearch = null
    state.noteVerified = false
    state.noteFinalized = false
    state.noteFinalizeRecovery = []
  }
  if (node === 'implement') {
    state.verification = null
    state.noteVerified = false
    state.noteFinalized = false
    state.noteFinalizeRecovery = []
  }
  store.write(gate.root, agent, state)
  return { gate, state, reviewLimit }
}

function targetList(name, args) {
  if (name !== 'apply_patch') return [args?.file_path]
  return [...String(args?.input ?? '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gmu)]
    .map(match => match[1].trim())
}

function gateDenyReason(ctx, exec, store) {
  if (exec.name === 'gate_record') {
    const root = rootAgentOf(ctx, exec.agent)
    return root?.id === exec.agent?.id ? undefined : 'gate_record 只能由 root agent 调用'
  }
  if (['subagent', 'subagent_fork', 'workflow'].includes(exec.name)) {
    const gate = resolveGate(ctx, exec.agent)
    const state = store.read(gate.root, exec.agent)
    if (state.phase === 'discuss') return 'discuss 只读讨论，不派 worker'
    if (state.node === 'note-lifecycle') return 'note-lifecycle 只做 Note 收尾，不派 worker'
    return undefined
  }
  if (exec.name === 'write' || exec.name === 'edit' || exec.name === 'apply_patch') {
    const gate = resolveGate(ctx, exec.agent)
    const effective = effectiveState(ctx, exec.agent, gate, store)
    const state = effective.state
    const cwd = sessionCwd(ctx, exec.agent, gate.workspace)
    const targets = targetList(exec.name, exec.arguments).filter(value => typeof value === 'string' && value !== '')
    if (targets.length === 0) return undefined
    for (const value of targets) {
      const target = classifyPath(gate.workspace, value, cwd)
      if (target.outside) return '工作区外写入被拒绝'
      if (effective.worker) {
        if (!workerWriteAllowed(state, target)) return `worker ${state.node ?? 'unknown'} 不允许写该目标`
        continue
      }
      if (state.phase === 'orchestrating') return undefined
      if (state.phase !== 'docs') return '当前阶段不允许写入；主代理在编排中不写文件'
    }
    return undefined
  }
  if (exec.name === 'pwsh' || exec.name === 'bash') {
    const gate = resolveGate(ctx, exec.agent)
    const effective = effectiveState(ctx, exec.agent, gate, store)
    const state = effective.state
    const base = sessionCwd(ctx, exec.agent, gate.workspace)
    const requested = exec.arguments?.workdir
    const cwd = typeof requested === 'string' && requested !== '' ? path.resolve(base, requested) : base
    const access = shellAccess(exec.arguments?.command ?? '', gate.workspace, cwd)
    if (/\bgit(?:\.exe)?\s+(?:-c\s+\S+\s+)?commit\b/iu.test(String(exec.arguments?.command ?? '')) && ['plan', 'plan-review', 'plan-revise', 'implement', 'code-review', 'implement-revise', 'verify', 'note-lifecycle', 'fix-bug'].includes(state.node)) {
      return 'Note lifecycle 未完成：gate 会话内拒绝 git commit'
    }
    if (!access.write) return undefined
    if (access.outsideTargets.length > 0) return '工作区外写入被拒绝'
    if (effective.worker) return workerShellAllowed(state, access) ? undefined : `worker ${state.node ?? 'unknown'} 不允许写该目标`
    if (state.phase === 'orchestrating') return undefined
    if (state.phase !== 'docs') return '当前阶段不允许写入；主代理在编排中不写文件'
    return undefined
  }
  return undefined
}

const REVIEW_NODES = new Set(['plan-review', 'proposal-review', 'code-review', 'code-review-standalone'])
const NOTE_CLASSES = new Set(['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'])

function noteTopic(file) {
  return path.basename(file).replace(/^\d{4}-\d{2}-\d{2}-/u, '').replace(/\.md$/u, '').replace(/-implemented$/u, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
}

function runFormatOnNote(root, entry, content) {
  const node = resolveNodeBinary()
  if (node === undefined) return { code: 'notes-runtime-unavailable', reason: '无法定位 Node 可执行文件。' }
  const temp = path.join(root, '.agents', 'notes', `.gate-validate-${randomUUID()}`)
  const relative = path.join(entry.lifecycle, entry.class, path.basename(entry.path))
  try {
    mkdirSync(path.dirname(path.join(temp, relative)), { recursive: true })
    writeFileSync(path.join(temp, relative), content)
    execFileSync(node, [path.join(NOTES_SKILL_DIR, 'scripts', 'verify-agent-note-format.ts'), '--root', temp], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return undefined
  } catch (error) {
    return { code: 'note-format-invalid', path: entry.path, reason: String(error?.stderr ?? error?.message ?? error).trim() }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}


function validateNotePaths(root, value, decision) {
  if (decision === 'mechanical') {
    if (!Array.isArray(value) || value.length !== 0) return { code: 'note-paths-required', reason: 'mechanical 的 notePaths 必须为空。' }
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0) return { code: 'note-paths-required', reason: '非 mechanical 工作项至少需要一个 notePath。' }
  const seenTopics = new Set()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.class !== 'string' || typeof entry.lifecycle !== 'string') {
      return { code: 'invalid-note-path', reason: 'notePaths[] 需要 {path,class,lifecycle}。' }
    }
    if (!NOTE_CLASSES.has(entry.class)) return { code: 'invalid-note-class', class: entry.class }
    if (!['proposed', 'implemented'].includes(entry.lifecycle)) return { code: 'invalid-note-lifecycle', lifecycle: entry.lifecycle }
    if (decision === 'new' && entry.lifecycle !== 'proposed') return { code: 'note-decision-mismatch', reason: 'new 只能 proposed。' }
    if (decision === 'update' && entry.lifecycle !== 'proposed') return { code: 'note-decision-mismatch', reason: 'update 只能 proposed。' }
    if (decision === 'in-place' && entry.lifecycle !== 'implemented') return { code: 'note-decision-mismatch', reason: 'in-place 只能 implemented。' }
    const normalized = entry.path.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized.includes('..')) return { code: 'invalid-note-path', path: entry.path }
    const parts = normalized.split('/')
    if (parts.length !== 5 || parts[0] !== '.agents' || parts[1] !== 'notes' || parts[2] !== entry.lifecycle || parts[3] !== entry.class) {
      return { code: 'invalid-note-path', path: entry.path, reason: '需要 .agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md。' }
    }
    const filePart = parts[4]
    if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/u.test(filePart)) return { code: 'invalid-note-path', path: entry.path, reason: '文件名需要 yyyy-mm-dd-topic.md。' }
    const absolute = path.join(root, ...parts)
    if (!isInside(root, absolute) || pathHasSymlink(root, absolute)) return { code: 'invalid-note-path', path: entry.path, reason: '路径越界或含 symlink。' }
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return { code: 'note-missing', path: entry.path }
    const content = readFileSync(absolute, 'utf8')
    const status = content.match(/^Status:\s*(proposed|implemented)\s*$/mu)?.[1]
    if (status !== entry.lifecycle) return { code: 'note-status-mismatch', path: entry.path, expected: entry.lifecycle, got: status ?? 'missing' }
    const format = runFormatOnNote(root, entry, content)
    if (format !== undefined) return format
    const topic = noteTopic(filePart)
    if (seenTopics.has(topic)) return { code: 'note-topic-duplicate', topic, reason: '同一 topic 只能有一篇。' }
    seenTopics.add(topic)
    for (const other of ['proposed', 'implemented', 'rejected']) {
      const dir = path.join(root, '.agents', 'notes', other, entry.class)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md') || name === path.basename(filePart)) continue
        if (noteTopic(name) === topic) return { code: 'note-topic-duplicate', topic, other: path.join(dir, name) }
      }
    }
  }
  return undefined
}


function reviewAxesError(args) {
  if (!REVIEW_NODES.has(args.node)) return undefined
  const axes = args.reviewAxes
  const required = args.node === 'plan-review' || args.node === 'proposal-review' ? ['standards', 'spec', 'architecture'] : ['standards', 'spec']
  if (axes === null || typeof axes !== 'object' || Array.isArray(axes)) return { code: 'review-axes-required', reason: `review 节点需要 ${required.join('、')} 轴结果。` }
  for (const axis of required) {
    const value = axes[axis]
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.findings)) {
      return { code: 'review-axes-required', reason: `${axis} 轴需要 findings 数组。` }
    }
  }
  return undefined
}

async function workerEvidenceError(ctx, root, args) {
  if (!WORKER_NODES.has(args.node)) return undefined
  const ids = Array.isArray(args.workerSessionIds)
    ? [...new Set(args.workerSessionIds.filter(value => typeof value === 'string' && value !== ''))]
    : []
  if (ids.length === 0) return { code: 'worker-required', reason: 'gate_record 需要 workerSessionIds；没有 worker 不能推进。' }
  const service = ctx.get('subagents')
  if (service === undefined || typeof service.listDescendants !== 'function') {
    return { code: 'worker-evidence-unavailable', reason: 'subagents.listDescendants 不可用，无法验证 worker。' }
  }
  let entries
  try {
    entries = await service.listDescendants(root.id)
  } catch {
    return { code: 'worker-evidence-unavailable', reason: '读取 subagent tree 失败，无法验证 worker。' }
  }
  const children = Array.isArray(entries) ? entries.filter(entry => entry?.kind === 'child') : []
  for (const id of ids) {
    const row = children.find(entry => String(entry.id) === String(id))
    if (row === undefined) return { code: 'worker-not-descendant', workerSessionId: id, reason: 'workerSessionId 不在当前 root 的 subagent tree 中。' }
  }
  return undefined
}

async function bindToolResults(ctx, workerSessionIds, toolResults) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.readSession !== 'function') {
    return { code: 'verification-required', reason: 'sessionQuery 不可用，无法绑定 toolResults。' }
  }
  const found = new Set()
  for (const sessionId of workerSessionIds) {
    try {
      const snapshot = await query.readSession(sessionId)
      for (const event of snapshot?.events ?? []) {
        if (event?.type !== 'tool/result') continue
        const callId = event.data?.message?.toolCallId ?? event.data?.callId
        if (callId !== undefined) found.add(String(callId))
      }
    } catch { /* one unreadable worker session cannot prove its results */ }
  }
  const missing = toolResults.filter(id => !found.has(String(id)))
  if (missing.length > 0) {
    return { code: 'verification-required', unboundToolResults: missing, reason: 'toolResults 未在 worker session log 中找到。' }
  }
  return undefined
}

function wakeGateAgent(invocation, text, command) {
  const followup = invocation?.agent?.followup
  if (typeof followup !== 'function') return
  try {
    followup.call(invocation.agent, {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'gate-command', command },
    })
  } catch { /* the command result still reports the state transition */ }
}

export function apply(ctx, config = {}) {
  const reviewLimit = Number.isInteger(config?.reviewLimit) ? config.reviewLimit : DEFAULT_REVIEW_LIMIT
  const store = createStateRuntime(ctx)
  const wake = (invocation, state, text, command) => {
    const procedure = procedureFor(state, { reviewLimit })
    wakeGateAgent(invocation, `${procedureBlock(procedure)}\n\n${text}`, command)
  }

  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.section({
      name: 'gate:protocol',
      order: scope.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: context => {
        const gate = resolveGate(ctx, context.agent)
        const effective = effectiveState(ctx, context.agent, gate, store)
        const state = effective.state
        if (effective.worker) {
          return ['## Gate', 'Gate worker：只执行当前 node，不推进 phase。', workerProtocol(state.node)].filter(Boolean).join('\n\n')
        }
        return GATE_METHODOLOGY
      },
    })
  })

  if (typeof ctx.tools.guard === 'function') {
    ctx.tools.guard(exec => gateDenyReason(ctx, exec, store))
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    applyRestrictions(ctx, payload.agent, store)
    return next()
  })


  ctx.inject(['commands'], scope => {
    const register = (name, description, handler, input = { hint: '<工作项>' }) => scope.commands.register({
      name,
      description,
      ...(input === null ? {} : { input }),
      handler,
    })
    register('gate-init', '初始化 notes、AGENTS.md、verify-notes 与 GitHub Actions CI', async invocation => {
      const workspace = workspaceBoundary(ctx, invocation.agent)
      if (workspace === undefined) return { kind: 'error', text: '无法确定当前会话工作区' }
      const root = path.resolve(workspace)
      let provisioned
      let projectScripts
      let projectCi
      try {
        provisioned = provisionNotes(root)
        projectCi = provisionCi(root)
        projectScripts = provisionProjectScripts(root)
      } catch (error) {
        return { kind: 'error', text: `notes 初始化失败：${error instanceof Error ? error.message : String(error)}` }
      }
      wake(invocation, store.read(root, invocation.agent), `Gate 已初始化：${root}（phase=discuss），notes 已初始化为 ${provisioned.notes}，AGENTS.md 已更新，verify-notes 已配置为 ${projectScripts.command}，CI 已配置为 ${projectCi.workflow}。`, 'gate-init')
      return { kind: 'success', text: `Gate 已初始化：${root}（phase=discuss）\nnotes：${provisioned.notes}\nAGENTS：${provisioned.agents}\nverify-notes：${projectScripts.command}\nCI：${projectCi.workflow}` }
    }, null)
    register('gate-enter-plan', '按用户简述进入 planning', async invocation => {
      const result = enterPhase(ctx, invocation.agent, 'plan', reviewLimit, store)
      if (result.kind === 'error') return result
      const brief = String(invocation.rawInput ?? '').trim()
      wake(invocation, result.state, `Gate 已进入 plan。用户规划输入：${brief === '' ? '（未提供额外输入）' : brief}。`, 'gate-enter-plan')
      return { kind: 'success', text: '进入 planning。' }
    }, { hint: '[简单需求]' })
    register('gate-enter-implement', '从已确认规划或用户简述进入 implementation', async invocation => {
      const brief = String(invocation.rawInput ?? '').trim()
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      const direct = state.planReady !== true
      if (direct) {
        if (brief === '') return { kind: 'error', text: '请用一句话说明要实施的内容；不要求工作项格式。' }
        state.task = brief
        state.planReady = false
        state.noteDecision = null
        state.notePaths = []
        state.noteSearch = null
        state.noteVerified = false
        state.noteFinalized = false
        state.noteFinalizeRecovery = []
        store.write(gate.root, invocation.agent, state)
      }
      const result = enterPhase(ctx, invocation.agent, 'implement', reviewLimit, store, direct ? state : undefined)
      if (result.kind === 'error') return result
      const constraints = direct ? '（本句即工作项简述）' : (brief === '' ? '（无额外约束）' : brief)
      wake(invocation, result.state, `Gate 已进入 implement：${result.state.task ?? ''}${direct ? '（直接实施，未走 planning）' : ''}。用户说明：${constraints}。`, 'gate-enter-implement')
      return { kind: 'success', text: `进入 implement：${result.state.task}${direct ? '（直接实施）' : ''}` }
    }, { hint: '[简单说明]' })
    register('gate-fix-bug', '为已授权的实现缺陷派发 fix worker', async invocation => {
      const brief = String(invocation.rawInput ?? '').trim()
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      const scope = brief === '' ? (state.task ?? '当前上下文中的缺陷') : brief
      state.phase = 'orchestrating'; state.node = 'fix-bug'; state.task = scope
      state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      wake(invocation, state, `Gate 已进入 fix-bug：${scope}。`, 'gate-fix-bug')
      return { kind: 'success', text: `进入 fix-bug：${scope}` }
    }, { hint: '[缺陷简述]' })
    register('gate-docs', '开始文档治理', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      state.phase = 'docs'; state.task = '文档治理'; state.work = 'active'; state.blockReason = null; state.blockedFrom = null; state.node = null
      store.write(gate.root, invocation.agent, state)
      wake(invocation, state, 'Gate 已进入 docs。', 'gate-docs')
      return { kind: 'success', text: '进入 docs：文档治理' }
    }, null)
    register('gate-implement-review', '开始独立只读 code review', async invocation => {
      const brief = String(invocation.rawInput ?? '').trim()
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      const scope = brief === '' ? (state.task ?? '当前上下文中的改动') : brief
      state.phase = 'reviewing'; state.task = scope; state.node = 'code-review-standalone'; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      wake(invocation, state, `Gate 已进入只读 code review：${scope}。`, 'gate-implement-review')
      return { kind: 'success', text: `进入只读 code review：${scope}` }
    })
    register('gate-code-verify', '开始独立只读验收', async invocation => {
      const brief = String(invocation.rawInput ?? '').trim()
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      const scope = brief === '' ? (state.task ?? '当前上下文中的改动') : brief
      state.phase = 'reviewing'; state.task = scope; state.node = 'verify-standalone'; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      wake(invocation, state, `Gate 已进入独立验收：${scope}。`, 'gate-code-verify')
      return { kind: 'success', text: `进入独立验收：${scope}` }
    })
    register('gate-propose-review', '开始独立提案评审', async invocation => {
      const brief = String(invocation.rawInput ?? '').trim()
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      const scope = brief === '' ? (state.task ?? '当前提案/Note') : brief
      state.phase = 'reviewing'; state.task = scope; state.node = 'proposal-review'; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      wake(invocation, state, `Gate 已进入提案评审：${scope}。`, 'gate-propose-review')
      return { kind: 'success', text: `进入提案评审：${scope}` }
    })
    register('gate-block', '手动暂停：保留当前节点并停止写入/派 worker；对话仍可继续', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase === 'blocked') return { kind: 'success', text: '已经是 blocked' }
      state.blockedFrom = { phase: state.phase, node: state.node }
      state.phase = 'blocked'; state.work = 'blocked'; state.node = null
      state.blockReason = String(invocation.rawInput ?? '').trim() || 'user-blocked'
      store.write(gate.root, invocation.agent, state)
      return { kind: 'success', text: `已暂停：${state.blockReason}\n解冻后：${state.blockedFrom?.phase ?? 'discuss'}${state.blockedFrom?.node === null || state.blockedFrom?.node === undefined ? '' : ` / ${state.blockedFrom.node}`}\n同一事项：/gate-resume 回到该节点；改变方案：/gate-return-discuss。` }
    }, { hint: '[原因]' })
    register('gate-resume', '解冻 blocked：回到 block 前的节点；轮次耗尽回 discuss', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'blocked') return { kind: 'error', text: '当前不是 blocked' }
      const from = state.blockedFrom
      const reason = state.blockReason
      state.phase = from?.phase ?? 'discuss'; state.node = from?.node ?? null
      state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      if (state.phase === 'orchestrating' || state.phase === 'reviewing' || state.phase === 'docs') {
        wake(invocation, state, `Gate 已恢复到 ${state.phase}${state.node === null ? '' : ` / ${state.node}`}。`, 'gate-resume')
      }
      const exhausted = reason === 'plan-review-rounds-exhausted' || reason === 'code-review-rounds-exhausted'
      return { kind: 'success', text: `已解除 blocked：${state.phase}${state.node === null ? '' : ` / ${state.node}`}${exhausted ? '\nreview 轮次已耗尽，不能继续原节点；用 /gate-enter-plan 重新规划。' : '\n已回到暂停前节点，按当前 procedure 继续。'}` }
    }, null)
    register('gate-return-discuss', '回到 discuss', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase === 'blocked') return { kind: 'error', text: `当前 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      state.phase = 'discuss'; state.node = null; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      state.task = null
      state.planReady = false
      state.rounds = { planReview: 0, codeReview: 0 }
      state.verification = null
      state.notePaths = []
      state.noteDecision = null
      state.noteSearch = null
      state.noteVerified = false
      state.noteFinalized = false
      state.noteFinalizeRecovery = []
      state.pending = {}
      store.write(gate.root, invocation.agent, state)
      return { kind: 'success', text: '已回到 discuss' }
    }, null)
    register('gate-status', '查看当前 gate 状态', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const root = rootAgentOf(ctx, invocation.agent)
      return { kind: 'success', text: statusText(store.read(gate.root, root), reviewLimit) }
    }, null)
    register('gate-note-verify', '只读检查 notes tree/format/lifecycle/archived', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const check = runNotesScripts(gate.root)
      return check.ok
        ? { kind: 'success', text: check.results.map(item => `${item.name}: ok`).join('\n') }
        : { kind: 'error', text: `notes 校验失败：\n${JSON.stringify(check.results, null, 2)}` }
    }, null)
    register('gate-note-archive', '将 implemented Note 归档到 archived/：加 Archived、移动、封印并报告入站链接', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const raw = String(invocation.rawInput ?? '').trim()
      const args = raw === '' ? [] : raw.split(/\s+/u)
      if (args.length === 0) return { kind: 'error', text: '用法：/gate-note-archive implemented/<class>/<note>.md [--superseded-by implemented/<class>/<new>.md]' }
      const node = resolveNodeBinary()
      if (node === undefined) return { kind: 'error', text: 'notes-runtime-unavailable' }
      try {
        const script = path.join(NOTES_SKILL_DIR, 'scripts', 'archive-agent-note.ts')
        const output = execFileSync(node, [script, '--root', path.join(gate.root, '.agents', 'notes'), ...args], { cwd: gate.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { kind: 'success', text: String(output).trim() || 'Note 已归档' }
      } catch (error) {
        return { kind: 'error', text: String(error?.stderr ?? error?.message ?? error).trim() }
      }
    }, { hint: '<implemented-note> [--superseded-by <new-note>]' })
    register('gate-note-board', '生成决策看板 board.html（轻量模式，连接本地 notes 目录）', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const raw = String(invocation.rawInput ?? '').trim()
      const args = raw === '' ? [] : raw.split(/\s+/u)
      const target = args[0] ?? 'board.html'
      const title = args[1] ?? `${path.basename(gate.root)} 决策看板`
      const node = resolveNodeBinary()
      if (node === undefined) return { kind: 'error', text: 'notes-runtime-unavailable' }
      try {
        const script = path.join(NOTES_SKILL_DIR, 'scripts', 'build-board.ts')
        const output = execFileSync(node, [script, '--init', target, title], { cwd: gate.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { kind: 'success', text: String(output).trim() || `决策看板已生成：${target}` }
      } catch (error) {
        return { kind: 'error', text: String(error?.stderr ?? error?.message ?? error).trim() }
      }
    }, { hint: '[输出路径] [标题]' })
    register('gate-note-seal', '只给 archived/ 中已有 Note 补写 manifest.json 的 SHA-256 封印；不归档、不改 Note 内容', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      const node = resolveNodeBinary()
      if (node === undefined) return { kind: 'error', text: 'notes-runtime-unavailable' }
      try {
        const script = path.join(NOTES_SKILL_DIR, 'scripts', 'verify-archived-agent-notes.ts')
        const output = execFileSync(node, [script, '--root', path.join(gate.root, '.agents', 'notes'), '--write'], { cwd: gate.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { kind: 'success', text: String(output).trim() || 'archived manifest 已写入' }
      } catch (error) {
        return { kind: 'error', text: String(error?.stderr ?? error?.message ?? error).trim() }
      }
    }, null)
  })

  ctx.tools.register({
    name: 'gate_start_phase',
    description: '在用户明确授权后从 discuss/complete 进入 plan 或 implement。仅 root agent 可调用；授权可来自对话或 ask_user_question，不要求用户输入 slash command。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', enum: ['plan', 'implement'] },
        brief: { type: 'string' },
      },
      required: ['node'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderProcedureResult(value),
      presentationMeta: (_args, value) => value?.state === undefined ? { gate: {} } : { gate: { state: value.state } },
    },
    async execute(args, exec) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_start_phase 只能由 root agent 调用。' }
      const gate = resolveGate(ctx, exec.agent)
      const state = store.read(gate.root, exec.agent)
      const fail = fields => procedureFailure(state, reviewLimit, fields)
      if (args.node !== 'plan' && args.node !== 'implement') return fail({ code: 'invalid-node', reason: 'node 必须是 plan 或 implement。' })
      const direct = args.node === 'implement' && state.planReady !== true
      if (direct) {
        const brief = String(args.brief ?? '').trim()
        if (brief === '') return fail({ code: 'brief-required', reason: '直接 implement 需要一句说明。' })
        state.task = brief
        state.planReady = false
        state.noteDecision = null
        state.notePaths = []
        state.noteSearch = null
        state.noteVerified = false
        state.noteFinalized = false
        state.noteFinalizeRecovery = []
        store.write(gate.root, exec.agent, state)
      }
      const result = enterPhase(ctx, exec.agent, args.node, reviewLimit, store, direct ? state : undefined)
      if (result.kind === 'error') return fail({ code: 'phase-enter-failed', reason: result.text })
      const procedure = procedureFor(result.state, { reviewLimit })
      return {
        ok: true,
        phase: result.state.phase,
        node: result.state.node,
        task: result.state.task,
        procedure,
        method: procedure.method,
        state: normalizeState(result.state),
      }
    },
  })

  ctx.tools.register({
    name: 'gate_record',
    description: '记录 root agent 派发的节点 worker 结果并推进 gate 状态。worker 节点要求 workerSessionIds；review 节点要求两轴结果；verify 要求 toolResults。仅 root agent 可调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', enum: GATE_RECORD_NODES },
        workerSessionIds: { type: 'array', items: { type: 'string' } },
        reviewAxes: { type: 'object', additionalProperties: true },
        task: { type: 'string' },
        findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
        requiresDiscussion: { type: 'boolean' },
        discussionReason: { type: 'string' },
        notePaths: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              class: { type: 'string', enum: ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'] },
              lifecycle: { type: 'string', enum: ['proposed', 'implemented'] },
            },
            required: ['path', 'class', 'lifecycle'],
          },
        },
        noteDecision: { type: 'string', enum: ['new', 'update', 'in-place', 'mechanical'] },
        noteSearch: { type: 'string' },
        verification: {
          type: 'object',
          additionalProperties: false,
          properties: {
            commands: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
            toolResults: { type: 'array', items: { type: 'string' } },
            passed: { type: 'boolean' },
          },
          required: ['commands', 'evidence', 'toolResults', 'passed'],
        },
      },
      required: ['node'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderProcedureResult(value),
      presentationMeta: (_args, value) => value?.state === undefined ? { gate: {} } : { gate: { state: value.state } },
    },
    async execute(args, exec) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_record 只能由 root agent 调用；worker 完成当前 node 后返回 receipt。' }
      const gate = resolveGate(ctx, exec.agent)
      const state = store.read(gate.root, exec.agent)
      const fail = fields => procedureFailure(state, reviewLimit, fields)

      if (state.phase === 'docs') {
        if (args.node !== 'docs') return fail({ code: 'wrong-node', expected: 'docs', got: args.node ?? null, reason: 'docs 阶段只能通过 gate_record({node:"docs"}) 结束。' })
        state.phase = 'discuss'; state.node = null; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
        store.write(gate.root, exec.agent, state)
        const procedure = procedureFor(state, { reviewLimit })
        return { ok: true, phase: state.phase, node: state.node, procedure, method: procedure.method, state: normalizeState(state) }
      }
      if (state.phase !== 'orchestrating' && state.phase !== 'reviewing') {
        return fail({ code: 'not-orchestrating', phase: state.phase, stateSource: store.source, reason: `当前 phase 是 ${state.phase}；先进入对应阶段。` })
      }
      if (state.node !== args.node) return fail({ code: 'wrong-node', expected: state.node ?? null, got: args.node ?? null, reason: `当前节点是 ${state.node ?? '无'}，请求的 node 是 ${args.node ?? '未提供'}。` })

      const axesError = reviewAxesError(args)
      if (axesError !== undefined) return fail(axesError)
      const workerError = await workerEvidenceError(ctx, root, args)
      if (workerError !== undefined) return fail(workerError)

      const topFindings = Array.isArray(args.findings) ? args.findings : []
      const axesFindings = REVIEW_NODES.has(args.node)
        ? [
            ...args.reviewAxes.standards.findings,
            ...args.reviewAxes.spec.findings,
            ...(args.node === 'plan-review' || args.node === 'proposal-review' ? args.reviewAxes.architecture.findings : []),
          ]
        : []
      const findings = [...axesFindings, ...topFindings]
      if (args.requiresDiscussion === true) {
        if (args.node === 'plan-review') state.planReady = false
        state.blockedFrom = { phase: state.phase, node: state.node }
        state.phase = 'blocked'
        state.node = null
        state.work = 'blocked'
        state.blockReason = 'needs-user-decision'
        store.write(gate.root, exec.agent, state)
        const procedure = procedureFor(state, { reviewLimit })
        return { ok: true, phase: state.phase, blockReason: state.blockReason, reason: args.discussionReason ?? null, procedure, method: procedure.method, state: normalizeState(state) }
      }
      if (args.node === 'proposal-review') {
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
        state.blockedFrom = null
      } else if (args.node === 'code-review-standalone') {
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
      } else if (args.node === 'plan') {
        if (typeof args.task !== 'string' || args.task.trim() === '') {
          return fail({ code: 'task-required', reason: 'node=plan 必须携带 task（planning 产出的工作项或 mechanical:<说明>）。' })
        }
        const decision = args.noteDecision
        if (!['new', 'update', 'in-place', 'mechanical'].includes(decision)) {
          return fail({ code: 'note-decision-required', reason: 'node=plan 需要 noteDecision（new/update/in-place/mechanical）。' })
        }
        if (decision === 'mechanical' && !isMechanical(args.task)) {
          return fail({ code: 'mechanical-required', reason: 'mechanical 只允许 task 以 mechanical: 开头。' })
        }
        const noteError = validateNotePaths(gate.root, args.notePaths, decision)
        if (noteError !== undefined) return fail(noteError)
        state.task = args.task.trim()
        state.notePaths = decision === 'mechanical' ? [] : args.notePaths
        state.noteDecision = decision
        state.noteSearch = typeof args.noteSearch === 'string' ? args.noteSearch : null
        state.noteVerified = decision === 'mechanical'
        state.node = 'plan-review'
      } else if (args.node === 'plan-revise') {
        if (args.noteDecision !== undefined || args.notePaths !== undefined) {
          const decision = args.noteDecision ?? state.noteDecision
          if (!['new', 'update', 'in-place', 'mechanical'].includes(decision)) {
            return fail({ code: 'note-decision-required', reason: 'plan-revise 需要合法 noteDecision。' })
          }
          if (decision === 'mechanical' && !isMechanical(state.task)) {
            return fail({ code: 'mechanical-required', reason: 'mechanical 只允许 task 以 mechanical: 开头。' })
          }
          const noteError = validateNotePaths(gate.root, args.notePaths ?? state.notePaths, decision)
          if (noteError !== undefined) return fail(noteError)
          state.notePaths = decision === 'mechanical' ? [] : (args.notePaths ?? state.notePaths)
          state.noteDecision = decision
          if (typeof args.noteSearch === 'string') state.noteSearch = args.noteSearch
          state.noteVerified = decision === 'mechanical'
        }
        state.node = 'plan-review'
      } else if (args.node === 'plan-review') {
        state.rounds.planReview += 1
        if (findings.length === 0) {
          state.phase = 'discuss'
          state.node = null
          state.planReady = true
          state.work = 'active'
          state.blockReason = null
        } else if (state.rounds.planReview >= reviewLimit) {
          state.exhausted.plan = true
          state.blockedFrom = { phase: 'discuss', node: null }
          state.phase = 'blocked'
          state.node = null
          state.work = 'blocked'
          state.blockReason = 'plan-review-rounds-exhausted'
        } else state.node = 'plan-revise'
      } else if (args.node === 'implement') {
        if (args.noteDecision === 'mechanical') {
          state.noteDecision = 'mechanical'
          state.notePaths = []
          state.noteVerified = true
        } else {
          if (Array.isArray(args.notePaths)) state.notePaths = args.notePaths
          if (['new', 'update', 'in-place'].includes(args.noteDecision)) state.noteDecision = args.noteDecision
        }
        state.node = 'code-review'
      }
      else if (args.node === 'implement-revise') state.node = 'code-review'
      else if (args.node === 'code-review') {
        state.rounds.codeReview += 1
        if (findings.length === 0) state.node = 'verify'
        else if (state.rounds.codeReview >= reviewLimit) {
          state.exhausted.code = true
          state.blockedFrom = { phase: 'discuss', node: null }
          state.phase = 'blocked'
          state.node = null
          state.work = 'blocked'
          state.blockReason = 'code-review-rounds-exhausted'
        } else state.node = 'implement-revise'
      } else if (args.node === 'verify' || args.node === 'verify-standalone') {
        const verification = args.verification
        const commands = Array.isArray(verification?.commands) ? verification.commands.filter(item => typeof item === 'string' && item.trim() !== '') : []
        const evidence = Array.isArray(verification?.evidence) ? verification.evidence.filter(item => typeof item === 'string' && item.trim() !== '') : []
        const toolResults = Array.isArray(verification?.toolResults) ? verification.toolResults.filter(item => typeof item === 'string' && item.trim() !== '') : []
        const unbound = await bindToolResults(ctx, Array.isArray(args.workerSessionIds) ? args.workerSessionIds : [], toolResults)
        if (unbound !== undefined) return fail(unbound)
        const records = []
        const invalidEvidence = []
        for (const item of evidence) {
          const target = classifyPath(gate.workspace, item)
          try {
            if (target.outside || !existsSync(target.absolute) || !lstatSync(target.absolute).isFile()) {
              invalidEvidence.push(item)
              continue
            }
            const bytes = readFileSync(target.absolute)
            records.push({ path: target.relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
          } catch {
            invalidEvidence.push(item)
          }
        }
        if (commands.length === 0 || evidence.length === 0 || toolResults.length === 0 || invalidEvidence.length > 0 || records.length !== evidence.length || typeof verification?.passed !== 'boolean') {
          return fail({ code: 'verification-required', invalidEvidence, commands, evidence, toolResults, reason: 'verify 需要非空 commands、workspace 内的普通 evidence 文件、toolResults，以及明确的 passed。' })
        }
        state.verification = {
          commands,
          evidence: records,
          toolResults,
          passed: verification.passed,
          selfReported: false,
          executionBound: true,
          verifiedAt: new Date().toISOString(),
        }
        if (args.node === 'verify-standalone') {
          if (verification.passed === true) {
            const commit = commitGateChanges(gate.root, state)
            if (commit.ok !== true) return fail({ code: 'commit-failed', reason: commit.reason })
          }
          state.phase = 'discuss'
          state.node = null
          state.work = 'active'
          state.blockReason = null
          state.blockedFrom = null
        } else if (verification.passed !== true) {
          state.node = 'implement-revise'
          state.noteVerified = false
        } else if (state.noteDecision === 'mechanical') {
          state.noteVerified = true
          state.noteFinalized = true
          const commit = commitGateChanges(gate.root, state)
          if (commit.ok !== true) return fail({ code: 'commit-failed', reason: commit.reason })
          state.phase = 'discuss'
          state.node = null
          state.work = 'active'
          state.blockReason = null
          state.blockedFrom = null
          state.task = null
          state.planReady = false
        } else {
          state.phase = 'orchestrating'
          state.node = 'note-lifecycle'
          state.work = 'active'
          state.noteVerified = false
          state.noteFinalized = false
          state.noteFinalizeRecovery = []
        }
      } else if (args.node === 'fix-bug') {
        const commit = commitGateChanges(gate.root, state)
        if (commit.ok !== true) return fail({ code: 'commit-failed', reason: commit.reason })
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
        state.blockedFrom = null
        state.task = null
        state.planReady = false
      } else if (args.node === 'note-lifecycle') {
        if (state.noteVerified !== true) {
          return fail({ code: 'note-lifecycle-incomplete', reason: 'note-lifecycle 需要先 gate_note_finalize + gate_note_verify。' })
        }
        const commit = commitGateChanges(gate.root, state)
        if (commit.ok !== true) return fail({ code: 'commit-failed', reason: commit.reason })
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
        state.blockedFrom = null
        state.task = null
        state.planReady = false
      }
      store.write(gate.root, exec.agent, state)
      const next = normalizeState(state)
      const procedure = procedureFor(next, { reviewLimit })
      return { ok: true, phase: state.phase, node: state.node, rounds: state.rounds, blockReason: state.blockReason, verification: state.verification, procedure, method: procedure.method, state: next }
    },
  })

  ctx.tools.register({
    name: 'gate_status',
    description: '读取 Gate 当前状态与当前 procedure（root）。只读；派发 worker 前、推进节点前、compaction 后、失败后恢复时使用。worker 调用返回 root 状态但不返回 root procedure。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const root = rootAgentOf(ctx, exec.agent)
      if (exec.agent?.session?.header?.origin === 'subagent' && root?.id === exec.agent?.id) {
        return { ok: false, code: 'root-unresolved', reason: '无法解析 worker 的 root session；不返回 worker 自身的状态。' }
      }
      if (root?.session === undefined) {
        return { ok: false, code: 'root-unresolved', reason: 'root session 不完整；无法读取 Gate 状态。' }
      }
      const gate = resolveGate(ctx, exec.agent)
      if (gate.root === undefined) return { ok: false, code: 'state-unavailable', reason: '无法确定工作区。' }
      const state = store.read(gate.root, root)
      if (root?.id !== exec.agent?.id) {
        return { ok: true, procedure: null, method: null, text: statusText(state, reviewLimit) }
      }
      const procedure = procedureFor(state, { reviewLimit })
      const includeRounds = !procedure.hasRounds
      return {
        ok: true,
        procedure,
        method: procedure.method,
        text: procedureResultText(procedure, statusText(state, reviewLimit, { includeRounds })),
      }
    },
  })

  ctx.tools.register({
    name: 'gate_note_write',
    description: '写 proposed Agent Note，或在 planning 原地更新已存在的 implemented Note。仅 planning worker；通用 write/edit/shell 被限制。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '相对 .agents/notes 的路径；proposed/ 可新建，implemented/ 只能编辑已存在文件。' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const gate = resolveGate(ctx, exec.agent)
      const effective = effectiveState(ctx, exec.agent, gate, store)
      if (!effective.worker || !['plan', 'plan-revise'].includes(effective.state.node)) {
        return { ok: false, code: 'planning-only', reason: 'gate_note_write 只允许 planning worker 在 plan/plan-revise 节点使用。' }
      }
      let relative = String(args.path ?? '').replaceAll('\\', '/').replace(/^\.?\//u, '')
      if (relative === '' || relative.includes('..') || path.isAbsolute(relative) || !relative.endsWith('.md')) {
        return { ok: false, code: 'invalid-path' }
      }
      let lifecycle = 'proposed'
      if (relative.startsWith('proposed/')) relative = relative.slice('proposed/'.length)
      else if (relative.startsWith('implemented/')) {
        lifecycle = 'implemented'
        relative = relative.slice('implemented/'.length)
      }
      if (!/^(?:feature|bug-fix|simplification|architecture|process|testing)\/\d{4}-\d{2}-\d{2}-.+\.md$/u.test(relative)) {
        return { ok: false, code: 'invalid-path', reason: '需要 <class>/yyyy-mm-dd-topic.md，或 proposed|implemented/<class>/...。' }
      }
      const base = path.join(gate.root, '.agents', 'notes', lifecycle)
      const absolute = path.resolve(base, relative)
      if (!isInside(base, absolute)) return { ok: false, code: 'invalid-path' }
      if (pathHasSymlink(base, absolute)) return { ok: false, code: 'invalid-path' }
      if (lifecycle === 'implemented' && !existsSync(absolute)) {
        return { ok: false, code: 'implemented-must-exist', reason: 'implemented Note 只能原地编辑，不能新建。' }
      }
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, String(args.content ?? ''))
      return { ok: true, path: path.relative(gate.root, absolute).replaceAll('\\', '/'), lifecycle }
    },
  })

  ctx.tools.register({
    name: 'gate_note_verify',
    description: '运行内置 notes 校验；note-lifecycle 中通过后设置 noteVerified。root-only。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value?.state === undefined ? { gate: {} } : { gate: { state: value.state } },
    },
    async execute(_args, exec) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_note_verify 只能由 root agent 调用。' }
      const gate = resolveGate(ctx, exec.agent)
      const state = store.read(gate.root, exec.agent)
      const recovered = recoverFinalize(gate.root, String(exec.agent?.session?.id ?? exec.agent?.id ?? 'unknown'))
      if (recovered.length > 0) state.noteFinalizeRecovery = [...state.noteFinalizeRecovery, ...recovered]
      const check = runNotesScripts(gate.root)
      if (!check.ok) return { ...check, state: normalizeState(state) }
      if (state.node === 'note-lifecycle') {
        if (state.noteFinalized !== true) return { ok: false, code: 'note-lifecycle-incomplete', reason: '先调用 gate_note_finalize。', state: normalizeState(state) }
        const implemented = state.notePaths.length > 0 && state.notePaths.every(entry => entry.lifecycle === 'implemented' && existsSync(path.join(gate.root, entry.path)))
        if (!implemented) return { ok: false, code: 'note-lifecycle-incomplete', reason: 'notePaths 尚未全部进入 implemented。', results: check.results, state: normalizeState(state) }
        state.noteVerified = true
        store.write(gate.root, exec.agent, state)
        return { ok: true, noteVerified: true, results: check.results, state: normalizeState(state) }
      }
      return { ok: true, noteVerified: false, results: check.results, state: normalizeState(state) }
    },
  })

  ctx.tools.register({
    name: 'gate_note_finalize',
    description: '把 note-lifecycle 中的 proposed Note 移到 implemented 并更新头块；root-only。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decisionBodies: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { path: { type: 'string' }, body: { type: 'string' } },
            required: ['path', 'body'],
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value?.state === undefined ? { gate: {} } : { gate: { state: value.state } },
    },
    async execute(args, exec) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_note_finalize 只能由 root agent 调用。' }
      const gate = resolveGate(ctx, exec.agent)
      const state = store.read(gate.root, exec.agent)
      if (state.node !== 'note-lifecycle') return { ok: false, code: 'not-note-lifecycle', reason: '只在 note-lifecycle 节点可用。' }
      if (state.noteDecision === 'mechanical') {
        state.noteVerified = true
        state.noteFinalized = true
        store.write(gate.root, exec.agent, state)
        return { ok: true, skipped: true, state: normalizeState(state) }
      }
      const sessionId = String(exec.agent?.session?.id ?? exec.agent?.id ?? 'unknown')
      const recovered = recoverFinalize(gate.root, sessionId)
      for (const entry of state.notePaths) {
        if (entry.lifecycle !== 'proposed') continue
        const source = path.join(gate.root, entry.path)
        const targetRelative = entry.path.replaceAll('\\', '/').replace('.agents/notes/proposed/', '.agents/notes/implemented/')
        if (!existsSync(source) && existsSync(path.join(gate.root, targetRelative))) {
          entry.path = targetRelative
          entry.lifecycle = 'implemented'
          recovered.push('adopted-target')
        }
      }
      const moved = []
      const decisionBodies = new Map((Array.isArray(args.decisionBodies) ? args.decisionBodies : []).map(item => [String(item.path).replaceAll('\\', '/'), String(item.body ?? '')]))
      try {
        for (const entry of state.notePaths) {
          if (entry.lifecycle !== 'proposed') continue
          const original = entry.path.replaceAll('\\', '/')
          const relative = finalizeNote(gate.root, entry, sessionId, decisionBodies.get(original))
          moved.push({ from: original, to: relative })
          entry.path = relative
          entry.lifecycle = 'implemented'
        }
        const finalCheck = runNotesScripts(gate.root)
        if (!finalCheck.ok) throw new Error(`finalize/decisionBodies 后的 notes 校验失败：${JSON.stringify(finalCheck.results)}`)
        state.noteFinalizeRecovery = recovered
        state.noteVerified = false
        state.noteFinalized = true
        store.write(gate.root, exec.agent, state)
        return { ok: true, moved, recovered, state: normalizeState(state) }
      } catch (error) {
        state.noteFinalizeRecovery = recovered
        store.write(gate.root, exec.agent, state)
        return { ok: false, code: 'note-finalize-failed', reason: error instanceof Error ? error.message : String(error), moved, recovered, state: normalizeState(state) }
      }
    },
  })


}










































