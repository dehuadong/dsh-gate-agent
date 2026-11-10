import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyPath, shellAccess } from './src/classify.js'
import { DEFAULT_CODE_EXTENSIONS, DEFAULT_PROTECTED, MARKER, findGateRoot, findProjectRoot, loadConfig, validateConfig } from './src/config.js'
import { childStateId, defaultState, loadState, saveState } from './src/state.js'

export const inject = ['tools', 'subagents']
const SKILLS = fileURLToPath(new URL('./skills', import.meta.url))
const REPO_ROOT = path.resolve(SKILLS, '../../..')
const NOTE_SKILL = path.join(REPO_ROOT, '.agents', 'skills', 'write-agent-notes')
const SKILL_NAMES = ['gate-planning', 'gate-plan-review', 'gate-implement', 'gate-code-review-standards', 'gate-code-review-spec', 'gate-verify']
const REVIEW_LIMIT = 5

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

export const PLAN_ORCHESTRATION = `## /gate-plan orchestration
Main agent dispatches workers; gate does not dispatch.
1. Dispatch gate-planning with the task, skill name gate-planning, and the resource paths below. The worker loads the skill and reads its resources; the main agent must not read method bodies.
2. Call gate_record({node:'plan'}).
3. Dispatch gate-plan-review read-only; call gate_record({node:'plan-review',findings,requiresDiscussion}).
4. If requiresDiscussion: call gate_record for the current node with requiresDiscussion:true and stop; if gate_record fails, ask the user to run /gate-return-discuss. If findings remain: dispatch gate-planning revise, call gate_record({node:'plan-revise'}), then review again.
5. At five review rounds with findings, gate marks blocked; never claim pass.
6. Empty review returns to discuss.`

function methodFiles(node) {
  if (node === 'plan') {
    return [
      path.join(SKILLS, 'gate-planning', 'SKILL.md'),
      path.join(SKILLS, 'gate-planning', 'proposal.md'),
      path.join(SKILLS, 'gate-planning', 'rfc.md'),
      path.join(NOTE_SKILL, 'SKILL.md'),
      path.join(NOTE_SKILL, 'templates', 'proposed.md'),
    ]
  }
  if (node === 'implement') {
    return [
      path.join(SKILLS, 'gate-implement', 'SKILL.md'),
      path.join(SKILLS, 'gate-implement', 'tickets.md'),
      path.join(SKILLS, 'gate-code-review-standards', 'SKILL.md'),
      path.join(SKILLS, 'gate-code-review-spec', 'SKILL.md'),
      path.join(SKILLS, 'gate-verify', 'SKILL.md'),
    ]
  }
  return []
}

export const IMPLEMENT_ORCHESTRATION = `## /gate-implement orchestration
Main agent dispatches workers; gate does not dispatch.
1. Dispatch gate-implement with the accepted work item, skill name gate-implement, and resource paths. The worker loads the skill and resource files; the main agent must not read method bodies.
2. Call gate_record({node:'implement'}).
3. Dispatch gate-code-review-standards and gate-code-review-spec, both read-only.
4. Call gate_record({node:'code-review',findings,requiresDiscussion}) with the two-axis result.
5. If requiresDiscussion: call gate_record for the current node with requiresDiscussion:true and stop; if gate_record fails, ask the user to run /gate-return-discuss. If findings remain: dispatch gate-implement revise, call gate_record({node:'implement-revise'}), then review again.
6. Empty findings: dispatch gate-verify and call gate_record({node:'verify',verification}).
7. Verify FAIL routes back to implement-revise; PASS completes. At five rounds, blocked.`

export const DOCS_ORCHESTRATION = `## /gate-docs orchestration
Edit only documents and notes; no planning or implementation skill, no code.
Return to discuss explicitly.`

function workspaceBoundary(ctx, agent) {
  try {
    const policy = ctx.get('sandboxPolicy')
    const resolved = policy?.resolve?.(agent)
    if (resolved?.workspaceRoot !== undefined) return resolved.workspaceRoot
  } catch { /* fall through */ }
  return agent?.session?.header?.cwd
}

function resolveGate(ctx, agent) {
  const workspace = workspaceBoundary(ctx, agent)
  if (workspace === undefined) return { workspace: undefined, root: undefined, config: { kind: 'none' } }
  const root = findGateRoot(workspace)
  if (root === undefined) return { workspace, root: undefined, config: { kind: 'none' } }
  return { workspace, root, config: loadConfig(root) }
}

function skillText(name) {
  try {
    return readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8')
  } catch {
    return ''
  }
}

function statusText(state) {
  return [
    `状态：${state.phase}`,
    `节点：${state.node ?? '无'}`,
    `工作项：${state.task ?? '无'}`,
    `work：${state.work}`,
    `blockReason：${state.blockReason ?? '无'}`,
    `planReady：${state.planReady ? '是' : '否'}`,
    `rounds：plan ${state.rounds?.planReview ?? 0}/5, code ${state.rounds?.codeReview ?? 0}/5`,
  ].join('\n')
}

function rootAgentOf(ctx, agent) {
  try {
    return ctx.get('subagents')?.rootOf?.(agent) ?? agent
  } catch {
    return agent
  }
}

function effectiveState(ctx, agent, gate) {
  const root = rootAgentOf(ctx, agent)
  return { root, state: loadState(gate.root, root), worker: root?.id !== agent?.id }
}

function workerWriteAllowed(state, target) {
  if (state.phase !== 'orchestrating') return false
  if (state.node === 'plan' || state.node === 'plan-revise') return target.docs === true
  if (state.node === 'implement' || state.node === 'implement-revise') return target.docs === true || target.code === true
  if (state.node === 'verify') return target.docs === true
  return false
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

function enterPhase(ctx, agent, node) {
  const gate = resolveGate(ctx, agent)
  if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
  const state = loadState(gate.root, agent)
  if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
  if (node === 'implement') {
    if (typeof state.task !== 'string' || state.task === '') return { kind: 'error', text: '没有可实施的工作项：先完成 planning' }
    if (state.planReady !== true) return { kind: 'error', text: 'planning 尚未通过：先完成 /gate-enter-plan 与 clean plan review' }
  }
  state.phase = 'orchestrating'
  state.node = node
  state.work = 'active'
  state.blockReason = null
  state.rounds = { planReview: 0, codeReview: 0 }
  if (node === 'plan') {
    state.task = null
    state.planReady = false
    state.planApprovedAt = null
  }
  saveState(gate.root, agent, state)
  return { gate, state }
}

export function apply(ctx) {
  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.section({
      name: 'gate:protocol',
      order: scope.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: context => {
        const gate = resolveGate(ctx, context.agent)
        if (gate.config.kind !== 'ok') return ''
        const state = loadState(gate.root, context.agent)
        const phaseNote = {
          discuss: DISCUSS_ORCHESTRATION,
          orchestrating: '主代理编排中；按节点协议派发 worker，不直接写文件。',
          reviewing: '只读 code review；只输出 findings，不写代码、不修复、不 verify。',
          docs: DOCS_ORCHESTRATION,
          blocked: 'Gate 已冻结；等待 /gate-resume。',
          complete: 'Gate 已完成；新任务需要重新授权。',
        }[state.phase] ?? ''
        const protocol = state.node === 'plan'
          ? PLAN_ORCHESTRATION
          : state.node === 'implement'
            ? IMPLEMENT_ORCHESTRATION
            : ''
        const files = methodFiles(state.node)
        return [`## Gate`, statusText(state), phaseNote, protocol, files.length === 0 ? '' : `## Method files\n${files.join('\n')}`].filter(Boolean).join('\n\n')
      },
    })
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (['subagent', 'subagent_fork', 'workflow'].includes(exec.name)) {
      const gate = resolveGate(ctx, exec.agent)
      if (gate.config.kind === 'ok' && loadState(gate.root, exec.agent).phase === 'discuss') {
        return { kind: 'deny', reason: 'discuss 只读讨论，不派 worker' }
      }
      return next()
    }
    if (exec.name === 'write' || exec.name === 'edit') {
      const gate = resolveGate(ctx, exec.agent)
      if (gate.config.kind !== 'ok') return next()
      const effective = effectiveState(ctx, exec.agent, gate)
      const state = effective.state
      const target = classifyPath(gate.workspace, exec.arguments?.file_path, gate.config.policy)
      if (target.outside) return { kind: 'deny', reason: '工作区外写入被拒绝' }
      if (target.protected) return { kind: 'deny', reason: 'Gate 配置和状态不可写' }
      if (effective.worker) {
        return workerWriteAllowed(state, target)
          ? next()
          : { kind: 'deny', reason: `worker ${state.node ?? 'unknown'} 不允许写该目标` }
      }
      if (state.phase === 'discuss' || state.phase === 'complete') return { kind: 'deny', reason: '当前阶段不允许写入' }
      if (state.phase === 'orchestrating') return { kind: 'deny', reason: '主代理编排中，不允许直接写入' }
      if (target.code && state.phase !== 'implement') return { kind: 'deny', reason: '只有 implement 阶段允许写代码' }
      if (target.docs && !['planning', 'docs', 'implement'].includes(state.phase)) return { kind: 'deny', reason: '文档写入未授权' }
      return next()
    }
    if (exec.name === 'pwsh' || exec.name === 'bash') {
      const gate = resolveGate(ctx, exec.agent)
      if (gate.config.kind !== 'ok') return next()
      const effective = effectiveState(ctx, exec.agent, gate)
      const state = effective.state
      const cwd = exec.arguments?.workdir ?? gate.workspace
      const access = shellAccess(exec.arguments?.command ?? '', gate.workspace, gate.config.policy, cwd)
      if (!access.write) return next()
      if (access.protectedTargets.length > 0) return { kind: 'deny', reason: 'Gate 配置和状态不可写' }
      if (access.outsideTargets.length > 0) return { kind: 'deny', reason: '工作区外写入被拒绝' }
      if (effective.worker) {
        const allowed = access.codeTargets.length > 0
          ? (state.node === 'implement' || state.node === 'implement-revise')
          : state.node !== 'plan-review' && state.node !== 'code-review'
        return allowed ? next() : { kind: 'deny', reason: `worker ${state.node ?? 'unknown'} 不允许写该目标` }
      }
      if (state.phase === 'orchestrating' || state.phase === 'discuss' || state.phase === 'complete') return { kind: 'deny', reason: '当前阶段不允许写入' }
      if (access.codeTargets.length > 0 && state.phase !== 'implement') return { kind: 'deny', reason: '只有 implement 阶段允许写代码' }
      return next()
    }
    return next()
  })

  ctx.inject(['skills'], scope => {
    for (const name of SKILL_NAMES) {
      const content = skillText(name)
      if (content === '') continue
      scope.skills.register({ name, description: `Gate phase skill: ${name}`, source: 'plugin:gate', content })
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
      const workspace = workspaceBoundary(ctx, invocation.agent)
      if (workspace === undefined) return { kind: 'error', text: '无法确定当前会话工作区' }
      const existing = findGateRoot(workspace)
      if (existing !== undefined) return { kind: 'error', text: `Gate 已存在：${path.join(existing, MARKER)}` }
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
        codePaths: [],
        protected: DEFAULT_PROTECTED,
      }
      const config = validateConfig(value, marker)
      if (config.kind !== 'ok') return { kind: 'error', text: `Gate 配置无效：${config.reason ?? config.kind}` }
      mkdirSync(path.dirname(marker), { recursive: true })
      writeFileSync(marker, `${JSON.stringify(value, null, 2)}\n`)
      return { kind: 'success', text: `已启用 Gate：${marker}（phase=discuss）` }
    }, null)
    register('gate-enter-plan', 'Enter planning for the current discussion', async invocation => {
      const result = enterPhase(ctx, invocation.agent, 'plan')
      if (result.kind === 'error') return result
      return { kind: 'success', text: '进入 planning：工作项将在规划中确定。\n按注入协议派发 gate-planning。' }
    }, null)
    register('gate-enter-implement', 'Enter implementation for the planned work item', async invocation => {
      const result = enterPhase(ctx, invocation.agent, 'implement')
      if (result.kind === 'error') return result
      return { kind: 'success', text: `进入 implement：${result.state.task}\n按注入协议派发 gate-implement。` }
    }, null)
    register('gate-docs', 'Start docs governance', async invocation => {
      const task = String(invocation.rawInput ?? '').trim()
      if (task === '') return { kind: 'error', text: '缺少范围' }
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = loadState(gate.root, invocation.agent)
      state.phase = 'docs'; state.task = task; state.work = 'active'; state.blockReason = null; state.node = null
      saveState(gate.root, invocation.agent, state)
      return { kind: 'success', text: `进入 docs：${task}` }
    })
    register('gate-code-review', 'Start a standalone read-only code review', async invocation => {
      const task = String(invocation.rawInput ?? '').trim()
      if (task === '') return { kind: 'error', text: '缺少审查范围' }
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = loadState(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      state.phase = 'reviewing'; state.task = task; state.node = 'review'; state.work = 'active'; state.blockReason = null
      saveState(gate.root, invocation.agent, state)
      return { kind: 'success', text: `进入只读 code review：${task}\n主代理加载 code-review 并派两轴。` }
    })
    register('gate-block', 'Block the current gate', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = loadState(gate.root, invocation.agent)
      if (state.phase === 'blocked') return { kind: 'success', text: '已经是 blocked' }
      state.blockedFrom = { phase: state.phase, node: state.node }
      state.phase = 'blocked'; state.work = 'blocked'; state.node = null
      state.blockReason = String(invocation.rawInput ?? '').trim() || 'user-blocked'
      saveState(gate.root, invocation.agent, state)
      return { kind: 'success', text: `已 block：${state.blockReason}` }
    }, { hint: '[原因]' })
    register('gate-resume', 'Resume a blocked gate', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = loadState(gate.root, invocation.agent)
      if (state.phase !== 'blocked') return { kind: 'error', text: '当前不是 blocked' }
      const from = state.blockedFrom
      state.phase = from?.phase ?? 'discuss'; state.node = from?.node ?? null
      state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      saveState(gate.root, invocation.agent, state)
      return { kind: 'success', text: `已恢复到 ${state.phase}${state.node === null ? '' : ` / ${state.node}`}` }
    }, null)
    register('gate-return-discuss', 'Return to discuss', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      const state = loadState(gate.root, invocation.agent)
      state.phase = 'discuss'; state.node = null; state.blockReason = null
      saveState(gate.root, invocation.agent, state)
      return { kind: 'success', text: '已回到 discuss' }
    }, null)
    register('gate-status', 'Show current gate state', async invocation => {
      const gate = resolveGate(ctx, invocation.agent)
      if (gate.config.kind !== 'ok') return { kind: 'error', text: '当前项目没有启用的 .agents/gate.json' }
      return { kind: 'success', text: statusText(loadState(gate.root, invocation.agent)) }
    }, null)
  })

  ctx.tools.register({
    name: 'gate_record',
    description: 'Record the result of one main-agent-dispatched phase worker (plan, plan-review, plan-revise, implement, code-review, implement-revise, verify) and advance the gate state.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', enum: ['plan', 'plan-review', 'plan-revise', 'implement', 'code-review', 'implement-revise', 'verify', 'review'] },
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
            passed: { type: 'boolean' },
          },
          required: ['commands', 'evidence', 'passed'],
        },
      },
      required: ['node'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const gate = resolveGate(ctx, exec.agent)
      if (gate.config.kind !== 'ok') return { ok: false, code: 'not-enabled' }
      const state = loadState(gate.root, exec.agent)
      if (state.phase !== 'orchestrating' && state.phase !== 'reviewing') return { ok: false, code: 'not-orchestrating', phase: state.phase }
      if (state.node !== args.node) return { ok: false, code: 'wrong-node', expected: state.node, got: args.node }
      const findings = Array.isArray(args.findings) ? args.findings : []
      if (args.requiresDiscussion === true) {
        if (args.node === 'plan-review') state.planReady = false
        state.phase = 'discuss'
        state.node = null
        state.blockReason = 'needs-user-decision'
        saveState(gate.root, exec.agent, state)
        return { ok: true, phase: 'discuss', blockReason: state.blockReason, reason: args.discussionReason ?? null }
      }
      if (args.node === 'review') {
        state.phase = 'discuss'
        state.node = null
        state.blockReason = null
      } else if (args.node === 'plan') {
        if (typeof args.task === 'string' && args.task.trim() !== '') state.task = args.task.trim()
        state.node = 'plan-review'
      } else if (args.node === 'plan-revise') state.node = 'plan-review'
      else if (args.node === 'plan-review') {
        state.rounds.planReview += 1
        if (findings.length === 0) {
          state.phase = 'discuss'
          state.node = null
          state.planReady = true
          state.planApprovedAt = new Date().toISOString()
          state.blockReason = null
        } else if (state.rounds.planReview >= REVIEW_LIMIT) {
          state.phase = 'discuss'
          state.node = null
          state.planReady = false
          state.work = 'blocked'
          state.blockReason = 'plan-review-rounds-exhausted'
        } else state.node = 'plan-revise'
      } else if (args.node === 'implement') state.node = 'code-review'
      else if (args.node === 'implement-revise') state.node = 'code-review'
      else if (args.node === 'code-review') {
        state.rounds.codeReview += 1
        if (findings.length === 0) state.node = 'verify'
        else if (state.rounds.codeReview >= REVIEW_LIMIT) { state.phase = 'discuss'; state.node = null; state.work = 'blocked'; state.blockReason = 'code-review-rounds-exhausted' }
        else state.node = 'implement-revise'
      } else if (args.node === 'verify') {
        const verification = args.verification
        const commands = Array.isArray(verification?.commands) ? verification.commands : []
        const evidence = Array.isArray(verification?.evidence) ? verification.evidence : []
        const missingEvidence = evidence.filter(item => !existsSync(path.resolve(gate.workspace, String(item))))
        if (commands.length === 0 || evidence.length === 0 || missingEvidence.length > 0 || typeof verification?.passed !== 'boolean') {
          return { ok: false, code: 'verification-required', missingEvidence, commands, evidence }
        }
        if (verification.passed !== true) state.node = 'implement-revise'
        else { state.phase = 'complete'; state.node = null; state.blockReason = null; state.work = 'active' }
      }
      saveState(gate.root, exec.agent, state)
      return { ok: true, phase: state.phase, node: state.node, rounds: state.rounds, blockReason: state.blockReason }
    },
  })
}
