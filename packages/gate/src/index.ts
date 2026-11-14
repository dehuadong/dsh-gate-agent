import { DEFAULT_REVIEW_LIMIT, Config } from './config.js'
import { GATE_RECORD_NODES, NODE_METHODS, WORKER_NODES, DISCUSS_ORCHESTRATION, PLAN_ORCHESTRATION, IMPLEMENT_ORCHESTRATION, DOCS_ORCHESTRATION, NOTE_LIFECYCLE_ORCHESTRATION } from './protocol.js'
import { PHASES, defaultState, loadState, normalizeState, saveState } from './state.js'
import { transformImplemented } from './notes/note-files.js'
import { createStateRuntime } from './runtime/store.js'
import { makeWake } from './runtime/gate.js'
import { installSystemPrompt } from './runtime/prompt.js'
import { installGuard, installRestrictions } from './runtime/guards.js'
import { registerCommands } from './commands.js'
import { registerTools } from './tools/index.js'

export { Config, DISCUSS_ORCHESTRATION, PLAN_ORCHESTRATION, IMPLEMENT_ORCHESTRATION, DOCS_ORCHESTRATION, NOTE_LIFECYCLE_ORCHESTRATION, GATE_RECORD_NODES, NODE_METHODS, WORKER_NODES, PHASES, defaultState, loadState, normalizeState, saveState, transformImplemented }
export const inject = ['tools']

export function apply(ctx: any, config: any = {}) {
  const reviewLimit = Number.isInteger(config?.reviewLimit) ? config.reviewLimit : DEFAULT_REVIEW_LIMIT
  const store = createStateRuntime(ctx)
  const wake = makeWake(reviewLimit)
  const deps = { ctx, store, reviewLimit, wake }
  installSystemPrompt(ctx, deps)
  installGuard(ctx, deps)
  installRestrictions(ctx, deps)
  registerCommands(ctx, deps)
  registerTools(ctx, deps)
}
