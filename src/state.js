import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
    worker: null,
    planReady: false,
    planApprovedAt: null,
    blockedFrom: null,
    updatedAt: null,
  }
}

export function stateFile(root, agent) {
  const id = createHash('sha1').update(String(agent?.id ?? agent ?? 'anonymous')).digest('hex').slice(0, 16)
  return path.join(root, STATE_DIR, `${id}.json`)
}

export function loadState(root, agent) {
  try {
    const value = JSON.parse(readFileSync(stateFile(root, agent), 'utf8'))
    const phase = PHASES.includes(value?.phase) ? value.phase : 'discuss'
    return {
      ...defaultState(),
      ...value,
      phase,
      rounds: { planReview: Number(value?.rounds?.planReview) || 0, codeReview: Number(value?.rounds?.codeReview) || 0 },
    }
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

export function childStateId(childId) {
  return { id: String(childId) }
}
