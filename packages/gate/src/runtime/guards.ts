import { classifyPath, shellAccess } from '../classify.js'
import type { GateState } from '../state.js'
import type { StateRuntime } from './store.js'
import { effectiveState, resolveGate, rootAgentOf, sessionCwd } from './session.js'
import type { GateDeps } from './deps.js'
import path from 'node:path'
import { accessFor, repoCommands } from '../access.js'

export const DISCUSS_READ_ONLY = 'discuss 文件只读；要修改请先取得用户授权，然后 gate_start_phase({node:\'plan\'|\'implement\', brief}) 或 /gate-enter-plan / /gate-enter-implement。提交已有改动不受影响。'

export function restrictionFilter(state: GateState, worker: boolean) {
  const access = accessFor(state, worker)
  const deny: string[] = []
  if (access.write === 'none') deny.push('write', 'edit', 'apply_patch')
  return deny.length > 0 ? { deny } : undefined
}

export const restrictionState = new WeakMap()

export function applyRestrictions(ctx: any, agent: any, store: StateRuntime) {
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
          const disposers: Array<() => void> = []
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

export function targetList(name: string, args: any) {
  if (name !== 'apply_patch') return [args?.file_path]
  return [...String(args?.input ?? '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gmu)]
    .map(match => String(match[1] ?? '').trim())
}

export const GATE_FROZEN_REASON = 'Gate 已冻结：先 /gate-resume'

function fileWriteDenied(state: GateState, effective: { worker: boolean }) {
  if (state.phase === 'blocked') return GATE_FROZEN_REASON
  if (!effective.worker && state.phase === 'discuss') return DISCUSS_READ_ONLY
  if (effective.worker && (state.node === 'plan' || state.node === 'plan-revise')) return 'planning worker 只允许 gate_note_write；产品文件和仓库写被拒绝。'
  if (effective.worker) return `当前 ${state.node ?? 'worker'} worker 不允许写文件；review/verify worker 只读。`
  return '当前角色不允许写文件'
}

function shellWriteDenied(state: GateState, effective: { worker: boolean }) {
  if (state.phase === 'blocked') return GATE_FROZEN_REASON
  if (!effective.worker && state.phase === 'discuss') return DISCUSS_READ_ONLY
  if (effective.worker) return `worker ${state.node ?? 'unknown'} 不允许写型 shell。`
  return '当前角色不允许写型 shell'
}

function repoDenied(state: GateState, effective: { worker: boolean }, commands: string) {
  if (effective.worker) return `当前 ${state.node ?? 'worker'} worker 不允许仓库写（${commands}）。`
  return `当前 root 不允许仓库写（${commands}）。`
}

export function gateDenyReason(ctx: any, exec: any, store: StateRuntime) {
  if (exec.name === 'gate_record') {
    const root = rootAgentOf(ctx, exec.agent)
    return root?.id === exec.agent?.id ? undefined : 'gate_record 只能由 root agent 调用'
  }
  if (['subagent', 'subagent_fork', 'workflow'].includes(exec.name)) {
    const gate = resolveGate(ctx, exec.agent)
    const state = store.read(gate.root, exec.agent)
    if (state.phase === 'blocked') return GATE_FROZEN_REASON
    if (state.phase === 'discuss') return 'discuss 不派 worker'
    if (state.node === 'note-lifecycle') return 'note-lifecycle 只做 Note 收尾，不派 worker'
    return undefined
  }
  if (exec.name === 'write' || exec.name === 'edit' || exec.name === 'apply_patch') {
    const gate = resolveGate(ctx, exec.agent)
    const effective = effectiveState(ctx, exec.agent, gate, store)
    const state = effective.state
    const access = accessFor(state, effective.worker)
    const cwd = sessionCwd(ctx, exec.agent, gate.workspace)
    const targets = targetList(exec.name, exec.arguments).filter(value => typeof value === 'string' && value !== '')
    if (targets.length === 0) return undefined
    for (const value of targets) {
      const target = classifyPath(gate.workspace, value, cwd)
      if (target.outside) return '工作区外写入被拒绝'
      if (access.write === 'none') return fileWriteDenied(state, effective)
    }
    return undefined
  }
  if (exec.name === 'pwsh' || exec.name === 'bash') {
    const gate = resolveGate(ctx, exec.agent)
    const effective = effectiveState(ctx, exec.agent, gate, store)
    const state = effective.state
    const access = accessFor(state, effective.worker)
    const base = sessionCwd(ctx, exec.agent, gate.workspace)
    const requested = exec.arguments?.workdir
    const cwd = typeof requested === 'string' && requested !== '' ? path.resolve(base, requested) : base
    const command = String(exec.arguments?.command ?? '')
    const repos = repoCommands(command)
    if (repos.size > 0 && access.repoWrite === 'none') return repoDenied(state, effective, [...repos].join('/'))
    const shell = shellAccess(command, gate.workspace, cwd)
    if (!shell.write) return undefined
    if (shell.outsideTargets.length > 0) return '工作区外写入被拒绝'
    if (access.write === 'none') return shellWriteDenied(state, effective)
    if (effective.worker && access.shell !== 'write') return shellWriteDenied(state, effective)
    if (state.phase === 'blocked') return GATE_FROZEN_REASON
    return undefined
  }
  return undefined
}

export function installGuard(ctx: any, deps: GateDeps) { ctx.tools.guard((exec: any) => gateDenyReason(ctx, exec, deps.store)) }
export function installRestrictions(ctx: any, deps: GateDeps) { ctx.on('agent/pre-step', async (payload: any, next: any) => { applyRestrictions(ctx, payload.agent, deps.store); return next() }) }
