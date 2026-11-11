export const PHASES = ['discuss', 'orchestrating', 'reviewing', 'docs', 'blocked', 'complete']

const states = new Map()

function stateKey(root, agent) {
  return `${root}\u0000${String(agent?.id ?? agent ?? 'anonymous')}`
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

export function normalizeState(value) {
  const base = defaultState()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base
  const phase = PHASES.includes(value.phase) ? value.phase : 'discuss'
  const node = value.node === 'review'
    ? 'code-review-standalone'
    : value.node === 'code-verify'
      ? 'verify-standalone'
      : (typeof value.node === 'string' ? value.node : null)
  return {
    ...base,
    ...value,
    phase,
    node,
    rounds: { planReview: Number(value?.rounds?.planReview) || 0, codeReview: Number(value?.rounds?.codeReview) || 0 },
    exhausted: {
      plan: value?.exhausted?.plan === true,
      code: value?.exhausted?.code === true,
    },
    verification: value?.verification !== null && typeof value?.verification === 'object' ? value.verification : null,
    notePaths: Array.isArray(value?.notePaths) ? value.notePaths : [],
    noteDecision: typeof value?.noteDecision === 'string' ? value.noteDecision : null,
    noteSearch: typeof value?.noteSearch === 'string' ? value.noteSearch : null,
    noteVerified: value?.noteVerified === true,
    noteFinalized: value?.noteFinalized === true,
    noteFinalizeRecovery: Array.isArray(value?.noteFinalizeRecovery) ? value.noteFinalizeRecovery : [],
    pending: value?.pending !== null && typeof value?.pending === 'object' && !Array.isArray(value.pending) ? value.pending : {},
  }
}

export function loadState(root, agent) {
  return clone(states.get(stateKey(root, agent)) ?? defaultState())
}

export function saveState(root, agent, state) {
  const next = normalizeState({ ...state, updatedAt: new Date().toISOString() })
  states.set(stateKey(root, agent), clone(next))
  return clone(next)
}
