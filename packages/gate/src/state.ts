import { isNoteDecision } from './note-decisions.js'
import type { NoteDecision } from './note-decisions.js'

export const PHASES = ['discuss', 'orchestrating', 'reviewing', 'docs', 'blocked', 'complete'] as const

export type Phase = typeof PHASES[number]

export interface NotePath {
  path: string
  class?: string
  lifecycle?: string
  [key: string]: unknown
}

export interface GateState {
  phase: Phase
  node: string | null
  task: string | null
  work: string
  blockReason: string | null
  rounds: { planReview: number; codeReview: number }
  exhausted: { plan: boolean; code: boolean }
  planReady: boolean
  verification: Record<string, unknown> | null
  blockedFrom: { phase: string | null; node: string | null } | null
  notePaths: NotePath[]
  noteDecision: NoteDecision | null
  noteSearch: string | null
  noteVerified: boolean
  noteFinalized: boolean
  noteFinalizeRecovery: unknown[]
  pending: Record<string, unknown>
  updatedAt: string | null
}

export interface AgentLike {
  id?: string
  session?: object
}

/** Fallback store used only when the session projection is unavailable. */
const states = new WeakMap<object, GateState>()
const idStates = new Map<string, GateState>()

function idKey(root: string, agent: AgentLike | undefined): string {
  return `${root}\u0000${String(agent?.id ?? 'anonymous')}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function defaultState(): GateState {
  return {
    phase: 'discuss',
    node: null,
    task: null,
    work: 'active',
    blockReason: null,
    rounds: { planReview: 0, codeReview: 0 },
    exhausted: { plan: false, code: false },
    planReady: false,
    verification: null,
    blockedFrom: null,
    notePaths: [],
    noteDecision: null,
    noteSearch: null,
    noteVerified: false,
    noteFinalized: false,
    noteFinalizeRecovery: [],
    pending: {},
    updatedAt: null,
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function normalizeState(value: unknown): GateState {
  const base = defaultState()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base
  const source = value as Record<string, any>
  const phase: Phase = (PHASES as readonly string[]).includes(source.phase) ? source.phase as Phase : 'discuss'
  const blockedFrom = source.blockedFrom !== null && typeof source.blockedFrom === 'object' && !Array.isArray(source.blockedFrom)
    ? { phase: textOrNull(source.blockedFrom.phase), node: textOrNull(source.blockedFrom.node) }
    : null
  return {
    phase,
    node: textOrNull(source.node),
    task: textOrNull(source.task),
    work: textOrNull(source.work) ?? 'active',
    blockReason: textOrNull(source.blockReason),
    rounds: {
      planReview: Number(source.rounds?.planReview) || 0,
      codeReview: Number(source.rounds?.codeReview) || 0,
    },
    exhausted: {
      plan: source.exhausted?.plan === true,
      code: source.exhausted?.code === true,
    },
    planReady: source.planReady === true,
    verification: source.verification !== null && typeof source.verification === 'object' && !Array.isArray(source.verification)
      ? clone(source.verification as Record<string, unknown>)
      : null,
    blockedFrom,
    notePaths: Array.isArray(source.notePaths)
      ? source.notePaths.map((entry: unknown) => (entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry) as NotePath)
      : [],
    noteDecision: isNoteDecision(source.noteDecision) ? source.noteDecision : null,
    noteSearch: textOrNull(source.noteSearch),
    noteVerified: source.noteVerified === true,
    noteFinalized: source.noteFinalized === true,
    noteFinalizeRecovery: Array.isArray(source.noteFinalizeRecovery) ? source.noteFinalizeRecovery : [],
    pending: source.pending !== null && typeof source.pending === 'object' && !Array.isArray(source.pending) ? source.pending as Record<string, unknown> : {},
    updatedAt: textOrNull(source.updatedAt),
  }
}

export function loadState(root: string, agent: AgentLike | undefined): GateState {
  const session = agent?.session
  if (session !== null && typeof session === 'object' && states.has(session)) {
    return clone(states.get(session) as GateState)
  }
  return clone(idStates.get(idKey(root, agent)) ?? defaultState())
}

export function saveState(root: string, agent: AgentLike | undefined, state: GateState): GateState {
  const next = normalizeState({ ...state, updatedAt: new Date().toISOString() })
  const session = agent?.session
  if (session !== null && typeof session === 'object') states.set(session, clone(next))
  idStates.set(idKey(root, agent), clone(next))
  return clone(next)
}
