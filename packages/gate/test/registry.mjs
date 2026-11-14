import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'
import * as lib from '../lib/index.js'

const expectedExports = ['apply','inject','Config','DISCUSS_ORCHESTRATION','PLAN_ORCHESTRATION','IMPLEMENT_ORCHESTRATION','DOCS_ORCHESTRATION','NOTE_LIFECYCLE_ORCHESTRATION','GATE_RECORD_NODES','NODE_METHODS','WORKER_NODES','transformImplemented','PHASES','defaultState','normalizeState','loadState','saveState'].sort()
assert.deepStrictEqual(Object.keys(lib).sort(), expectedExports)

const tools = []
const commands = []
const sections = []
const guards = []
const preSteps = []
const ctx = {
  inject(names, callback) {
    if (names.includes('sessionProjections')) return callback({ sessionProjections: { register: async () => ({ stateOf: () => ({}) }) } })
    if (names.includes('commands')) return callback({ commands: { register: command => commands.push(command) } })
    if (names.includes('systemPrompt')) return callback({ systemPrompt: { section: section => sections.push(section), getSectionOrder: () => 0 } })
    return undefined
  },
  tools: { register: tool => tools.push(tool), guard: fn => guards.push(fn) },
  on: (event, fn) => preSteps.push({ event, fn }),
  get: () => undefined,
}
apply(ctx, {})
const actual = {
  tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, outputSchema: tool.output?.schema ?? null })),
  commands: commands.map(command => ({ name: command.name, description: command.description, input: command.input ?? null })),
  sections: sections.map(section => ({ name: section.name, order: section.order })),
  guards: guards.length,
  preSteps: preSteps.map(step => step.event),
}
const expected = JSON.parse(readFileSync(new URL('./registry.snapshot.json', import.meta.url), 'utf8'))
assert.deepStrictEqual(actual, expected)
console.log('ok   registry and export snapshot')
