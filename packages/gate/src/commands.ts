import path from 'node:path'
import { workspaceBoundary, resolveGate } from './runtime/session.js'
import type { GateDeps } from './runtime/deps.js'
import { enterPhase } from './runtime/gate.js'
import { statusText } from './protocol.js'
import { provisionNotes, provisionCi, provisionProjectScripts, provisionGit } from './notes/provision.js'
import { provisionArtifactPolicy } from './artifacts/policy.js'
import { provisionInitManifest } from './init-manifest.js'
import { normalizeState } from './state.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolveNodeBinary } from './notes/fs.js'
import { NOTES_SKILL_DIR, SKILLS } from './paths.js'
import { runNotesScripts } from './notes/scripts.js'
import { rootAgentOf } from './runtime/session.js'
import type { Phase } from './state.js'
import { accessFor, accessText } from './access.js'
import { MECHANICAL_DECISION } from './note-decisions.js'
import { commandSpec } from './command-catalog.js'
import { nextCommandsFor, nextCommandsText } from './command-next.js'

export function registerCommands(ctx: any, deps: GateDeps) {
  const { store, reviewLimit, wake } = deps
  ctx.inject(['commands'], (scope: any) => {
    const command = (name: string, handler: any) => {
      const spec = commandSpec(name)
      if (spec === undefined) throw new Error(`unknown gate command: ${name}`)
      scope.commands.register({
        name: spec.name,
        description: spec.description,
        ...(spec.hint === null ? {} : { input: { hint: spec.hint } }),
        handler,
      })
    }
    command('gate-init', async (invocation: any) => {
      const workspace = workspaceBoundary(ctx, invocation.agent)
      if (workspace === undefined) return { kind: 'error', text: '无法确定当前会话工作区' }
      const root = path.resolve(workspace)
      let provisioned
      let projectScripts
      let projectCi
      let projectGit
      let artifactPolicy
      let initManifest
      try {
        provisioned = provisionNotes(root)
        artifactPolicy = provisionArtifactPolicy(root)
        projectCi = provisionCi(root)
        projectScripts = provisionProjectScripts(root)
        projectGit = provisionGit(root)
        initManifest = provisionInitManifest(root, projectScripts.command)
      } catch (error) {
        return { kind: 'error', text: `notes 初始化失败：${error instanceof Error ? error.message : String(error)}` }
      }
      wake(invocation, store.read(root, invocation.agent), `Gate 已初始化：${root}（phase=discuss），notes 已初始化为 ${provisioned.notes}，artifact policy 为 ${artifactPolicy.path}（${artifactPolicy.status}），init manifest 为 ${initManifest.path}（${initManifest.status}），AGENTS.md 已更新，verify-notes 已配置为 ${projectScripts.command}，CI 已配置为 ${projectCi.workflow}，git：${projectGit.git}${projectGit.gitError === null ? '' : `（${projectGit.gitError}）`}，ignore：${projectGit.ignore}。`, 'gate-init')
      return { kind: 'success', text: `Gate 已初始化：${root}（phase=discuss）\nnotes：${provisioned.notes}\nartifact policy：${artifactPolicy.path}（${artifactPolicy.status}）\ninit manifest：${initManifest.path}（${initManifest.status}）\nAGENTS：${provisioned.agents}\nverify-notes：${projectScripts.command}\nCI：${projectCi.workflow}\ngit：${projectGit.git}${projectGit.gitError === null ? '' : `（${projectGit.gitError}）`}\nignore：${projectGit.ignore}` }
    })
    command('gate-enter-plan', async (invocation: any) => {
      const result = enterPhase(ctx, invocation.agent, 'plan', reviewLimit, store, undefined)
      if (result.kind === 'error') return result
      const brief = String(invocation.rawInput ?? '').trim()
      wake(invocation, result.state!, `Gate 已进入 plan。用户规划输入：${brief === '' ? '（未提供额外输入）' : brief}。`, 'gate-enter-plan')
      return { kind: 'success', text: '进入 planning。' }
    })
    command('gate-enter-implement', async (invocation: any) => {
      const brief = String(invocation.rawInput ?? '').trim()
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      const direct = state.planReady !== true
      if (direct) {
        if (brief === '') return { kind: 'error', text: '请用一句话说明要实施的内容；不要求工作项格式。' }
        state.task = brief
        state.planReady = false
        state.noteDecision = MECHANICAL_DECISION
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
      wake(invocation, result.state!, `Gate 已进入 implement：${result.state!.task ?? ''}${direct ? '（直接实施，未走 planning）' : ''}。用户说明：${constraints}。`, 'gate-enter-implement')
      return { kind: 'success', text: `进入 implement：${result.state!.task}${direct ? '（直接实施）' : ''}` }
    })
    command('gate-prd', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss') return { kind: 'error', text: 'gate-prd 只在 discuss 阶段可用' }
      const topic = String(invocation.rawInput ?? '').trim() || '当前讨论'
      let skill = ''
      try { skill = readFileSync(path.join(SKILLS, 'gate-prd', 'SKILL.md'), 'utf8') } catch { /* command still reports the requested action */ }
      wake(invocation, state, ['请按 gate-prd 技能创建或更新 PRD。', '主题/上下文：' + topic, skill].filter(Boolean).join('\n\n'), 'gate-prd')
      return { kind: 'success', text: '已请求 PRD：' + topic }
    })
    command('gate-docs', async (invocation: any) => {
      const scope = String(invocation.rawInput ?? '').trim() || '文档治理'
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      state.phase = 'docs'; state.task = scope; state.work = 'active'; state.blockReason = null; state.blockedFrom = null; state.node = null
      store.write(gate.root, invocation.agent, state)
      wake(invocation, state, `Gate 已进入 docs：${scope}。`, 'gate-docs')
      return { kind: 'success', text: `进入 docs：${scope}` }
    })
    command('gate-implement-review', async (invocation: any) => {
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
    command('gate-code-verify', async (invocation: any) => {
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
    command('gate-propose-review', async (invocation: any) => {
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
    command('gate-block', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase === 'blocked') return { kind: 'success', text: '已经是 blocked' }
      state.blockedFrom = { phase: state.phase, node: state.node }
      state.phase = 'blocked'; state.work = 'blocked'; state.node = null
      state.blockReason = String(invocation.rawInput ?? '').trim() || 'user-blocked'
      store.write(gate.root, invocation.agent, state)
      return { kind: 'success', text: `已暂停：${state.blockReason}\n解冻后：${state.blockedFrom?.phase ?? 'discuss'}${state.blockedFrom?.node === null || state.blockedFrom?.node === undefined ? '' : ` / ${state.blockedFrom.node}`}\n同一事项：/gate-resume 回到该节点；改变方案：先 /gate-resume，再 /gate-return-discuss。` }
    })
    command('gate-resume', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'blocked') return { kind: 'error', text: '当前不是 blocked' }
      const from = state.blockedFrom
      const reason = state.blockReason
      state.phase = (from?.phase ?? 'discuss') as Phase; state.node = from?.node ?? null
      state.work = 'active'; state.blockReason = null; state.blockedFrom = null
      store.write(gate.root, invocation.agent, state)
      if (state.phase === 'orchestrating' || state.phase === 'reviewing' || state.phase === 'docs') {
        wake(invocation, state, `Gate 已恢复到 ${state.phase}${state.node === null ? '' : ` / ${state.node}`}。`, 'gate-resume')
      }
      const exhausted = reason === 'plan-review-rounds-exhausted' || reason === 'code-review-rounds-exhausted'
      return { kind: 'success', text: `已解除 blocked：${state.phase}${state.node === null ? '' : ` / ${state.node}`}${exhausted ? '\nreview 轮次已耗尽，不能继续原节点；用 /gate-enter-plan 重新规划。' : '\n已回到暂停前节点，按当前 procedure 继续。'}` }
    })
    command('gate-return-discuss', async (invocation: any) => {
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
    })
    command('gate-status', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const root = rootAgentOf(ctx, invocation.agent)
      const state = store.read(gate.root, root)
      const worker = root?.id !== invocation.agent?.id
      const next = worker ? '' : nextCommandsText(nextCommandsFor(state))
      return { kind: 'success', text: [accessText(accessFor(state, worker)), statusText(state, reviewLimit), next].filter(Boolean).join('\n\n') }
    })
    command('gate-note-verify', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const check = runNotesScripts(gate.root)
      return check.ok
        ? { kind: 'success', text: check.results.map(item => `${item.name}: ok`).join('\n') }
        : { kind: 'error', text: `notes 校验失败：\n${JSON.stringify(check.results, null, 2)}` }
    })
    command('gate-note-archive', async (invocation: any) => {
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
        return { kind: 'error', text: String((error as any)?.stderr ?? (error as any)?.message ?? error).trim() }
      }
    })
    command('gate-note-board', async (invocation: any) => {
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
        return { kind: 'error', text: String((error as any)?.stderr ?? (error as any)?.message ?? error).trim() }
      }
    })
    command('gate-note-seal', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const node = resolveNodeBinary()
      if (node === undefined) return { kind: 'error', text: 'notes-runtime-unavailable' }
      try {
        const script = path.join(NOTES_SKILL_DIR, 'scripts', 'verify-archived-agent-notes.ts')
        const output = execFileSync(node, [script, '--root', path.join(gate.root, '.agents', 'notes'), '--write'], { cwd: gate.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        return { kind: 'success', text: String(output).trim() || 'archived manifest 已写入' }
      } catch (error) {
        return { kind: 'error', text: String((error as any)?.stderr ?? (error as any)?.message ?? error).trim() }
      }
    })
  })
}
