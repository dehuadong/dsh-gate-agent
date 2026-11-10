import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyPath, shellAccess } from './src/classify.js'
import { DEFAULT_CODE_EXTENSIONS, DEFAULT_CODE_PATHS, DEFAULT_PROTECTED, MARKER, findGateRoot, findProjectRoot, loadConfig, validateConfig } from './src/config.js'
import { defaultState, loadState, normalizeState, saveState } from './src/state.js'

export const inject = ['tools']
const SKILLS = fileURLToPath(new URL('./skills', import.meta.url))
const SKILL_NAMES = ['gate-planning', 'gate-plan-review', 'gate-implement', 'gate-code-review', 'gate-verify']
const DEFAULT_REVIEW_LIMIT = 5
const NOTES_SKILL = path.join('.agents', 'skills', 'write-agent-notes')
const LEGACY_MARKERS = [path.join('.agents', 'implement-gate.json'), path.join('.agents', 'state', 'implement-gate')]

const SCHEMASTERY = Symbol.for('schemastery')

/** Deployment-level knobs; project policy remains in `.agents/gate.json`. */
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

只读讨论，不写文件、不派 worker。

1. 先读相关代码、文档、历史 Note 与项目约束。
2. 明确实际问题、约束、已有决定与冲突。
3. 给出有实质差异的可行方案、推荐与关键权衡。
4. 只对未决的产品、范围、兼容性、成本、风险等价值判断提问。
5. 不创建提案、Note 或规格文件。
6. 汇报：已解决事项、剩余未决事项、建议的下一阶段。
7. 不自行离开 discuss；离开必须由用户显式授权。`

export const PLAN_ORCHESTRATION = `## /gate-enter-plan orchestration
Main agent dispatches workers; gate does not dispatch.
1. Read the method files listed below yourself before dispatch. Do not ask the worker to load gate skills or method files; pass a self-contained task brief plus the relevant method rules.
2. Dispatch gate-planning with the work item, constraints, and the distilled planning method. The worker must not re-load gate skills.
3. Call gate_record({node:'plan', task, workerSessionIds}). The task is the work item or topic produced by planning; it is required. workerSessionIds are the child session ids returned by the dispatched subagent; no worker evidence means no advance.
4. At plan-review, read the listed gate-plan-review method yourself; dispatch one read-only plan-review worker with the method and Note. Call gate_record({node:'plan-review',findings,reviewAxes,workerSessionIds,requiresDiscussion}); reviewAxes must include both standards and spec.
5. If requiresDiscussion: call gate_record for the current node with requiresDiscussion:true and stop; the gate becomes blocked and the user must run /gate-resume after deciding. If findings remain: read the planning method again, dispatch gate-planning revise with the findings and method, call gate_record({node:'plan-revise',workerSessionIds}), then review again.
6. At the configured review limit with findings, gate marks blocked; never claim pass.
7. Empty review returns to discuss.`

export const IMPLEMENT_ORCHESTRATION = `## /gate-enter-implement orchestration
Main agent dispatches workers; gate does not dispatch.
1. Read the method files listed below yourself before dispatch. Do not ask workers to load gate skills or method files; pass each worker a self-contained task brief plus the relevant method rules.
2. Dispatch gate-implement with the accepted work item and distilled implementation method. The worker must not re-load gate skills.
3. Call gate_record({node:'implement',workerSessionIds}).
4. Read the gate-code-review method yourself; dispatch ONE read-only review worker that covers both Standards and Spec axes. The worker must not load gate skills.
5. Call gate_record({node:'code-review',findings,reviewAxes,workerSessionIds,requiresDiscussion}) with the two-axis result from that one worker.
6. If requiresDiscussion: call gate_record for the current node with requiresDiscussion:true and stop; the gate becomes blocked and the user must run /gate-resume. If findings remain: read the implementation method again, dispatch gate-implement revise with the findings and method, call gate_record({node:'implement-revise',workerSessionIds}), then review again.
7. Empty findings: read the gate-verify method yourself; dispatch the verify worker with the method. Call gate_record({node:'verify',verification,workerSessionIds}); verification must include commands, evidence, toolResults, and passed.
8. Verify FAIL routes back to implement-revise; PASS completes. At the configured review limit, blocked.`

export const DOCS_ORCHESTRATION = `## /gate-docs orchestration
Edit only documents and notes; no code.
When done, call gate_record({node:'docs'}) to return to discuss.`

function readSkill(name) {
  const file = path.join(SKILLS, name, 'SKILL.md')
  try {
    const raw = readFileSync(file, 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw)
    const description = frontmatter?.[1]?.match(/^description:\s*(.+)$/mu)?.[1]?.trim()
    return {
      content: frontmatter === null ? raw : raw.slice(frontmatter[0].length),
      description: description === undefined || description === '' ? `Gate phase skill: ${name}` : description,
      path: file,
      resourceBase: { kind: 'directory', path: path.dirname(file) },
    }
  } catch {
    return undefined
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolveNotesSkill(gate) {
  const candidates = []
  if (gate.config.policy.notesSkillPath !== undefined) {
    candidates.push(path.resolve(gate.root, gate.config.policy.notesSkillPath))
  }
  candidates.push(path.join(gate.root, NOTES_SKILL))
  for (const dir of candidates) {
    if (!isInside(gate.root, dir)) continue
    const skill = path.join(dir, 'SKILL.md')
    if (!existsSync(skill)) continue
    const template = path.join(dir, 'templates', 'proposed.md')
    return { skill, template: existsSync(template) ? template : undefined }
  }
  return undefined
}

function methodFiles(node, gate) {
  const files = []
  if (node === 'plan' || node === 'plan-revise') {
    files.push(path.join(SKILLS, 'gate-planning', 'SKILL.md'))
    files.push(path.join(SKILLS, 'gate-planning', 'proposal.md'))
    files.push(path.join(SKILLS, 'gate-planning', 'rfc.md'))
    const notes = resolveNotesSkill(gate)
    if (notes !== undefined) {
      files.push(notes.skill)
      if (notes.template !== undefined) files.push(notes.template)
    }
  }
  if (node === 'plan-review') files.push(path.join(SKILLS, 'gate-plan-review', 'SKILL.md'))
  if (node === 'implement' || node === 'implement-revise' || node === 'code-review') {
    files.push(path.join(SKILLS, 'gate-implement', 'SKILL.md'))
    files.push(path.join(SKILLS, 'gate-implement', 'tickets.md'))
    files.push(path.join(SKILLS, 'gate-code-review', 'SKILL.md'))
    files.push(path.join(SKILLS, 'gate-verify', 'SKILL.md'))
  }
  if (node === 'verify') files.push(path.join(SKILLS, 'gate-verify', 'SKILL.md'))
  if (node === 'review') files.push(path.join(SKILLS, 'gate-code-review', 'SKILL.md'))
  return files.filter(file => existsSync(file))
}

function workerFiles() {
  return []
}

function workerProtocol(node) {
  return [
    '## Gate worker',
    'You are the gate-dispatched worker for this node. Execute only this node; do not call gate_record and do not advance the gate.',
    'The main agent has already read the gate method files and must give you the concrete task plus the relevant method rules. Do not load gate skills or gate method files yourself.',
    node === 'plan' || node === 'plan-revise'
      ? 'Use gate_note_write to create or update proposed Agent Notes under .agents/notes/proposed. Generic write/edit/shell are restricted in planning.'
      : '',
  ].filter(Boolean).join('\n\n')
}

function workspaceBoundary(ctx, agent) {
  try {
    const policy = ctx.get('sandboxPolicy')
    const resolved = policy?.resolve?.({ session: agent?.session })
    if (resolved?.workspaceRoot !== undefined) return resolved.workspaceRoot
  } catch { /* fall through to the session header */ }
  return agent?.session?.header?.cwd
}

function sessionWorkingDirectory(ctx, agent) {
  try {
    const cwd = ctx.get('workingDirectory')?.get?.(agent?.session)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch { /* fall through to the sandbox workspace */ }
  return workspaceBoundary(ctx, agent)
}

function legacyGatePath(root) {
  for (const relative of LEGACY_MARKERS) {
    const candidate = path.join(root, relative)
    if (existsSync(candidate)) return path.relative(root, candidate).replaceAll('\\', '/')
  }
  return undefined
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
  const sessionDir = sessionWorkingDirectory(ctx, agent)
  const root = findGateRoot(sessionDir) ?? findGateRoot(workspace)
  if (root === undefined) return { workspace, root: undefined, config: { kind: 'none' } }
  const legacy = legacyGatePath(root)
  if (legacy !== undefined) {
    return { workspace: root, root, config: { kind: 'invalid', reason: `legacy-gate-present:${legacy}` } }
  }
  try {
    if (ctx.get('tools')?.get?.('implement_gate') !== undefined) {
      return { workspace: root, root, config: { kind: 'invalid', reason: 'legacy-implement-gate-active' } }
    }
  } catch { /* tools may not be queryable during early activation */ }
  return { workspace: root, root, config: loadConfig(root) }
}

function sessionCwd(ctx, agent, fallback) {
  try {
    const cwd = ctx.get('workingDirectory')?.get?.(agent?.session)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch { /* fall through */ }
  return fallback
}

function statusText(state, reviewLimit = DEFAULT_REVIEW_LIMIT) {
  const lines = [
    `状态：${state.phase}`,
    `节点：${state.node ?? '无'}`,
    `工作项：${state.task ?? '无'}`,
    `work：${state.work}`,
    `blockReason：${state.blockReason ?? '无'}`,
    `planReady：${state.planReady ? '是' : '否'}`,
    `rounds：plan ${state.rounds?.planReview ?? 0}/${reviewLimit}, code ${state.rounds?.codeReview ?? 0}/${reviewLimit}`,
  ]
  if (state.exhausted?.plan === true || state.exhausted?.code === true) {
    lines.push(`exhausted：plan ${state.exhausted.plan ? '是' : '否'}, code ${state.exhausted.code ? '是' : '否'}`)
  }
  if (state.verification !== null) {
    lines.push(`verify：${state.verification.passed === true ? 'PASS' : 'FAIL'}（${state.verification.selfReported === true ? 'self-reported' : 'verified'}）`)
  }
  return lines.join('\n')
}

function applyCommandEvent(state, name, args) {
  const text = String(args ?? '').trim()
  switch (name) {
    case 'gate-enter-plan':
      return {
        ...state, phase: 'orchestrating', node: 'plan', task: null, work: 'active',
        blockReason: null, blockedFrom: null, rounds: { planReview: 0, codeReview: 0 },
        exhausted: { plan: false, code: false }, planReady: false, verification: null,
      }
    case 'gate-enter-implement':
      return {
        ...state, phase: 'orchestrating', node: 'implement', work: 'active',
        blockReason: null, blockedFrom: null, verification: null,
      }
    case 'gate-docs':
      return { ...state, phase: 'docs', task: text, node: null, work: 'active', blockReason: null, blockedFrom: null }
    case 'gate-code-review':
      return { ...state, phase: 'reviewing', task: text, node: 'review', work: 'active', blockReason: null, blockedFrom: null }
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
  return ['plan', 'plan-revise', 'implement', 'implement-revise'].includes(state.node) ? 'workspace-write' : 'read-only'
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
    if (state.node === 'implement' || state.node === 'implement-revise') return undefined
    return { deny: writeTools }
  }
  if (state.phase === 'docs') return undefined
  return { deny: writeTools }
}

const restrictionState = new WeakMap()

function applyRestrictions(ctx, agent, store) {
  const tools = agent?.ctx?.tools
  if (typeof tools?.restrict !== 'function') return
  try {
    const gate = resolveGate(ctx, agent)
    const previous = restrictionState.get(agent)
    if (gate.config.kind !== 'ok') {
      previous?.disposer?.()
      restrictionState.delete(agent)
      return
    }
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
        } catch { /* fall through to the side-file store */ }
      }
      return loadState(root, agent)
    },
    write(root, agent, state) {
      setSandbox(ctx, agent, state)
      if (handle !== undefined) return state
      return saveState(root, agent, state)
    },
    get source() { return handle === undefined ? 'side-file' : 'projection' },
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
  if (state.node === 'implement' || state.node === 'implement-revise') return target.docs === true || target.code === true
  return false
}

function workerShellAllowed(state, access) {
  if (state.phase !== 'orchestrating') return false
  return state.node === 'implement' || state.node === 'implement-revise'
}

function normalizeTopic(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
}

function isMechanical(task) {
  return /^mechanical:/iu.test(String(task ?? '').trim())
}

function hasProposedNote(root, task) {
  const wanted = normalizeTopic(String(task ?? '').trim().replace(/^proposed:/iu, ''))
  if (wanted === '') return false
  const dir = path.join(root, '.agents', 'notes', 'proposed')
  if (!existsSync(dir)) return false
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const nested of readdirSync(path.join(dir, entry.name), { withFileTypes: true })) {
      if (!nested.isFile() || !nested.name.endsWith('.md')) continue
      const topic = normalizeTopic(nested.name.replace(/^\d{4}-\d{2}-\d{2}-/u, '').replace(/\.md$/u, '').replace(/-implemented$/u, ''))
      if (topic === wanted) return true
    }
  }
  return false
}

function workItemAllowed(root, task, allowMechanical) {
  if (isMechanical(task)) return allowMechanical
  return hasProposedNote(root, task)
}

function notesSkillError(gate) {
  const configured = gate.config.policy.notesSkillPath
  return {
    code: 'notes-skill-required',
    text: configured === undefined
      ? `缺少 notes skill：在 ${path.join(gate.root, NOTES_SKILL)} 放 write-agent-notes，或在 .agents/gate.json 配置 notesSkillPath`
      : `缺少 notes skill：配置的 notesSkillPath ${configured} 下没有 SKILL.md`,
  }
}

function enterPhase(ctx, agent, node, reviewLimit, store) {
  const gate = resolveGate(ctx, agent)
  if (gate.config.kind === 'invalid') return { kind: 'error', text: `Gate 配置无效：${gate.config.reason ?? 'unknown'}` }
  if (gate.config.kind === 'disabled') return { kind: 'error', text: 'Gate 已停用（enabled:false）' }
  if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
  const state = store.read(gate.root, agent)
  if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
  if (state.work === 'blocked' || state.blockReason !== null) {
    return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
  }
  if (node === 'plan') {
    const notes = resolveNotesSkill(gate)
    if (notes === undefined) return { kind: 'error', ...notesSkillError(gate) }
  }
  if (node === 'implement') {
    if (typeof state.task !== 'string' || state.task === '') return { kind: 'error', text: '没有可实施的工作项：先完成 planning' }
    if (state.planReady !== true) return { kind: 'error', text: 'planning 尚未通过：先完成 /gate-enter-plan 与 clean plan review' }
    if (state.exhausted?.plan === true || state.exhausted?.code === true) {
      return { kind: 'error', text: 'review 轮次已耗尽；需要用户决定后重新 /gate-enter-plan' }
    }
    if (!workItemAllowed(gate.root, state.task, true)) {
      return { kind: 'error', text: `没有工作项：需要同 topic 的 proposed Note 或 mechanical:<说明>（当前：${state.task}）` }
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
  }
  if (node === 'implement') state.verification = null
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
    if (gate.config.kind === 'invalid') return `Gate 配置无效：${gate.config.reason ?? 'unknown'}`
    if (gate.config.kind === 'ok' && store.read(gate.root, exec.agent).phase === 'discuss') return 'discuss 只读讨论，不派 worker'
    return undefined
  }
  if (exec.name === 'write' || exec.name === 'edit' || exec.name === 'apply_patch') {
    const gate = resolveGate(ctx, exec.agent)
    if (gate.config.kind === 'invalid') return `Gate 配置无效：${gate.config.reason ?? 'unknown'}`
    if (gate.config.kind !== 'ok') return undefined
    const effective = effectiveState(ctx, exec.agent, gate, store)
    const state = effective.state
    const cwd = sessionCwd(ctx, exec.agent, gate.workspace)
    const targets = targetList(exec.name, exec.arguments).filter(value => typeof value === 'string' && value !== '')
    if (targets.length === 0) return undefined
    for (const value of targets) {
      const target = classifyPath(gate.workspace, value, gate.config.policy, cwd)
      if (target.outside) return '工作区外写入被拒绝'
      if (target.protected) return 'Gate 配置、状态或受保护路径不可写'
      if (effective.worker) {
        if (!workerWriteAllowed(state, target)) return `worker ${state.node ?? 'unknown'} 不允许写该目标`
        continue
      }
      if (state.phase !== 'docs') return '当前阶段不允许写入；主代理在编排中不写文件'
      if (target.code) return 'docs 阶段只允许写文档/notes，不允许写代码'
    }
    return undefined
  }
  if (exec.name === 'pwsh' || exec.name === 'bash') {
    const gate = resolveGate(ctx, exec.agent)
    if (gate.config.kind === 'invalid') return `Gate 配置无效：${gate.config.reason ?? 'unknown'}`
    if (gate.config.kind !== 'ok') return undefined
    const effective = effectiveState(ctx, exec.agent, gate, store)
    const state = effective.state
    const base = sessionCwd(ctx, exec.agent, gate.workspace)
    const requested = exec.arguments?.workdir
    const cwd = typeof requested === 'string' && requested !== '' ? path.resolve(base, requested) : base
    const access = shellAccess(exec.arguments?.command ?? '', gate.workspace, gate.config.policy, cwd)
    if (!access.write) return undefined
    if (access.protectedTargets.length > 0) return 'Gate 配置、状态或受保护路径不可写'
    if (access.outsideTargets.length > 0) return '工作区外写入被拒绝'
    if (effective.worker) return workerShellAllowed(state, access) ? undefined : `worker ${state.node ?? 'unknown'} 不允许写该目标`
    if (state.phase !== 'docs') return '当前阶段不允许写入；主代理在编排中不写文件'
    if (access.codeTargets.length > 0 || access.forceCode) return 'docs 阶段只允许写文档/notes，不允许写代码'
    return undefined
  }
  return undefined
}

const WORKER_NODES = new Set(['plan', 'plan-review', 'plan-revise', 'implement', 'code-review', 'implement-revise', 'verify', 'review'])
const REVIEW_NODES = new Set(['plan-review', 'code-review', 'review'])

function reviewAxesError(args) {
  if (!REVIEW_NODES.has(args.node)) return undefined
  const axes = args.reviewAxes
  if (axes === null || typeof axes !== 'object' || Array.isArray(axes)) return { code: 'review-axes-required', reason: 'review 节点需要 standards 与 spec 两轴结果。' }
  for (const axis of ['standards', 'spec']) {
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

  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.section({
      name: 'gate:protocol',
      order: scope.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: context => {
        const gate = resolveGate(ctx, context.agent)
        if (gate.config.kind === 'none') return ''
        if (gate.config.kind === 'disabled') return `## Gate\n\nGate 已停用（enabled:false）：${gate.config.configPath}`
        if (gate.config.kind === 'invalid') {
          return `## Gate\n\n配置无效：${gate.config.reason ?? 'unknown'}\n配置：${gate.config.configPath}\n写入将被拒绝，直到修正 marker。`
        }
        const effective = effectiveState(ctx, context.agent, gate, store)
        const state = effective.state
        const phaseNote = effective.worker
          ? 'Gate worker：只执行当前 node，不推进 phase。'
          : {
              discuss: DISCUSS_ORCHESTRATION,
              orchestrating: '主代理编排中；按节点协议派发 worker，不直接写文件。',
              reviewing: '只读 code review；只输出 findings，不写代码、不修复、不 verify。',
              docs: DOCS_ORCHESTRATION,
              blocked: 'Gate 已冻结；等待 /gate-resume。',
              complete: 'Gate 已完成；新任务需要重新授权。',
            }[state.phase] ?? ''
        const planNodes = new Set(['plan', 'plan-review', 'plan-revise'])
        const implementNodes = new Set(['implement', 'code-review', 'implement-revise', 'verify'])
        const protocol = effective.worker
          ? workerProtocol(state.node)
          : planNodes.has(state.node)
            ? PLAN_ORCHESTRATION
            : implementNodes.has(state.node)
              ? IMPLEMENT_ORCHESTRATION
              : ''
        const files = effective.worker ? workerFiles(state.node, gate) : methodFiles(state.node, gate)
        return [`## Gate`, statusText(state, reviewLimit), phaseNote, protocol, files.length === 0 ? '' : `## Method files\n${files.join('\n')}`].filter(Boolean).join('\n\n')
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

  ctx.inject(['skills'], scope => {
    for (const name of SKILL_NAMES) {
      const skill = readSkill(name)
      if (skill === undefined) continue
      scope.skills.register({
        name,
        description: skill.description,
        source: 'plugin:gate',
        content: skill.content,
        path: skill.path,
        resourceBase: skill.resourceBase,
      })
    }
  })

  ctx.inject(['commands'], scope => {
    const register = (name, description, handler, input = { hint: '<工作项>' }) => scope.commands.register({
      name,
      description,
      ...(input === null ? {} : { input }),
      handler,
    })
    register('gate-init', 'Initialize the gate marker for this project', async invocation => {
      const workspace = sessionWorkingDirectory(ctx, invocation.agent)
      if (workspace === undefined) return { kind: 'error', text: '无法确定当前会话工作区' }
      const existing = findGateRoot(workspace)
      if (existing !== undefined) return { kind: 'error', text: `Gate 已存在：${path.join(existing, MARKER)}` }
      const legacy = legacyGatePath(workspace)
      if (legacy !== undefined) return { kind: 'error', text: `检测到旧 gate 痕迹：${legacy}；先移除旧 @dsh-nove/gate 或 implement-gate 的 marker/state。` }
      const project = findProjectRoot(workspace)
      if (project !== undefined && path.resolve(project) !== path.resolve(workspace)) {
        return { kind: 'error', text: `当前工作区不是项目根（项目根：${project}）` }
      }
      const marker = path.join(workspace, MARKER)
      if (existsSync(marker)) return { kind: 'error', text: `Gate 已存在：${marker}` }
      const value = {
        enabled: true,
        version: 2,
        codeExtensions: DEFAULT_CODE_EXTENSIONS,
        codePaths: DEFAULT_CODE_PATHS,
        protected: DEFAULT_PROTECTED,
      }
      const config = validateConfig(value, marker)
      if (config.kind !== 'ok') return { kind: 'error', text: `Gate 配置无效：${config.reason ?? config.kind}` }
      mkdirSync(path.dirname(marker), { recursive: true })
      writeFileSync(marker, `${JSON.stringify(value, null, 2)}\n`)
      wakeGateAgent(invocation, `Gate 已启用：${marker}（phase=discuss）。向用户汇报初始化结果，并说明下一步可执行 /gate-enter-plan。`, 'gate-init')
      return { kind: 'success', text: `已启用 Gate：${marker}（phase=discuss）` }
    }, null)
    register('gate-enter-plan', 'Enter planning for the current discussion', async invocation => {
      const result = enterPhase(ctx, invocation.agent, 'plan', reviewLimit, store)
      if (result.kind === 'error') return result
      const brief = String(invocation.rawInput ?? '').trim()
      wakeGateAgent(invocation, `Gate 已进入 plan。用户规划输入：${brief === '' ? '（未提供额外输入）' : brief}。按 Gate 编排协议立即派发 gate-planning worker，规划必须覆盖该输入；完成后用 gate_record({node:"plan", ...}) 带 workerSessionIds 推进。`, 'gate-enter-plan')
      return { kind: 'success', text: '进入 planning：工作项将在规划中确定。\n按注入协议派发 gate-planning。' }
    }, { hint: '<需求/约束>' })
    register('gate-enter-implement', 'Enter implementation for the planned work item', async invocation => {
      const result = enterPhase(ctx, invocation.agent, 'implement', reviewLimit, store)
      if (result.kind === 'error') return result
      const brief = String(invocation.rawInput ?? '').trim()
      wakeGateAgent(invocation, `Gate 已进入 implement：${result.state.task ?? ''}。用户实施约束：${brief === '' ? '（无额外约束）' : brief}。按 Gate 编排协议立即派发 gate-implement worker，完成后用 gate_record 推进。`, 'gate-enter-implement')
      return { kind: 'success', text: `进入 implement：${result.state.task}\n按注入协议派发 gate-implement。` }
    }, { hint: '[实施约束]' })
    register('gate-docs', 'Start docs governance', async invocation => {
      const task = String(invocation.rawInput ?? '').trim()
      if (task === '') return { kind: 'error', text: '缺少范围' }
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind === 'invalid') return { kind: 'error', text: `Gate 配置无效：${gate.config.reason ?? 'unknown'}` }
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      state.phase = 'docs'; state.task = task; state.work = 'active'; state.blockReason = null; state.blockedFrom = null; state.node = null
      store.write(gate.root, invocation.agent, state)
      wakeGateAgent(invocation, `Gate 已进入 docs：${task}。按 docs 协议只改文档/notes；完成后 gate_record({node:"docs"})。`, 'gate-docs')
      return { kind: 'success', text: `进入 docs：${task}` }
    })
    register('gate-code-review', 'Start a standalone read-only code review', async invocation => {
      const task = String(invocation.rawInput ?? '').trim()
      if (task === '') return { kind: 'error', text: '缺少审查范围' }
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind === 'invalid') return { kind: 'error', text: `Gate 配置无效：${gate.config.reason ?? 'unknown'}` }
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      state.phase = 'reviewing'; state.task = task; state.node = 'review'; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      wakeGateAgent(invocation, `Gate 已进入只读 code review：${task}。主 agent 读取 gate-code-review 方法后派一个 review worker，同时覆盖 standards 与 spec 两轴；完成后 gate_record({node:"review", reviewAxes, workerSessionIds})。`, 'gate-code-review')
      return { kind: 'success', text: `进入只读 code review：${task}\n主代理读取 gate-code-review 方法并派一个两轴 review worker。` }
    })
    register('gate-block', 'Block the current gate', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind === 'invalid') return { kind: 'error', text: `Gate 配置无效：${gate.config.reason ?? 'unknown'}` }
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = store.read(gate.root, invocation.agent)
      if (state.phase === 'blocked') return { kind: 'success', text: '已经是 blocked' }
      state.blockedFrom = { phase: state.phase, node: state.node }
      state.phase = 'blocked'; state.work = 'blocked'; state.node = null
      state.blockReason = String(invocation.rawInput ?? '').trim() || 'user-blocked'
      store.write(gate.root, invocation.agent, state)
      return { kind: 'success', text: `已 block：${state.blockReason}` }
    }, { hint: '[原因]' })
    register('gate-resume', 'Resume a blocked gate', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind === 'invalid') return { kind: 'error', text: `Gate 配置无效：${gate.config.reason ?? 'unknown'}` }
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'blocked') return { kind: 'error', text: '当前不是 blocked' }
      const from = state.blockedFrom
      state.phase = from?.phase ?? 'discuss'; state.node = from?.node ?? null
      state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      if (state.phase === 'orchestrating' || state.phase === 'reviewing' || state.phase === 'docs') {
        wakeGateAgent(invocation, `Gate 已恢复到 ${state.phase}${state.node === null ? '' : ` / ${state.node}`}。按当前节点协议继续编排。`, 'gate-resume')
      }
      return { kind: 'success', text: `已恢复到 ${state.phase}${state.node === null ? '' : ` / ${state.node}`}` }
    }, null)
    register('gate-return-discuss', 'Return to discuss', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind === 'invalid') return { kind: 'error', text: `Gate 配置无效：${gate.config.reason ?? 'unknown'}` }
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = store.read(gate.root, invocation.agent)
      if (state.phase === 'blocked') return { kind: 'error', text: `当前 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      state.phase = 'discuss'; state.node = null; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      return { kind: 'success', text: '已回到 discuss' }
    }, null)
    register('gate-status', 'Show current gate state', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind === 'none') return { kind: 'error', text: '当前项目没有 .agents/gate.json' }
      if (gate.config.kind === 'disabled') return { kind: 'success', text: `状态：disabled（enabled:false）\n配置：${gate.config.configPath}` }
      if (gate.config.kind === 'invalid') return { kind: 'error', text: `配置无效：${gate.config.reason ?? 'unknown'}\n配置：${gate.config.configPath}` }
      return { kind: 'success', text: statusText(store.read(gate.root, invocation.agent), reviewLimit) }
    }, null)
  })

  ctx.tools.register({
    name: 'gate_record',
    description: 'Record the result of one root-agent-dispatched phase worker (plan, plan-review, plan-revise, implement, code-review, implement-revise, verify, docs, review) and advance the gate state. Requires workerSessionIds for worker nodes, both review axes for review nodes, and toolResults for verify. Root agent only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', enum: ['plan', 'plan-review', 'plan-revise', 'implement', 'code-review', 'implement-revise', 'verify', 'docs', 'review'] },
        workerSessionIds: { type: 'array', items: { type: 'string' } },
        reviewAxes: { type: 'object', additionalProperties: true },
        task: { type: 'string' },
        findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
        requiresDiscussion: { type: 'boolean' },
        discussionReason: { type: 'string' },
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
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value?.state === undefined ? { gate: {} } : { gate: { state: value.state } },
    },
    async execute(args, exec) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_record 只能由 root agent 调用；worker 完成当前 node 后返回 receipt。' }
      const gate = resolveGate(ctx, exec.agent)
      if (gate.config.kind === 'invalid') return { ok: false, code: 'invalid-config', reason: `Gate 配置无效：${gate.config.reason ?? 'unknown'}` }
      if (gate.config.kind !== 'ok') return { ok: false, code: 'not-enabled', reason: '当前项目没有启用的 .agents/gate.json' }
      const state = store.read(gate.root, exec.agent)

      if (state.phase === 'docs') {
        if (args.node !== 'docs') return { ok: false, code: 'wrong-node', expected: 'docs', got: args.node, reason: 'docs 阶段只能通过 gate_record({node:"docs"}) 结束。' }
        state.phase = 'discuss'; state.node = null; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
        store.write(gate.root, exec.agent, state)
        return { ok: true, phase: state.phase, node: state.node, state: normalizeState(state) }
      }
      if (state.phase !== 'orchestrating' && state.phase !== 'reviewing') {
        return { ok: false, code: 'not-orchestrating', phase: state.phase, stateSource: store.source, reason: `当前 phase 是 ${state.phase}；先进入对应阶段。` }
      }
      if (state.node !== args.node) return { ok: false, code: 'wrong-node', expected: state.node, got: args.node, reason: `当前节点是 ${state.node ?? '无'}，不是 ${args.node}。` }

      const axesError = reviewAxesError(args)
      if (axesError !== undefined) return { ok: false, ...axesError }
      const workerError = await workerEvidenceError(ctx, root, args)
      if (workerError !== undefined) return { ok: false, ...workerError }

      const topFindings = Array.isArray(args.findings) ? args.findings : []
      const axesFindings = REVIEW_NODES.has(args.node)
        ? [...args.reviewAxes.standards.findings, ...args.reviewAxes.spec.findings]
        : []
      const findings = [...axesFindings, ...topFindings]
      if (args.requiresDiscussion === true) {
        if (args.node === 'plan-review') state.planReady = false
        state.blockedFrom = { phase: 'discuss', node: null }
        state.phase = 'blocked'
        state.node = null
        state.work = 'blocked'
        state.blockReason = 'needs-user-decision'
        store.write(gate.root, exec.agent, state)
        return { ok: true, phase: state.phase, blockReason: state.blockReason, reason: args.discussionReason ?? null, state: normalizeState(state) }
      }
      if (args.node === 'review') {
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
      } else if (args.node === 'plan') {
        if (typeof args.task !== 'string' || args.task.trim() === '') {
          return { ok: false, code: 'task-required', reason: 'node=plan 必须携带 task（planning 产出的工作项或 mechanical:<说明>）。' }
        }
        state.task = args.task.trim()
        state.node = 'plan-review'
      } else if (args.node === 'plan-revise') state.node = 'plan-review'
      else if (args.node === 'plan-review') {
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
      } else if (args.node === 'implement') state.node = 'code-review'
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
      } else if (args.node === 'verify') {
        const verification = args.verification
        const commands = Array.isArray(verification?.commands) ? verification.commands.filter(item => typeof item === 'string' && item.trim() !== '') : []
        const evidence = Array.isArray(verification?.evidence) ? verification.evidence.filter(item => typeof item === 'string' && item.trim() !== '') : []
        const toolResults = Array.isArray(verification?.toolResults) ? verification.toolResults.filter(item => typeof item === 'string' && item.trim() !== '') : []
        const unbound = await bindToolResults(ctx, Array.isArray(args.workerSessionIds) ? args.workerSessionIds : [], toolResults)
        if (unbound !== undefined) return { ok: false, ...unbound }
        const records = []
        const invalidEvidence = []
        for (const item of evidence) {
          const target = classifyPath(gate.workspace, item, gate.config.policy)
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
          return { ok: false, code: 'verification-required', invalidEvidence, commands, evidence, toolResults, reason: 'verify 需要非空 commands、workspace 内的普通 evidence 文件、toolResults，以及明确的 passed。' }
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
        if (verification.passed !== true) state.node = 'implement-revise'
        else {
          state.phase = 'complete'
          state.node = null
          state.work = 'active'
          state.blockReason = null
          state.blockedFrom = null
        }
      }
      store.write(gate.root, exec.agent, state)
      return { ok: true, phase: state.phase, node: state.node, rounds: state.rounds, blockReason: state.blockReason, verification: state.verification, state: normalizeState(state) }
    },
  })

  ctx.tools.register({
    name: 'gate_note_write',
    description: 'Write a proposed Agent Note under .agents/notes/proposed. Planning workers only; generic write/edit/shell are restricted.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path relative to .agents/notes/proposed, ending in .md.' },
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
      if (gate.config.kind === 'invalid') return { ok: false, code: 'invalid-config', reason: gate.config.reason ?? 'unknown' }
      if (gate.config.kind !== 'ok') return { ok: false, code: 'not-enabled' }
      const effective = effectiveState(ctx, exec.agent, gate, store)
      if (!effective.worker || !['plan', 'plan-revise'].includes(effective.state.node)) {
        return { ok: false, code: 'planning-only', reason: 'gate_note_write 只允许 planning worker 在 plan/plan-revise 节点使用。' }
      }
      const relative = String(args.path ?? '').replaceAll('\\', '/').replace(/^\.?\//u, '')
      if (relative === '' || relative.includes('..') || path.isAbsolute(relative) || !relative.endsWith('.md')) {
        return { ok: false, code: 'invalid-path' }
      }
      const base = path.join(gate.root, '.agents', 'notes', 'proposed')
      const absolute = path.resolve(base, relative)
      if (!isInside(base, absolute)) return { ok: false, code: 'invalid-path' }
      if (pathHasSymlink(base, absolute)) return { ok: false, code: 'invalid-path' }
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, String(args.content ?? ''))
      return { ok: true, path: path.relative(gate.root, absolute).replaceAll('\\', '/') }
    },
  })
}

