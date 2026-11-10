// Core checks for the replacement gate: state, docs, commands, gate_record.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, DISCUSS_ORCHESTRATION } from './index.js'
import { loadState, saveState, defaultState } from './src/state.js'

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`ok   ${name}`)
  else { failures += 1; console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

function fakeHost(workspace, rootSession) {
  const commands = {}
  const tools = {}
  const handlers = {}
  const sections = []
  const ctx = {
    on: (name, handler) => { handlers[name] = handler },
    inject: (_deps, callback) => callback(ctx),
    get: name => name === 'sandboxPolicy' ? { workspaceRoot: workspace, resolve: () => ({ workspaceRoot: workspace }) }
      : name === 'subagents' && rootSession !== undefined ? { rootOf: () => rootSession } : undefined,
    systemPrompt: { section: definition => sections.push(definition), getSectionOrder: () => 500 },
    skills: { register: () => {} },
    commands: { register: definition => { commands[definition.name] = definition } },
    tools: { register: definition => { tools[definition.name] = definition } },
  }
  apply(ctx)
  return { commands, tools, handlers, sections }
}

function makeWorkspace() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'gate-core-'))
  mkdirSync(path.join(workspace, '.agents', 'notes', 'proposed', 'feature'), { recursive: true })
  writeFileSync(path.join(workspace, '.agents', 'gate.json'), JSON.stringify({
    enabled: true, version: 2, codeExtensions: ['.ts'], codePaths: [],
  }))
  writeFileSync(path.join(workspace, '.agents', 'notes', 'proposed', 'feature', '2026-11-07-work.md'), '---\nStatus: proposed\n---\n')
  return workspace
}

const workspace = makeWorkspace()
const host = fakeHost(workspace)
const agent = { id: 'session-test', session: { header: {} } }
const execWith = (target, targetAgent, name, args) => target.handlers['tools/pre-execute']({ name, arguments: args, agent: targetAgent, signal: new AbortController().signal }, async () => ({ kind: 'allow' }))
const exec = (name, args) => execWith(host, agent, name, args)
const run = (name, input) => host.commands[name].handler({ agent, rawInput: input, attachments: [] })
const record = args => host.tools.gate_record.execute(args, { agent, signal: new AbortController().signal })

check('docs command registered', typeof host.commands['gate-docs']?.handler === 'function')
check('status command registered', typeof host.commands['gate-status']?.handler === 'function')
check('discuss denies code', (await exec('write', { file_path: 'src/x.ts' })).kind === 'deny')
check('discuss denies docs', (await exec('write', { file_path: 'docs/x.md' })).kind === 'deny')
await run('gate-docs', 'docs/')
check('docs command enters docs', loadState(workspace, agent).phase === 'docs')
check('docs phase allows docs', (await exec('write', { file_path: 'docs/x.md' })).kind === 'allow')
check('docs phase denies code', (await exec('write', { file_path: 'src/x.ts' })).kind === 'deny')
await run('gate-return-discuss', '')
check('return enters discuss', loadState(workspace, agent).phase === 'discuss')
const status = await run('gate-status', '')
check('status is factual', status.text.includes('状态：discuss') && status.text.includes('blockReason：无') && !status.text.includes('下一步'))
check('discuss protocol is read-only and default', DISCUSS_ORCHESTRATION.includes('discuss 是默认阶段') && DISCUSS_ORCHESTRATION.includes('只读讨论') && !DISCUSS_ORCHESTRATION.includes('/discuss'))
const gateSection = host.sections.find(section => section.name === 'gate:protocol')
check('discuss prompt does not claim orchestration', gateSection.text({ agent }).includes('只读讨论') && !gateSection.text({ agent }).includes('编排中'))
check('discuss denies worker dispatch', (await exec('subagent', { description: 'x', prompt: 'x' })).kind === 'deny')

const withoutPlan = await run('gate-enter-implement')
check('implement without plan review is rejected', withoutPlan.kind === 'error' && loadState(workspace, agent).planReady !== true)

await run('gate-enter-plan')
check('plan command enters orchestrating', loadState(workspace, agent).phase === 'orchestrating' && loadState(workspace, agent).node === 'plan')
check('plan review can start', (await record({ node: 'plan', task: 'work' })).ok === true && loadState(workspace, agent).node === 'plan-review')
check('empty plan review returns to discuss', (await record({ node: 'plan-review', findings: [] })).phase === 'discuss')

await run('gate-enter-plan')
await record({ node: 'plan', task: 'work' })
const needsDiscussion = await record({ node: 'plan-review', findings: [{ id: 'P1' }], requiresDiscussion: true, discussionReason: 'product choice' })
check('plan findings can require discussion', needsDiscussion.phase === 'discuss' && loadState(workspace, agent).blockReason === 'needs-user-decision')

await run('gate-enter-implement')
const implementationBlocked = await record({ node: 'implement', requiresDiscussion: true, discussionReason: 'contract choice' })
check('implement can return to discuss through gate_record', implementationBlocked.phase === 'discuss' && loadState(workspace, agent).blockReason === 'needs-user-decision')

await run('gate-enter-plan')
await record({ node: 'plan', task: 'work' })
for (let index = 0; index < 5; index += 1) {
  await record({ node: 'plan-review', findings: [{ id: `P${index}` }] })
  if (index < 4) await record({ node: 'plan-revise' })
}
check('plan review cap blocks', loadState(workspace, agent).work === 'blocked' && loadState(workspace, agent).blockReason === 'plan-review-rounds-exhausted')

await run('gate-enter-plan')
await record({ node: 'plan', task: 'work' })
await record({ node: 'plan-review', findings: [] })
check('clean plan review sets planReady', loadState(workspace, agent).planReady === true)

mkdirSync(path.join(workspace, 'artifacts'), { recursive: true })
writeFileSync(path.join(workspace, 'artifacts', 'verify.txt'), 'ok')

await run('gate-enter-implement')
check('implement command enters orchestrating', loadState(workspace, agent).phase === 'orchestrating' && loadState(workspace, agent).node === 'implement')
await record({ node: 'implement' })
check('implement moves to code review', loadState(workspace, agent).node === 'code-review')
check('empty code review moves to verify', (await record({ node: 'code-review', findings: [] })).node === 'verify')
const missingVerify = await record({ node: 'verify' })
check('verify without evidence is rejected', missingVerify.code === 'verification-required', JSON.stringify(missingVerify))
check('verify passes', (await record({ node: 'verify', verification: { commands: ['node tools/gate/test.mjs'], evidence: ['artifacts/verify.txt'], passed: true } })).phase === 'complete')

await run('gate-enter-implement')
await record({ node: 'implement' })
await record({ node: 'code-review', findings: [{ id: 'C1' }] })
check('code findings route to implement revise', loadState(workspace, agent).node === 'implement-revise')
await record({ node: 'implement-revise' })
await record({ node: 'code-review', findings: [] })
const failedVerify = await record({ node: 'verify', verification: { commands: ['node tools/gate/test.mjs'], evidence: ['artifacts/verify.txt'], passed: false } })
check('verify failure routes to revise', failedVerify.node === 'implement-revise')

await run('gate-return-discuss', '')
await run('gate-code-review', 'src/x.ts')
check('standalone code review enters reviewing', loadState(workspace, agent).phase === 'reviewing' && loadState(workspace, agent).node === 'review')
check('standalone review denies writes', (await exec('write', { file_path: 'src/x.ts' })).kind === 'deny')
check('standalone review ends in discuss', (await record({ node: 'review', findings: [] })).phase === 'discuss')

await run('gate-block', 'manual pause')
check('block freezes the gate', loadState(workspace, agent).phase === 'blocked' && loadState(workspace, agent).work === 'blocked')
check('block denies writes', (await exec('write', { file_path: 'docs/x.md' })).kind === 'deny')
await run('gate-resume', '')
check('resume returns to discuss', loadState(workspace, agent).phase === 'discuss' && loadState(workspace, agent).work === 'active')

const rootAgent = { id: 'root-session', session: { header: {} } }
const childAgent = { id: 'child-session', session: { header: {} } }
const workerHost = fakeHost(workspace, rootAgent)
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work' })
check('plan worker can write proposed notes', (await execWith(workerHost, childAgent, 'write', { file_path: '.agents/notes/proposed/feature/x.md' })).kind === 'allow')
check('plan worker cannot write code', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'deny')
check('main agent still cannot write in orchestrating', (await execWith(workerHost, rootAgent, 'write', { file_path: 'docs/x.md' })).kind === 'deny')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work' })
check('implement worker can write code', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'allow')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'code-review', task: 'work' })
check('review worker cannot write', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'deny')

const initWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-init-'))
const initHost = fakeHost(initWorkspace)
const initAgent = { id: 'session-init', session: { header: {} } }
const initialized = await initHost.commands['gate-init'].handler({ agent: initAgent, rawInput: '', attachments: [] })
check('gate-init creates the marker and stays in discuss',
  initialized.kind === 'success'
  && existsSync(path.join(initWorkspace, '.agents', 'gate.json'))
  && loadState(initWorkspace, initAgent).phase === 'discuss')
const noMarkerWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-no-marker-'))
const noMarkerHost = fakeHost(noMarkerWorkspace)
const noMarker = await noMarkerHost.commands['gate-enter-plan'].handler({ agent: initAgent, rawInput: 'anything', attachments: [] })
check('gate command does not auto-initialize', noMarker.kind === 'error' && !existsSync(path.join(noMarkerWorkspace, '.agents', 'gate.json')))

const missing = mkdtempSync(path.join(os.tmpdir(), 'gate-missing-'))
mkdirSync(path.join(missing, '.agents'), { recursive: true })
writeFileSync(path.join(missing, '.agents', 'gate.json'), JSON.stringify({ enabled: true, version: 2 }))
const missingHost = fakeHost(missing)
const missingAgent = { id: 'session-missing', session: { header: {} } }
const plannedWithoutNote = await missingHost.commands['gate-enter-plan'].handler({ agent: missingAgent, rawInput: 'new-work', attachments: [] })
check('plan can start a new work item without a note', plannedWithoutNote.kind === 'success' && loadState(missing, missingAgent).phase === 'orchestrating')
await missingHost.commands['gate-return-discuss'].handler({ agent: missingAgent, rawInput: '', attachments: [] })
const rejected = await missingHost.commands['gate-enter-implement'].handler({ agent: missingAgent, rawInput: 'new-work', attachments: [] })
check('implement without a note is rejected', rejected.kind === 'error' && loadState(missing, missingAgent).phase === 'discuss')

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
