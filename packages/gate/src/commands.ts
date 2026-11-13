import path from 'node:path'
import { workspaceBoundary, resolveGate } from './runtime/session.js'
import type { GateDeps } from './runtime/deps.js'
import { enterPhase } from './runtime/gate.js'
import { statusText } from './protocol.js'
import { provisionNotes, provisionCi, provisionProjectScripts, provisionGit } from './notes/provision.js'
import { normalizeState } from './state.js'
import { execFileSync } from 'node:child_process'
import { resolveNodeBinary } from './notes/fs.js'
import { NOTES_SKILL_DIR } from './paths.js'
import { runNotesScripts } from './notes/scripts.js'
import { rootAgentOf } from './runtime/session.js'
import type { Phase } from './state.js'
import { accessFor, accessText } from './access.js'

export function registerCommands(ctx: any, deps: GateDeps) {
  const { store, reviewLimit, wake } = deps
  ctx.inject(['commands'], (scope: any) => {
    const register = (name: any, description: any, handler: any, input: any = { hint: '<工作项>' }) => scope.commands.register({
      name,
      description,
      ...(input === null ? {} : { input }),
      handler,
    })
    register('gate-init', '初始化 notes、AGENTS.md、verify-notes 与 GitHub Actions CI', async (invocation: any) => {
      const workspace = workspaceBoundary(ctx, invocation.agent)
      if (workspace === undefined) return { kind: 'error', text: '无法确定当前会话工作区' }
      const root = path.resolve(workspace)
      let provisioned
      let projectScripts
      let projectCi
      let projectGit
      try {
        provisioned = provisionNotes(root)
        projectCi = provisionCi(root)
        projectScripts = provisionProjectScripts(root)
        projectGit = provisionGit(root)
      } catch (error) {
        return { kind: 'error', text: `notes 初始化失败：${error instanceof Error ? error.message : String(error)}` }
      }
      wake(invocation, store.read(root, invocation.agent), `Gate 已初始化：${root}（phase=discuss），notes 已初始化为 ${provisioned.notes}，AGENTS.md 已更新，verify-notes 已配置为 ${projectScripts.command}，CI 已配置为 ${projectCi.workflow}，git：${projectGit.git}${projectGit.gitError === null ? '' : `（${projectGit.gitError}）`}，ignore：${projectGit.ignore}。`, 'gate-init')
      return { kind: 'success', text: `Gate 已初始化：${root}（phase=discuss）\nnotes：${provisioned.notes}\nAGENTS：${provisioned.agents}\nverify-notes：${projectScripts.command}\nCI：${projectCi.workflow}\ngit：${projectGit.git}${projectGit.gitError === null ? '' : `（${projectGit.gitError}）`}\nignore：${projectGit.ignore}` }
    }, null)
    register('gate-enter-plan', '按用户简述进入 planning', async (invocation: any) => {
      const result = enterPhase(ctx, invocation.agent, 'plan', reviewLimit, store, undefined)
      if (result.kind === 'error') return result
      const brief = String(invocation.rawInput ?? '').trim()
      wake(invocation, result.state!, `Gate 已进入 plan。用户规划输入：${brief === '' ? '（未提供额外输入）' : brief}。`, 'gate-enter-plan')
      return { kind: 'success', text: '进入 planning。' }
    }, { hint: '[简单需求]' })
    register('gate-enter-implement', '从已确认规划或用户简述进入 implementation', async (invocation: any) => {
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
      wake(invocation, result.state!, `Gate 已进入 implement：${result.state!.task ?? ''}${direct ? '（直接实施，未走 planning）' : ''}。用户说明：${constraints}。`, 'gate-enter-implement')
      return { kind: 'success', text: `进入 implement：${result.state!.task}${direct ? '（直接实施）' : ''}` }
    }, { hint: '[简单说明]' })
    register('gate-fix-bug', '为已授权的实现缺陷派发 fix worker', async (invocation: any) => {
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
    register('gate-docs', '开始文档治理', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase !== 'discuss' && state.phase !== 'complete') return { kind: 'error', text: `当前 phase 是 ${state.phase}` }
      if (state.work === 'blocked' || state.blockReason !== null) return { kind: 'error', text: `当前被 blocked：${state.blockReason ?? 'unknown'}；先 /gate-resume` }
      state.phase = 'docs'; state.task = '文档治理'; state.work = 'active'; state.blockReason = null; state.blockedFrom = null; state.node = null
      store.write(gate.root, invocation.agent, state)
      wake(invocation, state, 'Gate 已进入 docs。', 'gate-docs')
      return { kind: 'success', text: '进入 docs：文档治理' }
    }, null)
    register('gate-implement-review', '开始独立只读 code review', async (invocation: any) => {
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
    register('gate-code-verify', '开始独立只读验收', async (invocation: any) => {
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
    register('gate-propose-review', '开始独立提案评审', async (invocation: any) => {
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
    register('gate-block', '手动暂停：保留当前节点并停止写入/派 worker；对话仍可继续', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const state = store.read(gate.root, invocation.agent)
      if (state.phase === 'blocked') return { kind: 'success', text: '已经是 blocked' }
      state.blockedFrom = { phase: state.phase, node: state.node }
      state.phase = 'blocked'; state.work = 'blocked'; state.node = null
      state.blockReason = String(invocation.rawInput ?? '').trim() || 'user-blocked'
      store.write(gate.root, invocation.agent, state)
      return { kind: 'success', text: `已暂停：${state.blockReason}\n解冻后：${state.blockedFrom?.phase ?? 'discuss'}${state.blockedFrom?.node === null || state.blockedFrom?.node === undefined ? '' : ` / ${state.blockedFrom.node}`}\n同一事项：/gate-resume 回到该节点；改变方案：/gate-return-discuss。` }
    }, { hint: '[原因]' })
    register('gate-resume', '解冻 blocked：回到 block 前的节点；轮次耗尽回 discuss', async (invocation: any) => {
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
    }, null)
    register('gate-return-discuss', '回到 discuss', async (invocation: any) => {
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
    register('gate-status', '查看当前 gate 状态', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const root = rootAgentOf(ctx, invocation.agent)
      const state = store.read(gate.root, root)
      const worker = root?.id !== invocation.agent?.id
      return { kind: 'success', text: [accessText(accessFor(state, worker)), statusText(state, reviewLimit)].join('\n\n') }
    }, null)
    register('gate-note-verify', '只读检查 notes tree/format/lifecycle/archived', async (invocation: any) => {
      const gate = resolveGate(ctx, invocation.agent)
      const check = runNotesScripts(gate.root)
      return check.ok
        ? { kind: 'success', text: check.results.map(item => `${item.name}: ok`).join('\n') }
        : { kind: 'error', text: `notes 校验失败：\n${JSON.stringify(check.results, null, 2)}` }
    }, null)
    register('gate-note-archive', '将 implemented Note 归档到 archived/：加 Archived、移动、封印并报告入站链接', async (invocation: any) => {
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
    }, { hint: '<implemented-note> [--superseded-by <new-note>]' })
    register('gate-note-board', '生成决策看板 board.html（轻量模式，连接本地 notes 目录）', async (invocation: any) => {
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
    }, { hint: '[输出路径] [标题]' })
    register('gate-note-seal', '只给 archived/ 中已有 Note 补写 manifest.json 的 SHA-256 封印；不归档、不改 Note 内容', async (invocation: any) => {
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
    }, null)
  })
}
