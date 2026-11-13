import type { GateState } from '../state.js'
import { procedureFor, procedureBlock } from '../protocol.js'
import type { StateRuntime } from './store.js'
import type { GateDeps } from './deps.js'
import { randomUUID } from 'node:crypto'
import { resolveGate } from './session.js'
import { resolveNotesSkill } from '../notes/fs.js'
import { accessFor, accessText } from '../access.js'


export function enterPhase(ctx: any, agent: any, node: string, reviewLimit: number, store: StateRuntime, current: GateState | undefined) {
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


export function wakeGateAgent(invocation: any, text: string, command: string) {
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


export function makeWake(reviewLimit: number) {
  return (invocation: any, state: GateState, text: string, command: string) => {
    const procedure = procedureFor(state, { reviewLimit })
    wakeGateAgent(invocation, `${procedureBlock(procedure)}\n\n${accessText(accessFor(state, false))}\n\n${text}`, command)
  }
}
