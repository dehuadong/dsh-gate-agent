import { classifyPath, shellAccess } from '../classify.js'
import type { ShellAccess } from '../classify.js'
import type { GateState } from '../state.js'
import type { StateRuntime } from './store.js'
import { effectiveState, rootAgentOf, resolveGate, sessionCwd } from './session.js'
import type { GateDeps } from './deps.js'
import path from 'node:path'

export function restrictionFilter(state: GateState, worker: boolean) {
  const writeTools = ['write', 'edit', 'apply_patch', 'pwsh', 'bash']
  if (worker) {
    if (state.node === 'implement' || state.node === 'implement-revise' || state.node === 'fix-bug') return undefined
    return { deny: writeTools }
  }
  return state.phase === 'blocked' ? { deny: ['write', 'edit', 'apply_patch'] } : undefined
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


export function workerWriteAllowed(state: GateState, target: unknown) {
  if (state.phase !== 'orchestrating') return false
  if (state.node === 'plan' || state.node === 'plan-revise') return false
  if (state.node === 'implement' || state.node === 'implement-revise' || state.node === 'fix-bug') return true
  return false
}

export function workerShellAllowed(state: GateState, access: ShellAccess) {
  if (state.phase !== 'orchestrating') return false
  return state.node === 'implement' || state.node === 'implement-revise' || state.node === 'fix-bug'
}


export function targetList(name: string, args: any) {
  if (name !== 'apply_patch') return [args?.file_path]
  return [...String(args?.input ?? '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gmu)]
    .map(match => String(match[1] ?? '').trim())
}

export const GATE_FROZEN_REASON = 'Gate 已冻结：先 /gate-resume 或 /gate-return-discuss'

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
      if (state.phase === 'blocked') return GATE_FROZEN_REASON
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
    if (/\bgit(?:\.exe)?\b[^\n;&|]*\scommit\b/iu.test(String(exec.arguments?.command ?? '')) && effective.worker && !['implement', 'implement-revise', 'fix-bug'].includes(state.node ?? '')) {
      return `worker ${state.node ?? 'unknown'} 不允许 git commit`
    }
    if (!access.write) return undefined
    if (access.outsideTargets.length > 0) return '工作区外写入被拒绝'
    if (effective.worker) return workerShellAllowed(state, access) ? undefined : `worker ${state.node ?? 'unknown'} 不允许写该目标`
    if (state.phase === 'blocked') return GATE_FROZEN_REASON
    return undefined
  }
  return undefined
}


export function installGuard(ctx: any, deps: GateDeps) { ctx.tools.guard((exec: any) => gateDenyReason(ctx, exec, deps.store)) }
export function installRestrictions(ctx: any, deps: GateDeps) { ctx.on('agent/pre-step', async (payload: any, next: any) => { applyRestrictions(ctx, payload.agent, deps.store); return next() }) }
