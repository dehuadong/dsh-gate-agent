export const PHASES = ['discuss', 'orchestrating', 'reviewing', 'docs', 'blocked', 'complete']

/** Fallback store used only when the session projection is unavailable. */
const states = new WeakMap()
const idStates = new Map()

function idKey(root, agent) {
  return `${root}\u0000${String(agent?.id ?? 'anonymous')}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function defaultState() {
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

function textOrNull(value) {
  return typeof value === 'string' ? value : null
}

export function normalizeState(value) {
  const base = defaultState()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base
  const phase = PHASES.includes(value.phase) ? value.phase : 'discuss'
  const blockedFrom = value.blockedFrom !== null && typeof value.blockedFrom === 'object' && !Array.isArray(value.blockedFrom)
    ? { phase: textOrNull(value.blockedFrom.phase), node: textOrNull(value.blockedFrom.node) }
    : null
  return {
    phase,
    node: textOrNull(value.node),
    task: textOrNull(value.task),
    work: textOrNull(value.work) ?? 'active',
    blockReason: textOrNull(value.blockReason),
    rounds: {
      planReview: Number(value?.rounds?.planReview) || 0,
      codeReview: Number(value?.rounds?.codeReview) || 0,
    },
    exhausted: {
      plan: value?.exhausted?.plan === true,
      code: value?.exhausted?.code === true,
    },
    planReady: value.planReady === true,
    verification: value.verification !== null && typeof value.verification === 'object' && !Array.isArray(value.verification)
      ? clone(value.verification)
      : null,
    blockedFrom,
    notePaths: Array.isArray(value.notePaths)
      ? value.notePaths.map(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : entry)
      : [],
    noteDecision: textOrNull(value.noteDecision),
    noteSearch: textOrNull(value.noteSearch),
    noteVerified: value.noteVerified === true,
    noteFinalized: value.noteFinalized === true,
    noteFinalizeRecovery: Array.isArray(value.noteFinalizeRecovery) ? value.noteFinalizeRecovery : [],
    pending: value.pending !== null && typeof value.pending === 'object' && !Array.isArray(value.pending) ? value.pending : {},
    updatedAt: textOrNull(value.updatedAt),
  }
}

export function loadState(root, agent) {
  const session = agent?.session
  if (session !== null && typeof session === 'object' && states.has(session)) {
    return clone(states.get(session))
  }
  return clone(idStates.get(idKey(root, agent)) ?? defaultState())
}

export function saveState(root, agent, state) {
  const next = normalizeState({ ...state, updatedAt: new Date().toISOString() })
  const session = agent?.session
  if (session !== null && typeof session === 'object') states.set(session, clone(next))
  idStates.set(idKey(root, agent), clone(next))
  return clone(next)
}

