import { defaultState, loadState, normalizeState, saveState } from '../state.js'
import type { GateState } from '../state.js'

export function applyCommandEvent(state: GateState, name: string, args: any) {
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

export function applyProjectionEvent(state: GateState, event: any) {
  if (event.type === 'command/run' && typeof event.data?.name === 'string' && event.data.name.startsWith('gate-')) {
    return {
      ...state,
      pending: { ...(state.pending ?? {}), [event.data.commandId]: { name: event.data.name, args: event.data.args ?? '' } },
    }
  }
  if (event.type === 'command/done') {
    const pending = state.pending?.[event.data?.commandId] as { name: string; args: any } | undefined
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


export interface StateRuntime {
  read(root: any, agent: any): GateState
  write(root: any, agent: any, state: GateState): GateState
  readonly source: string
  readonly projection: any
}

export function createStateRuntime(ctx: any): StateRuntime {
  let handle: any
  ctx.inject(['sessionProjections'], async (scope: any) => {
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
    read(root: any, agent: any) {
      if (handle !== undefined && agent?.session !== undefined) {
        try {
          return normalizeState(handle.stateOf(agent.session))
        } catch { /* fall through to the in-memory store */ }
      }
      return loadState(root, agent)
    },
    write(root: any, agent: any, state: GateState) {
      if (handle !== undefined) return state
      return saveState(root, agent, state)
    },
    get source() { return handle === undefined ? 'memory' : 'projection' },
    get projection() { return handle },
  }
}

