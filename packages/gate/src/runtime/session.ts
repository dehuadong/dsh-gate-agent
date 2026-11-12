import path from 'node:path'
import type { GateState } from '../state.js'
import type { StateRuntime } from './store.js'

export function workspaceBoundary(ctx: any, agent: any): string | undefined {
  try {
    const policy = ctx.get('sandboxPolicy')
    const resolved = policy?.resolve?.({ session: agent?.session })
    if (resolved?.workspaceRoot !== undefined) return resolved.workspaceRoot
  } catch { /* fall through to the session header */ }
  return agent?.session?.header?.cwd
}


export function resolveGate(ctx: any, agent: any): { workspace: any; root: any } {
  const workspace = workspaceBoundary(ctx, agent)
  const root = workspace === undefined ? undefined : path.resolve(workspace)
  if (root === undefined) return { workspace, root: undefined }
  return { workspace: root, root }
}


export function sessionCwd(ctx: any, agent: any, fallback: string): string {
  try {
    const cwd = ctx.get('workingDirectory')?.get?.(agent?.session)
    if (typeof cwd === 'string' && cwd !== '') return cwd
  } catch { /* fall through */ }
  return fallback
}

export function rootAgentOf(ctx: any, agent: any) {
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


export function effectiveState(ctx: any, agent: any, gate: any, store: StateRuntime) {
  const root = rootAgentOf(ctx, agent)
  return { root, state: store.read(gate.root, root), worker: root?.id !== agent?.id }
}
