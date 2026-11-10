import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { STATE_DIR } from './config.js'

export const PHASES = ['discuss', 'orchestrating', 'reviewing', 'docs', 'blocked', 'complete']

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
    pending: {},
    updatedAt: null,
  }
}

export function normalizeState(value) {
  const base = defaultState()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return base
  const phase = PHASES.includes(value.phase) ? value.phase : 'discuss'
  return {
    ...base,
    ...value,
    phase,
    rounds: { planReview: Number(value?.rounds?.planReview) || 0, codeReview: Number(value?.rounds?.codeReview) || 0 },
    exhausted: {
      plan: value?.exhausted?.plan === true,
      code: value?.exhausted?.code === true,
    },
    verification: value?.verification !== null && typeof value?.verification === 'object' ? value.verification : null,
    pending: value?.pending !== null && typeof value?.pending === 'object' && !Array.isArray(value.pending) ? value.pending : {},
  }
}

export function stateFile(root, agent) {
  const id = createHash('sha1').update(String(agent?.id ?? agent ?? 'anonymous')).digest('hex').slice(0, 16)
  return path.join(root, STATE_DIR, `${id}.json`)
}

export function loadState(root, agent) {
  try {
    return normalizeState(JSON.parse(readFileSync(stateFile(root, agent), 'utf8')))
  } catch {
    return defaultState()
  }
}

export function saveState(root, agent, state) {
  const file = stateFile(root, agent)
  mkdirSync(path.dirname(file), { recursive: true })
  const next = { ...state, updatedAt: new Date().toISOString() }
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(next, null, 2))
  renameSync(temp, file)
  return next
}
