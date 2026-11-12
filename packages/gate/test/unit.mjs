// Core checks for the P0 gate: state, docs, commands, gate_record, workers, write surface.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, Config, DISCUSS_ORCHESTRATION, GATE_RECORD_NODES, NODE_METHODS, WORKER_NODES } from '../index.js'
import { loadState, saveState, defaultState } from '../src/state.js'

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`ok   ${name}`)
  else { failures += 1; console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

function fakeProjection() {
  const definitions = new Map()
  const cells = new WeakMap()
  const handle = {
    stateOf(session) {
      const definition = [...definitions.values()][0]
      if (definition === undefined) throw new Error('projection not registered')
      if (!cells.has(session)) cells.set(session, definition.init())
      return cells.get(session)
    },
  }
  return {
    register(definition) {
      definitions.set(definition.key, definition)
      return handle
    },
    apply(session, event) {
      const definition = [...definitions.values()][0]
      if (definition === undefined) throw new Error('projection not registered')
      const state = cells.get(session) ?? definition.init()
      cells.set(session, definition.apply(state, event))
    },
    stateOf(session) { return handle.stateOf(session) },
  }
}

function fakeHost(workspace, rootSession, options = {}) {
  const commands = {}
  const tools = {}
  const handlers = {}
  const sections = []
  const ctx = {
    on: (name, handler) => { handlers[name] = handler },
    inject: (_deps, callback) => callback(ctx),
    get: name => {
      if (name === 'sandboxPolicy') return { workspaceRoot: workspace, resolve: () => ({ workspaceRoot: workspace }) }
      if (name === 'sessionProjections' && options.projection !== undefined) return options.projection
      if (name === 'subagents' && options.subagents !== undefined) return options.subagents
      if (name === 'subagents') {
        return {
          rootOf: () => rootSession,
          listDescendants: async () => [{ kind: 'child', id: 'worker-test', activity: 'inactive', parentId: rootSession?.id ?? 'root-test', depth: 1 }],
        }
      }
      if (name === 'workingDirectory' && options.cwd !== undefined) return { get: () => options.cwd }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: [{ type: 'tool/result', data: { message: { toolCallId: 'tool-result-1' } } }] }) }
      if (name === 'tools') return ctx.tools
      return undefined
    },
    sessionProjections: options.projection,
    systemPrompt: { section: definition => sections.push(definition), getSectionOrder: () => 500 },
    commands: { register: definition => { commands[definition.name] = definition } },
    tools: {
      register: definition => { tools[definition.name] = definition },
      guard: guard => { handlers['tools/guard'] = guard },
      get: name => tools[name],
    },
  }
  apply(ctx, options.config)
  return { commands, tools, handlers, sections, projection: options.projection }
}

function addGate() {}

function addNotesSkill(workspace) {
  const dir = path.join(workspace, '.agents', 'skills', 'write-agent-notes')
  mkdirSync(path.join(dir, 'templates'), { recursive: true })
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: write-agent-notes\ndescription: Fixture note skill\n---\n# Notes\n')
  writeFileSync(path.join(dir, 'templates', 'proposed.md'), '# Agent Note\n')
}

function makeWorkspace(options = {}) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'gate-core-'))
  addGate(workspace)
  if (options.notes !== false) addNotesSkill(workspace)
  for (const lifecycle of ['proposed', 'implemented', 'rejected', 'archived']) {
    mkdirSync(path.join(workspace, '.agents', 'notes', lifecycle, 'feature'), { recursive: true })
    writeFileSync(path.join(workspace, '.agents', 'notes', lifecycle, '.gitkeep'), '')
  }
  if (options.note !== false) {
    writeFileSync(path.join(workspace, '.agents', 'notes', 'proposed', 'feature', '2026-11-07-work.md'), '# Agent Note: work\n\nStatus: proposed\n\n## Problem\n\np\n\n## Proposal\n\nx\n\n## Alternatives considered\n\n- a\n\n## Acceptance criteria\n\n- c\n\n## Risks\n\n- r\n')
  }
  return workspace
}

let testNoteSequence = 0
function addTestNote(target) {
  testNoteSequence += 1
  const name = `2026-11-07-work-${testNoteSequence}.md`
  const absolute = path.join(target, '.agents', 'notes', 'proposed', 'feature', name)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, `# Agent Note: work ${testNoteSequence}\n\nStatus: proposed\n\n## Problem\n\np\n\n## Proposal\n\nx\n\n## Alternatives considered\n\n- a\n\n## Acceptance criteria\n\n- c\n\n## Risks\n\n- r\n`)
  return `.agents/notes/proposed/feature/${name}`
}

const workspace = makeWorkspace()
const host = fakeHost(workspace)
const agent = { id: 'session-test', session: { header: {} } }
const execWith = (target, targetAgent, name, args) => {
  const reason = target.handlers['tools/guard']?.({ name, arguments: args, agent: targetAgent, signal: new AbortController().signal })
  return Promise.resolve(reason === undefined || reason === null ? { kind: 'allow' } : { kind: 'deny', reason })
}
const exec = (name, args) => execWith(host, agent, name, args)
const run = (name, input) => host.commands[name].handler({ agent, rawInput: input, attachments: [] })
const record = async args => {
  let withWorkers = WORKER_NODES.has(args.node) && args.workerSessionIds === undefined
    ? { ...args, workerSessionIds: ['worker-test'] }
    : args
  if (args.node === 'plan' && args.noteDecision === undefined) {
    const notePath = addTestNote(workspace)
    withWorkers = { ...withWorkers, noteDecision: 'new', noteSearch: 'test search', notePaths: [{ path: notePath, class: 'feature', lifecycle: 'proposed' }] }
  }
  const withAxes = ['plan-review', 'proposal-review', 'code-review', 'code-review-standalone'].includes(args.node) && withWorkers.reviewAxes === undefined
    ? { ...withWorkers, reviewAxes: { standards: { findings: [] }, spec: { findings: [] }, ...(args.node === 'plan-review' || args.node === 'proposal-review' ? { architecture: { findings: [] } } : {}) } }
    : withWorkers
  const withToolResults = (args.node === 'verify' || args.node === 'verify-standalone') && withAxes.verification !== undefined && withAxes.verification.toolResults === undefined
    ? { ...withAxes, verification: { ...withAxes.verification, toolResults: ['tool-result-1'] } }
    : withAxes
  let result = await host.tools.gate_record.execute(withToolResults, { agent, signal: new AbortController().signal })
  if (args.node === 'verify' && result.ok === true && result.state?.node === 'note-lifecycle') {
    await host.tools.gate_note_finalize.execute({}, { agent })
    await host.tools.gate_note_verify.execute({}, { agent })
    result = await host.tools.gate_record.execute({ node: 'note-lifecycle' }, { agent })
  }
  return result
}
const stateOf = (target = workspace, targetAgent = agent) => loadState(target, targetAgent)

check('docs command registered', typeof host.commands['gate-docs']?.handler === 'function')
check('status command registered', typeof host.commands['gate-status']?.handler === 'function')
check('note archive command registered', typeof host.commands['gate-note-archive']?.handler === 'function')
check('note board command registered', typeof host.commands['gate-note-board']?.handler === 'function')
check('gate-fix-bug command registered', typeof host.commands['gate-fix-bug']?.handler === 'function')
check('gate tools declare output schema and render', Object.values(host.tools).every(tool => tool?.output?.schema !== undefined && typeof tool.output.render === 'function'))
check('discuss denies code', (await exec('write', { file_path: 'src/x.ts' })).kind === 'deny')
check('discuss denies docs', (await exec('write', { file_path: 'docs/x.md' })).kind === 'deny')
await run('gate-docs', 'docs/')
check('docs command enters docs', stateOf().phase === 'docs')
check('docs phase allows docs', (await exec('write', { file_path: 'docs/x.md' })).kind === 'allow')
check('docs phase allows code writes (no content classification)', (await exec('write', { file_path: 'src/x.ts' })).kind === 'allow')
check('docs phase can end through gate_record', (await record({ node: 'docs' })).phase === 'discuss')
check('docs gate_record leaves docs', stateOf().phase === 'discuss')
await run('gate-return-discuss')
check('return enters discuss', stateOf().phase === 'discuss')
const status = await run('gate-status', '')
check('status is factual', status.text.includes('状态：discuss') && status.text.includes('blockReason：无') && !status.text.includes('下一步'))
const statusTool = await host.tools.gate_status.execute({}, { agent })
check('gate_status tool is registered and includes /gate-status state', statusTool.ok === true && statusTool.text.startsWith('当前 phase/node') && statusTool.text.includes('状态：discuss') && statusTool.procedure?.phase === 'discuss')
const statusStateBefore = stateOf()
await host.tools.gate_status.execute({}, { agent })
check('gate_status is read-only', JSON.stringify(stateOf()) === JSON.stringify(statusStateBefore))
check('NODE_METHODS covers the gate_record node enum',
  GATE_RECORD_NODES.every(node => Object.hasOwn(NODE_METHODS, node))
  && Object.keys(NODE_METHODS).every(node => GATE_RECORD_NODES.includes(node))
  && NODE_METHODS.docs === '无')
let statusAppends = 0
const appendAgent = { id: 'status-append', session: { header: {}, append: () => { statusAppends += 1 } } }
const appendHost = fakeHost(workspace, appendAgent)
const appendStatus = await appendHost.tools.gate_status.execute({}, { agent: appendAgent })
check('gate_status appends no session events', appendStatus.ok === true && statusAppends === 0)
saveState(workspace, agent, { ...defaultState(), phase: 'orchestrating', node: 'plan-review', task: 'x', work: 'active', noteDecision: 'new', notePaths: [{ path: '.agents/notes/proposed/feature/x.md', class: 'feature', lifecycle: 'proposed' }], exhausted: { plan: true, code: false }, verification: { passed: true, selfReported: false } })
const richStatus = await host.tools.gate_status.execute({}, { agent })
check('gate_status renders notes/exhausted/verify lines', richStatus.text.includes('notes：') && richStatus.text.includes('exhausted：') && richStatus.text.includes('verify：PASS'))
check('plan procedure carries review rounds without duplicating status rounds', richStatus.text.includes('## 当前轮次') && !richStatus.text.includes('rounds：'))
saveState(workspace, agent, defaultState())
const roundWorkspace = makeWorkspace()
const roundHost = fakeHost(roundWorkspace)
const roundAgent = { id: 'session-round', session: { header: {} } }
saveState(roundWorkspace, roundAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan-review', rounds: { planReview: 2, codeReview: 0 } })
check('status counts the current review round', (await roundHost.commands['gate-status'].handler({ agent: roundAgent, rawInput: '', attachments: [] })).text.includes('plan 3/5（当前）'))
check('discuss methodology remains the default phase', DISCUSS_ORCHESTRATION.includes('discuss 是默认阶段') && !DISCUSS_ORCHESTRATION.includes('/discuss'))
const gateSection = host.sections.find(section => section.name === 'gate:protocol')
const staticPrompt = gateSection.text({ agent })
check('root prompt is the static methodology',
  staticPrompt.startsWith('## Gate 方法论')
  && ['## discuss', '## plan', '## implement', '## code-review', '## verify', '## note-lifecycle', '## fix-bug', '## docs', '## reviewing-code', '## reviewing-proposal', '## reviewing-verify', '## blocked / complete'].every(heading => staticPrompt.includes(heading))
  && !/^\d+\./mu.test(staticPrompt)
  && !staticPrompt.includes('状态：')
  && !staticPrompt.includes('rounds：')
  && !staticPrompt.includes('planReady')
  && !staticPrompt.includes('reviewAxes')
  && !staticPrompt.includes('workerSessionIds')
  && !staticPrompt.includes('notePaths')
  && !staticPrompt.includes('noteDecision')
  && !staticPrompt.includes('gate_record({'))
const variantCases = [
  ['plan', { phase: 'orchestrating', node: 'plan', task: 'x', work: 'active' }, '## Step 1', '## Step 2'],
  ['plan-review', { phase: 'orchestrating', node: 'plan-review', task: 'x', work: 'active' }, '## Step 2', '## Step 1'],
  ['plan-revise', { phase: 'orchestrating', node: 'plan-revise', task: 'x', work: 'active' }, '## Plan revise', '## Step 1'],
  ['implement', { phase: 'orchestrating', node: 'implement', task: 'x', work: 'active' }, '## Step 1', '## Step 2'],
  ['code-review', { phase: 'orchestrating', node: 'code-review', task: 'x', work: 'active' }, '## Step 2', '## Step 1'],
  ['implement-revise', { phase: 'orchestrating', node: 'implement-revise', task: 'x', work: 'active' }, '## Implement revise', '## Step 1'],
  ['verify', { phase: 'orchestrating', node: 'verify', task: 'x', work: 'active' }, '## Step 3', '## Step 1'],
  ['note-lifecycle', { phase: 'orchestrating', node: 'note-lifecycle', task: 'x', work: 'active' }, 'gate_note_finalize', '## Step 1'],
  ['docs', { phase: 'docs', task: 'docs', work: 'active' }, 'gate_record({node:\'docs\'})', '## Step 1'],
  ['fix-bug', { phase: 'orchestrating', node: 'fix-bug', task: 'x', work: 'active' }, '## /gate-fix-bug 编排', '## Plan revise'],
  ['reviewing-code', { phase: 'reviewing', node: 'code-review-standalone', task: 'x', work: 'active' }, 'gate-code-review', '## Step 1'],
  ['reviewing-proposal', { phase: 'reviewing', node: 'proposal-review', task: 'x', work: 'active' }, 'gate-plan-review', '## Step 1'],
  ['reviewing-verify', { phase: 'reviewing', node: 'verify-standalone', task: 'x', work: 'active' }, 'gate-user-verify', '## Step 1'],
  ['blocked', { phase: 'blocked', node: null, work: 'blocked', blockReason: 'x' }, 'Gate 已冻结', '## Step 1'],
  ['complete', { phase: 'complete', node: null, work: 'active' }, 'Gate 已完成', '## Step 1'],
]
const variantChecks = []
for (const [label, state, marker, forbidden] of variantCases) {
  saveState(workspace, agent, { ...defaultState(), ...state })
  const statusResult = await host.tools.gate_status.execute({}, { agent })
  variantChecks.push([label, gateSection.text({ agent }) === staticPrompt, statusResult.ok === true && statusResult.procedure?.text.includes(marker) && !statusResult.procedure?.text.includes(forbidden)])
}
check('root prompt is byte-stable across variants; procedures match the state', variantChecks.every(([, stable, procedure]) => stable && procedure), JSON.stringify(variantChecks))
saveState(workspace, agent, { ...defaultState(), phase: 'orchestrating', node: 'plan-review', task: 'another task', work: 'active', rounds: { planReview: 3, codeReview: 2 }, noteDecision: 'new', notePaths: [{ path: '.agents/notes/proposed/feature/x.md', class: 'feature', lifecycle: 'proposed' }], verification: { passed: true, selfReported: false } })
check('static prompt ignores task/rounds/notes/verification', gateSection.text({ agent }) === staticPrompt)
const limitedHost = fakeHost(workspace, undefined, { config: { reviewLimit: 2 } })
const limitedSection = limitedHost.sections.find(section => section.name === 'gate:protocol')
check('static prompt ignores reviewLimit', limitedSection.text({ agent }) === staticPrompt)
saveState(workspace, agent, defaultState())
check('discuss denies worker dispatch', (await exec('subagent', { description: 'x', prompt: 'x' })).kind === 'deny')
check('discuss denies apply_patch', (await exec('apply_patch', { input: '*** Begin Patch\n*** Add File: src/x.ts\n+x\n*** End Patch' })).kind === 'deny')

const withoutPlan = await run('gate-enter-implement')
check('implement without a brief is rejected', withoutPlan.kind === 'error' && withoutPlan.text.includes('一句话'))

const followupWorkspace = makeWorkspace()
let followupText = ''
const followupAgent = { id: 'session-followup', session: { header: {} }, followup: message => { followupText = message.content?.[0]?.text ?? '' } }
const followupHost = fakeHost(followupWorkspace, followupAgent)
await followupHost.commands['gate-enter-plan'].handler({ agent: followupAgent, rawInput: 'do it', attachments: [] })
check('command follow-up includes the current procedure', followupText.startsWith('当前 phase/node：orchestrating / plan') && followupText.includes('## Step 1') && followupText.includes('## 派发规则'))

const directWorkspace = makeWorkspace()
const directHost = fakeHost(directWorkspace)
const directAgent = { id: 'session-direct', session: { header: {} } }
const directEnter = await directHost.commands['gate-enter-implement'].handler({ agent: directAgent, rawInput: '把日志级别改成 info', attachments: [] })
check('implement accepts a simple brief without planning', directEnter.kind === 'success' && loadState(directWorkspace, directAgent).node === 'implement' && loadState(directWorkspace, directAgent).task === '把日志级别改成 info')

const startWorkspace = makeWorkspace()
const startHost = fakeHost(startWorkspace)
const startAgent = { id: 'session-start', session: { header: {} } }
const startedPlan = await startHost.tools.gate_start_phase.execute({ node: 'plan' }, { agent: startAgent })
check('gate_start_phase starts planning after authorization', startedPlan.ok === true && startedPlan.node === 'plan' && startedPlan.procedure?.node === 'plan')
const startImplSurface = makeWorkspace()
const startImplHost = fakeHost(startImplSurface)
const startImplAgent = { id: 'session-start-impl', session: { header: {} } }
const startedImplement = await startImplHost.tools.gate_start_phase.execute({ node: 'implement', brief: '修一个错别字' }, { agent: startImplAgent })
check('gate_start_phase starts direct implement', startedImplement.ok === true && startedImplement.task === '修一个错别字' && startedImplement.procedure?.node === 'implement')

const losslessJson = (value, stack = new Set()) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object' || stack.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false
    stack.add(value)
    const ok = value.every(item => losslessJson(item, stack))
    stack.delete(value)
    return ok
  }
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return false
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return false
  stack.add(value)
  const ok = keys.every(key => losslessJson(value[key], stack))
  stack.delete(value)
  return ok
}
const nodeGuardWorkspace = makeWorkspace()
const nodeGuardHost = fakeHost(nodeGuardWorkspace)
const nodeGuardAgent = { id: 'session-node-guard', session: { header: {} } }
saveState(nodeGuardWorkspace, nodeGuardAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan-review', task: 'work', work: 'active' })
const missingNodeRecord = await nodeGuardHost.tools.gate_record.execute({}, { agent: nodeGuardAgent })
check('gate_record without node returns a lossless wrong-node error',
  missingNodeRecord.ok === false
  && missingNodeRecord.code === 'wrong-node'
  && missingNodeRecord.expected === 'plan-review'
  && missingNodeRecord.got === null
  && missingNodeRecord.reason.includes('未提供')
  && losslessJson(missingNodeRecord),
  JSON.stringify(missingNodeRecord))
saveState(nodeGuardWorkspace, nodeGuardAgent, defaultState())
const missingNodeStart = await nodeGuardHost.tools.gate_start_phase.execute({}, { agent: nodeGuardAgent })
const stateAfterMissingNodeStart = loadState(nodeGuardWorkspace, nodeGuardAgent)
check('gate_start_phase rejects a missing node without mutating state',
  missingNodeStart.ok === false
  && missingNodeStart.code === 'invalid-node'
  && stateAfterMissingNodeStart.phase === 'discuss'
  && stateAfterMissingNodeStart.node === null,
  JSON.stringify(missingNodeStart))
saveState(nodeGuardWorkspace, nodeGuardAgent, { ...defaultState(), phase: 'docs', task: 'docs', work: 'active' })
const missingNodeDocs = await nodeGuardHost.tools.gate_record.execute({}, { agent: nodeGuardAgent })
check('docs gate_record without node returns a lossless wrong-node error',
  missingNodeDocs.ok === false
  && missingNodeDocs.code === 'wrong-node'
  && missingNodeDocs.expected === 'docs'
  && missingNodeDocs.got === null
  && losslessJson(missingNodeDocs),
  JSON.stringify(missingNodeDocs))
saveState(nodeGuardWorkspace, nodeGuardAgent, defaultState())

const fixWorkspace = makeWorkspace()
const fixHost = fakeHost(fixWorkspace)
const fixAgent = { id: 'session-fix', session: { header: {} } }
const fixStarted = await fixHost.commands['gate-fix-bug'].handler({ agent: fixAgent, rawInput: '修复空指针', attachments: [] })
check('gate-fix-bug enters fix node', fixStarted.kind === 'success' && loadState(fixWorkspace, fixAgent).node === 'fix-bug')
const fixDone = await fixHost.tools.gate_record.execute({ node: 'fix-bug', workerSessionIds: ['worker-test'] }, { agent: fixAgent })
check('fix-bug returns to discuss', fixDone.ok === true && fixDone.phase === 'discuss')

await run('gate-enter-plan')
check('plan command enters orchestrating', stateOf().phase === 'orchestrating' && stateOf().node === 'plan')
const noWorker = await record({ node: 'plan', task: 'work', workerSessionIds: [] })
check('worker-required blocks gate_record', noWorker.ok === false && noWorker.code === 'worker-required')
const ghostWorker = await record({ node: 'plan', task: 'work', workerSessionIds: ['ghost'] })
check('worker-not-descendant blocks gate_record', ghostWorker.ok === false && ghostWorker.code === 'worker-not-descendant')
const noTask = await record({ node: 'plan' })
check('plan record requires task', noTask.ok === false && noTask.code === 'task-required')
const planStart = await record({ node: 'plan', task: 'work' })
check('plan review can start', planStart.ok === true && stateOf().node === 'plan-review')
check('plan record returns the plan-review procedure', planStart.procedure?.node === 'plan-review' && planStart.procedure?.method.includes('gate-plan-review'))
const noAxes = await host.tools.gate_record.execute({ node: 'plan-review', findings: [], workerSessionIds: ['worker-test'] }, { agent, signal: new AbortController().signal })
check('review requires standards and spec axes', noAxes.ok === false && noAxes.code === 'review-axes-required')
const noArchitecture = await host.tools.gate_record.execute({ node: 'plan-review', findings: [], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] } } }, { agent, signal: new AbortController().signal })
check('plan review requires architecture axis', noArchitecture.ok === false && noArchitecture.code === 'review-axes-required')
check('empty plan review returns to discuss', (await record({ node: 'plan-review', findings: [] })).phase === 'discuss')
check('clean plan review sets planReady', stateOf().planReady === true)

await run('gate-enter-implement')
check('implement command enters orchestrating', stateOf().phase === 'orchestrating' && stateOf().node === 'implement')
const implementRecord = await record({ node: 'implement' })
check('implement moves to code review', stateOf().node === 'code-review')
check('implement record returns the code-review procedure', implementRecord.procedure?.node === 'code-review' && implementRecord.procedure?.method.includes('gate-code-review'))
check('empty code review moves to verify', (await record({ node: 'code-review', findings: [] })).node === 'verify')
const missingVerify = await record({ node: 'verify' })
check('verify without evidence is rejected', missingVerify.code === 'verification-required', JSON.stringify(missingVerify))
check('verify failure returns the current procedure', missingVerify.procedure?.node === 'verify' && missingVerify.procedure?.text.includes('gate_record({node:\'verify\''))
mkdirSync(path.join(workspace, 'artifacts'), { recursive: true })
writeFileSync(path.join(workspace, 'artifacts', 'verify.txt'), 'ok')
const missingFile = await record({ node: 'verify', verification: { commands: ['x'], evidence: ['artifacts/missing.txt'], passed: true } })
check('verify rejects nonexistent evidence', missingFile.code === 'verification-required')
const directoryEvidence = await record({ node: 'verify', verification: { commands: ['x'], evidence: ['artifacts'], passed: true } })
check('verify rejects a directory as evidence', directoryEvidence.code === 'verification-required')
const outsideEvidence = await record({ node: 'verify', verification: { commands: ['x'], evidence: ['../outside.txt'], passed: true } })
check('verify rejects evidence outside the workspace', outsideEvidence.code === 'verification-required')
const noToolResults = await host.tools.gate_record.execute({ node: 'verify', workerSessionIds: ['worker-test'], verification: { commands: ['x'], evidence: ['artifacts/verify.txt'], passed: true } }, { agent, signal: new AbortController().signal })
check('verify requires toolResults', noToolResults.code === 'verification-required')
const unboundToolResult = await record({ node: 'verify', verification: { commands: ['x'], evidence: ['artifacts/verify.txt'], toolResults: ['ghost'], passed: true } })
check('verify rejects unbound toolResults', unboundToolResult.code === 'verification-required')
const verified = await record({ node: 'verify', verification: { commands: ['node packages/gate/test/unit.mjs'], evidence: ['artifacts/verify.txt'], passed: true } })
check('verify passes back to discuss', verified.phase === 'discuss', JSON.stringify(verified))
check('verify records execution-bound evidence hash', stateOf().verification?.executionBound === true && stateOf().verification?.selfReported === false && /^[a-f0-9]{64}$/u.test(stateOf().verification?.evidence?.[0]?.sha256 ?? ''))
check('status shows verify evidence', (await run('gate-status', '')).text.includes('verify：PASS（verified）'))

saveState(workspace, agent, { ...stateOf(), planReady: true, task: 'work' })
await run('gate-enter-implement', 'work')
await record({ node: 'implement' })
await record({ node: 'code-review', findings: [{ id: 'C1' }] })
check('code findings route to implement revise', stateOf().node === 'implement-revise')
await record({ node: 'implement-revise' })
await record({ node: 'code-review', findings: [] })
const failedVerify = await record({ node: 'verify', verification: { commands: ['node packages/gate/test/unit.mjs'], evidence: ['artifacts/verify.txt'], passed: false } })
check('verify failure routes to revise', failedVerify.node === 'implement-revise')

saveState(workspace, agent, { ...defaultState(), phase: 'orchestrating', node: 'code-review', task: 'work', planReady: true, rounds: { planReview: 1, codeReview: 2 } })
const codeBlocked = await record({ node: 'code-review', findings: [{ id: 'D1' }], requiresDiscussion: true })
check('code review can require discussion', codeBlocked.phase === 'blocked')
await run('gate-resume')
check('resume returns to code review', stateOf().phase === 'orchestrating' && stateOf().node === 'code-review' && stateOf().rounds.codeReview === 2)
await run('gate-return-discuss')

await run('gate-enter-plan')
await record({ node: 'plan', task: 'work' })
await record({ node: 'plan-review', findings: [{ id: 'P1' }] })
check('plan findings route to plan revise', stateOf().node === 'plan-revise')
await record({ node: 'plan-revise' })
check('plan revise returns to review', stateOf().node === 'plan-review')
check('clean plan review after revise', (await record({ node: 'plan-review', findings: [] })).phase === 'discuss')
check('plan review sets planReady again', stateOf().planReady === true)

await run('gate-enter-plan')
await record({ node: 'plan', task: 'work' })
const planBlocked = await record({ node: 'plan-review', findings: [{ id: 'P1' }], requiresDiscussion: true, discussionReason: 'product choice' })
check('plan findings can require discussion', planBlocked.phase === 'blocked' && stateOf().blockReason === 'needs-user-decision')
check('blocked plan cannot enter implement', (await run('gate-enter-implement')).kind === 'error')
await run('gate-resume')
check('resume returns to plan review', stateOf().phase === 'orchestrating' && stateOf().node === 'plan-review')
check('needs-decision plan is not ready', (await run('gate-enter-implement')).kind === 'error')
await run('gate-return-discuss')

await run('gate-enter-plan')
await record({ node: 'plan', task: 'work' })
await record({ node: 'plan-review', findings: [] })
await run('gate-enter-implement')
const implementationBlocked = await record({ node: 'implement', requiresDiscussion: true, discussionReason: 'contract choice' })
check('implement can return to blocked discussion', implementationBlocked.phase === 'blocked' && stateOf().blockReason === 'needs-user-decision')
await run('gate-resume')
check('resume returns to implement', stateOf().phase === 'orchestrating' && stateOf().node === 'implement')
await run('gate-return-discuss')

await run('gate-enter-plan')
await record({ node: 'plan', task: 'work' })
for (let index = 0; index < 5; index += 1) {
  await record({ node: 'plan-review', findings: [{ id: `P${index}` }] })
  if (index < 4) await record({ node: 'plan-revise' })
}
check('plan review cap blocks', stateOf().phase === 'blocked' && stateOf().exhausted.plan === true && stateOf().blockReason === 'plan-review-rounds-exhausted')
await run('gate-resume')
check('resume after plan cap stays in discuss', stateOf().phase === 'discuss')
const exhaustedState = { ...stateOf(), task: 'work', planReady: true }
saveState(workspace, agent, exhaustedState)
check('exhausted plan cannot enter implement', (await run('gate-enter-implement')).kind === 'error')
check('new plan resets exhaustion', (await run('gate-enter-plan')).kind === 'success' && stateOf().exhausted.plan === false)
await run('gate-return-discuss')

await run('gate-implement-review', 'src/x.ts')
check('standalone code review enters reviewing', stateOf().phase === 'reviewing' && stateOf().node === 'code-review-standalone')
check('standalone review denies writes', (await exec('write', { file_path: 'src/x.ts' })).kind === 'deny')
check('standalone review ends in discuss', (await record({ node: 'code-review-standalone', findings: [] })).phase === 'discuss')
await run('gate-implement-review', '')
check('code review works without an explicit work item', stateOf().phase === 'reviewing' && typeof stateOf().task === 'string' && stateOf().task.length > 0)
await run('gate-return-discuss')
check('return-discuss clears the work item', stateOf().task === null && stateOf().planReady === false)

await run('gate-propose-review', 'note.md')
check('proposal review enters reviewing with three axes', stateOf().phase === 'reviewing' && stateOf().node === 'proposal-review')
check('proposal review ends in discuss', (await record({ node: 'proposal-review', findings: [] })).phase === 'discuss')

await run('gate-code-verify', 'src/x.ts')
check('standalone code verify enters reviewing', stateOf().phase === 'reviewing' && stateOf().node === 'verify-standalone')
check('standalone code verify ends in discuss', (await record({ node: 'verify-standalone', verification: { commands: ['node test'], evidence: ['artifacts/verify.txt'], passed: true } })).phase === 'discuss')

await run('gate-block', 'manual pause')
check('block freezes the gate', stateOf().phase === 'blocked' && stateOf().work === 'blocked')
check('block denies writes', (await exec('write', { file_path: 'docs/x.md' })).kind === 'deny')
await run('gate-resume')
check('resume returns to discuss after manual block', stateOf().phase === 'discuss' && stateOf().work === 'active')

const pauseWorkspace = makeWorkspace()
const pauseHost = fakeHost(pauseWorkspace)
const pauseAgent = { id: 'session-pause', session: { header: {} } }
saveState(pauseWorkspace, pauseAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work' })
await pauseHost.commands['gate-block'].handler({ agent: pauseAgent, rawInput: 'pause', attachments: [] })
const pausedStatus = await pauseHost.commands['gate-status'].handler({ agent: pauseAgent, rawInput: '', attachments: [] })
check('blocked status shows resume target', pausedStatus.text.includes('解冻后：orchestrating / implement'))
await pauseHost.commands['gate-resume'].handler({ agent: pauseAgent, rawInput: '', attachments: [] })
check('manual block resumes the original node', loadState(pauseWorkspace, pauseAgent).phase === 'orchestrating' && loadState(pauseWorkspace, pauseAgent).node === 'implement')

const sandboxModes = []
const sandboxAgent = { id: 'sandbox-session', session: { header: {}, append: (type, data) => { if (type === 'sandbox/mode') sandboxModes.push(data.mode) } } }
const sandboxHost = fakeHost(workspace)
await sandboxHost.commands['gate-enter-plan'].handler({ agent: sandboxAgent, rawInput: '', attachments: [] })
check('sandbox switches to workspace-write for planning', sandboxModes.at(-1) === 'workspace-write')
await sandboxHost.commands['gate-block'].handler({ agent: sandboxAgent, rawInput: 'pause', attachments: [] })
check('sandbox switches to read-only when blocked', sandboxModes.at(-1) === 'read-only')
await sandboxHost.commands['gate-resume'].handler({ agent: sandboxAgent, rawInput: '', attachments: [] })
check('sandbox restores workspace-write on resume to plan', sandboxModes.at(-1) === 'workspace-write')
await sandboxHost.commands['gate-return-discuss'].handler({ agent: sandboxAgent, rawInput: '', attachments: [] })
check('sandbox returns to read-only in discuss', sandboxModes.at(-1) === 'read-only')
await sandboxHost.commands['gate-docs'].handler({ agent: sandboxAgent, rawInput: 'docs/', attachments: [] })
check('sandbox switches to workspace-write for docs', sandboxModes.at(-1) === 'workspace-write')

const wakeMessages = []
const wakeAgent = { id: 'wake-session', session: { header: {} }, followup: message => wakeMessages.push(message) }
const wakeHost = fakeHost(makeWorkspace())
await wakeHost.commands['gate-enter-plan'].handler({ agent: wakeAgent, rawInput: '', attachments: [] })
await new Promise(resolve => setTimeout(resolve, 5))
check('gate-enter-plan wakes the agent for orchestration', wakeMessages.length === 1 && wakeMessages[0].content?.[0]?.text?.includes('Gate 已进入 plan') && wakeMessages[0].source?.kind === 'gate-command' && wakeMessages[0].source?.command === 'gate-enter-plan')
const planWakeText = wakeMessages[0].content?.[0]?.text ?? ''
check('plan wake carries the brief', planWakeText.includes('用户规划输入'))

const quietMessages = []
const quietAgent = { id: 'quiet-session', session: { header: {} }, followup: message => quietMessages.push(message) }
const quietHost = fakeHost(makeWorkspace())
await quietHost.commands['gate-return-discuss'].handler({ agent: quietAgent, rawInput: '', attachments: [] })
check('gate-return-discuss does not wake the agent', quietMessages.length === 0)
const wakeInitMessages = []
const wakeInitAgent = { id: 'wake-init-session', session: { header: {} }, followup: message => wakeInitMessages.push(message) }
const wakeInitWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-init-wake-'))
const wakeInitHost = fakeHost(wakeInitWorkspace)
await wakeInitHost.commands['gate-init'].handler({ agent: wakeInitAgent, rawInput: '', attachments: [] })
check('gate-init wakes with initialization feedback', wakeInitMessages.length === 1 && wakeInitMessages[0].content?.[0]?.text?.includes('phase=discuss') && !wakeInitMessages[0].content?.[0]?.text?.includes('/gate-enter-plan') && wakeInitMessages[0].source?.command === 'gate-init' && !existsSync(path.join(wakeInitWorkspace, '.agents', 'gate.json')))
await wakeInitHost.commands['gate-init'].handler({ agent: wakeInitAgent, rawInput: '', attachments: [] })
check('gate-init wakes again when already initialized', wakeInitMessages.length === 2 && wakeInitMessages[1].content?.[0]?.text?.includes('Gate 已初始化') && wakeInitMessages[1].source?.command === 'gate-init')

const implementWakeMessages = []
const implementWakeAgent = { id: 'wake-implement-session', session: { header: {} }, followup: message => implementWakeMessages.push(message) }
const implementWakeWorkspace = makeWorkspace()
const implementWakeHost = fakeHost(implementWakeWorkspace)
saveState(implementWakeWorkspace, implementWakeAgent, { ...defaultState(), phase: 'discuss', task: 'work', planReady: true, noteDecision: 'new', notePaths: [{ path: addTestNote(implementWakeWorkspace), class: 'feature', lifecycle: 'proposed' }] })
await implementWakeHost.commands['gate-enter-implement'].handler({ agent: implementWakeAgent, rawInput: '', attachments: [] })
const implementWakeText = implementWakeMessages[0]?.content?.[0]?.text ?? ''
check('implement wake carries the task', implementWakeText.includes('Gate 已进入 implement'))

const restrictionCalls = []
let restrictionDisposals = 0
const restrictedAgent = {
  id: 'restricted-session',
  session: { header: {} },
  ctx: { tools: { restrict: filter => { restrictionCalls.push(filter); return () => { restrictionDisposals += 1 } } } },
}
const restrictedHost = fakeHost(workspace)
await restrictedHost.handlers['agent/pre-step']({ agent: restrictedAgent }, async () => ({ kind: 'allow' }))
check('discuss restriction denies writes', restrictionCalls.at(-1)?.deny?.includes('write') === true && restrictionCalls.at(-1)?.deny?.includes('subagent') !== true)
saveState(workspace, restrictedAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan' })
await restrictedHost.handlers['agent/pre-step']({ agent: restrictedAgent }, async () => ({ kind: 'allow' }))
check('restriction disposes the previous filter', restrictionDisposals > 0)
saveState(workspace, restrictedAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', work: 'active' })
const implementWorker = {
  id: 'restricted-worker',
  session: { header: { cwd: workspace } },
  ctx: { tools: { restrict: filter => { restrictionCalls.push(filter); return () => { restrictionDisposals += 1 } } } },
}
const workerRestrictionHost = fakeHost(workspace, restrictedAgent)
const restrictionCountBeforeWorker = restrictionCalls.length
await workerRestrictionHost.handlers['agent/pre-step']({ agent: implementWorker }, async () => ({ kind: 'allow' }))
check('implement worker has no tool restriction', restrictionCalls.length === restrictionCountBeforeWorker)

saveState(workspace, agent, { ...defaultState(), phase: 'blocked', work: 'blocked', blockReason: 'fixture' })
check('docs cannot override blocked', (await run('gate-docs', 'docs/')).kind === 'error')
check('return-discuss cannot bypass blocked', (await run('gate-return-discuss')).kind === 'error')
saveState(workspace, agent, defaultState())

const rootAgent = { id: 'root-session', session: { header: {} } }
const childAgent = { id: 'child-session', session: { header: {} } }
const workerHost = fakeHost(workspace, rootAgent)
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work' })
const workerSection = workerHost.sections.find(section => section.name === 'gate:protocol')
const workerPrompt = workerSection.text({ agent: childAgent })
check('worker prompt uses root node', workerPrompt.includes('Gate worker') && workerPrompt.includes('gate_note_write') && !workerPrompt.includes('只读讨论') && !workerPrompt.includes('## 节点方法'))
check('worker prompt does not ask the worker to load methods', !workerPrompt.includes('## Method files') && workerPrompt.includes('主代理已经加载'))
const workerStatus = await workerHost.tools.gate_status.execute({}, { agent: childAgent })
check('gate_status reads root state for a worker but returns no root procedure', workerStatus.ok === true && workerStatus.text.includes('节点：plan') && workerStatus.procedure === null)
const workerCommandStatus = await workerHost.commands['gate-status'].handler({ agent: childAgent, rawInput: '', attachments: [] })
check('/gate-status matches gate_status for a worker', workerCommandStatus.text === workerStatus.text)
saveState(workspace, rootAgent, { ...defaultState(), phase: 'reviewing', node: 'verify-standalone', task: 'x', work: 'active' })
check('verify-standalone worker gets its method', workerSection.text({ agent: childAgent }).includes('gate-user-verify'))
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'fix-bug', task: 'x', work: 'active' })
check('fix-bug worker gets its process', workerSection.text({ agent: childAgent }).includes('Process 1-9'))
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work' })
const rootStatus = await workerHost.tools.gate_status.execute({}, { agent: rootAgent })
check('main prompt is static; the procedure names the current method', workerSection.text({ agent: rootAgent }) === staticPrompt && rootStatus.procedure?.text.includes('gate-planning') && rootStatus.method.includes('gate-planning'))
check('procedure requires a fresh skill load per dispatch', rootStatus.procedure.text.includes('## 派发规则') && rootStatus.procedure.text.includes('按当前 procedure 的 method 重新加载技能'))
check('plan worker generic write is denied', (await execWith(workerHost, childAgent, 'write', { file_path: '.agents/notes/proposed/feature/x.md' })).kind === 'deny')
const noteWrite = await workerHost.tools.gate_note_write.execute({ path: 'feature/2026-11-10-y.md', content: '# Note\n' }, { agent: childAgent })
check('plan worker can write a proposed note', noteWrite.ok === true)
const noteWritePrefixed = await workerHost.tools.gate_note_write.execute({ path: 'proposed/feature/2026-11-10-z.md', content: '# Note\n' }, { agent: childAgent })
check('proposed/ path prefix is accepted', noteWritePrefixed.ok === true && existsSync(path.join(workspace, '.agents', 'notes', 'proposed', 'feature', '2026-11-10-z.md')))
check('plan worker cannot write code', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'deny')
check('main agent can write in orchestrating', (await execWith(workerHost, rootAgent, 'write', { file_path: 'docs/x.md' })).kind === 'allow')
check('child cannot call gate_record', (await workerHost.tools.gate_record.execute({ node: 'plan', task: 'x' }, { agent: childAgent })).code === 'root-only')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work' })
check('implement worker can write code', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'allow')
check('implement worker can apply_patch code', (await execWith(workerHost, childAgent, 'apply_patch', { input: '*** Begin Patch\n*** Add File: src/y.ts\n+x\n*** End Patch' })).kind === 'allow')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'code-review', task: 'work' })
check('review worker cannot write', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'deny')
check('review worker cannot shell-write docs', (await execWith(workerHost, childAgent, 'pwsh', { command: 'Set-Content docs/x.md x' })).kind === 'deny')

saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work' })
check('plan worker apply_patch notes denied', (await execWith(workerHost, childAgent, 'apply_patch', { input: '*** Begin Patch\n*** Add File: .agents/notes/proposed/feature/y.md\n+x\n*** End Patch' })).kind === 'deny')
check('plan worker apply_patch code denied', (await execWith(workerHost, childAgent, 'apply_patch', { input: '*** Begin Patch\n*** Add File: src/z.ts\n+x\n*** End Patch' })).kind === 'deny')
check('plan worker cannot delete protected ancestor', (await execWith(workerHost, childAgent, 'pwsh', { command: 'Remove-Item -Recurse -Force .agents' })).kind === 'deny')
check('plan worker cannot rm the workspace root', (await execWith(workerHost, childAgent, 'pwsh', { command: 'rm -rf .' })).kind === 'deny')
check('plan worker cannot git clean', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git clean -fdx' })).kind === 'deny')
check('plan worker cannot write docs by shell', (await execWith(workerHost, childAgent, 'pwsh', { command: 'Set-Content docs/x.md x' })).kind === 'deny')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work' })
check('implement worker can git clean', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git clean -fdx' })).kind === 'allow')

const fallbackHost = fakeHost(workspace, undefined, { subagents: { rootOf: () => { throw new Error('no runtime owner') } } })
const fallbackChild = { id: 'fallback-child', session: { header: { origin: 'subagent', parentSession: rootAgent.id } } }
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work' })
const fallbackPrompt = fallbackHost.sections.find(section => section.name === 'gate:protocol').text({ agent: fallbackChild })
check('worker prompt falls back to durable parent lineage', fallbackPrompt.includes('Gate worker') && fallbackPrompt.includes('gate_note_write') && !fallbackPrompt.includes('## 节点方法'))
check('fallback child cannot call gate_record', (await fallbackHost.tools.gate_record.execute({ node: 'plan', task: 'x' }, { agent: fallbackChild })).code === 'root-only')
const fallbackStatus = await fallbackHost.tools.gate_status.execute({}, { agent: fallbackChild })
check('gate_status rejects a synthetic root without a session', fallbackStatus.ok === false && fallbackStatus.code === 'root-unresolved')
const orphanHost = fakeHost(workspace, undefined, { subagents: { rootOf: () => { throw new Error('no owner') } } })
const orphanAgent = { id: 'orphan-worker', session: { header: { origin: 'subagent' } } }
const orphanStatus = await orphanHost.tools.gate_status.execute({}, { agent: orphanAgent })
check('gate_status rejects an orphan worker', orphanStatus.ok === false && orphanStatus.code === 'root-unresolved')
const noWorkspaceHost = fakeHost(undefined)
const noWorkspaceAgent = { id: 'no-workspace', session: { header: {} } }
const noWorkspaceStatus = await noWorkspaceHost.tools.gate_status.execute({}, { agent: noWorkspaceAgent })
check('gate_status reports state-unavailable without a workspace', noWorkspaceStatus.ok === false && noWorkspaceStatus.code === 'state-unavailable')
const noWorkspaceStart = await noWorkspaceHost.tools.gate_start_phase.execute({}, { agent: noWorkspaceAgent })
check('gate_start_phase rejects invalid node without a workspace', noWorkspaceStart.ok === false && noWorkspaceStart.code === 'invalid-node')

const outside = mkdtempSync(path.join(os.tmpdir(), 'gate-outside-'))
const cwdHost = fakeHost(workspace, undefined, { cwd: outside })
saveState(workspace, agent, { ...defaultState(), phase: 'docs', task: 'docs/', work: 'active' })
check('write classification follows workingDirectory', (await execWith(cwdHost, agent, 'write', { file_path: 'inside.md' })).kind === 'deny')
saveState(workspace, agent, defaultState())

const noNotes = mkdtempSync(path.join(os.tmpdir(), 'gate-no-notes-'))
addGate(noNotes)
const noNotesHost = fakeHost(noNotes)
const noNotesAgent = { id: 'session-no-notes', session: { header: {} } }
const noNotesPlan = await noNotesHost.commands['gate-enter-plan'].handler({ agent: noNotesAgent, rawInput: '', attachments: [] })
check('plan without project notes skill uses built-in notes', noNotesPlan.kind === 'success')

const customNotes = mkdtempSync(path.join(os.tmpdir(), 'gate-custom-notes-'))
addGate(customNotes, { notesSkillPath: 'custom/notes' })
const customNotesHost = fakeHost(customNotes)
const customNotesAgent = { id: 'session-custom-notes', session: { header: {} } }
const customNotesPlan = await customNotesHost.commands['gate-enter-plan'].handler({ agent: customNotesAgent, rawInput: '', attachments: [] })
check('notesSkillPath remains accepted as deprecated config', customNotesPlan.kind === 'success')

const noNote = makeWorkspace({ note: false })
const noNoteHost = fakeHost(noNote)
const noNoteAgent = { id: 'session-no-note', session: { header: {} } }
saveState(noNote, noNoteAgent, { ...defaultState(), phase: 'discuss', task: 'missing-work', planReady: true })
const noNoteEnter = await noNoteHost.commands['gate-enter-implement'].handler({ agent: noNoteAgent, rawInput: '', attachments: [] })
check('implement can start without a note', noNoteEnter.kind === 'success' && loadState(noNote, noNoteAgent).node === 'implement')

const initWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-init-'))
const initHost = fakeHost(initWorkspace)
const initAgent = { id: 'session-init', session: { header: {} } }
const initialized = await initHost.commands['gate-init'].handler({ agent: initAgent, rawInput: '', attachments: [] })
check('gate-init initializes without a marker and stays in discuss',
  initialized.kind === 'success'
  && !existsSync(path.join(initWorkspace, '.agents', 'gate.json'))
  && loadState(initWorkspace, initAgent).phase === 'discuss')
const noMarkerWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-no-marker-'))
const noMarkerHost = fakeHost(noMarkerWorkspace)
const noMarker = await noMarkerHost.commands['gate-enter-plan'].handler({ agent: initAgent, rawInput: 'anything', attachments: [] })
check('gate command works without a marker', noMarker.kind === 'success' && !existsSync(path.join(noMarkerWorkspace, '.agents', 'gate.json')))

const projection = fakeProjection()
const projectionWorkspace = makeWorkspace()
const projectionAgent = { id: 'projection-session', session: { header: {} } }
const projectionHost = fakeHost(projectionWorkspace, undefined, { projection })
await Promise.resolve()
await Promise.resolve()
const projectionSection = projectionHost.sections.find(section => section.name === 'gate:protocol')
check('projection starts in discuss', projection.stateOf(projectionAgent.session).phase === 'discuss')
const projectionDiscussStatus = await projectionHost.tools.gate_status.execute({}, { agent: projectionAgent })
check('projection prompt starts in discuss', projectionSection.text({ agent: projectionAgent }) === staticPrompt && projectionDiscussStatus.procedure?.text.includes('用户授权后调用 gate_start_phase'))
await projectionHost.commands['gate-enter-plan'].handler({ agent: projectionAgent, rawInput: '', attachments: [] })
projection.apply(projectionAgent.session, { type: 'command/run', data: { commandId: 'cmd-1', name: 'gate-enter-plan', args: '' } })
projection.apply(projectionAgent.session, { type: 'command/done', data: { commandId: 'cmd-1', kind: 'success' } })
check('projection folds plan command', projection.stateOf(projectionAgent.session).phase === 'orchestrating' && projection.stateOf(projectionAgent.session).node === 'plan')
const projectionPlanStatus = await projectionHost.tools.gate_status.execute({}, { agent: projectionAgent })
check('projection prompt reads plan', projectionSection.text({ agent: projectionAgent }) === staticPrompt && projectionPlanStatus.procedure?.text.includes('## Step 1'))
const projectedRecord = await projectionHost.tools.gate_record.execute({ node: 'plan', task: 'work', workerSessionIds: ['worker-test'], noteDecision: 'new', noteSearch: 'test', notePaths: [{ path: addTestNote(projectionWorkspace), class: 'feature', lifecycle: 'proposed' }] }, { agent: projectionAgent })
projection.apply(projectionAgent.session, { type: 'tool/result', data: { meta: { gate: { state: projectedRecord.state } } } })
check('projection folds gate_record result', projection.stateOf(projectionAgent.session).node === 'plan-review')
check('projection projection omits side-file state', !existsSync(path.join(projectionWorkspace, '.agents', 'state', 'gate')))

const configOk = Config['~standard'].validate({ reviewLimit: 3 })
const configBad = Config['~standard'].validate({ reviewLimit: 0 })
check('Config accepts a valid reviewLimit', configOk.value?.reviewLimit === 3)
check('Config rejects an invalid reviewLimit', Array.isArray(configBad.issues) && configBad.issues.length > 0)

const limitWorkspace = makeWorkspace()
const limitAgent = { id: 'session-limit', session: { header: {} } }
const limitHost = fakeHost(limitWorkspace, undefined, { config: { reviewLimit: 2 } })
await limitHost.commands['gate-enter-plan'].handler({ agent: limitAgent, rawInput: '', attachments: [] })
await limitHost.tools.gate_record.execute({ node: 'plan', task: 'work', workerSessionIds: ['worker-test'], noteDecision: 'new', noteSearch: 'test', notePaths: [{ path: addTestNote(limitWorkspace), class: 'feature', lifecycle: 'proposed' }] }, { agent: limitAgent })
await limitHost.tools.gate_record.execute({ node: 'plan-review', findings: [{ id: 'L1' }], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] }, architecture: { findings: [] } } }, { agent: limitAgent })
await limitHost.tools.gate_record.execute({ node: 'plan-revise', workerSessionIds: ['worker-test'] }, { agent: limitAgent })
const limited = await limitHost.tools.gate_record.execute({ node: 'plan-review', findings: [{ id: 'L2' }], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] }, architecture: { findings: [] } } }, { agent: limitAgent })
check('configured reviewLimit caps review', limited.phase === 'blocked' && loadState(limitWorkspace, limitAgent).rounds.planReview === 2)
check('status shows configured reviewLimit', (await limitHost.commands['gate-status'].handler({ agent: limitAgent, rawInput: '', attachments: [] })).text.includes('/2'))

const lifecycleWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-lifecycle-'))
addGate(lifecycleWorkspace)
mkdirSync(path.join(lifecycleWorkspace, '.agents', 'notes', 'proposed', 'process'), { recursive: true })
const lifecycleNote = path.join(lifecycleWorkspace, '.agents', 'notes', 'proposed', 'process', '2026-11-10-feature.md')
writeFileSync(lifecycleNote, `# Agent Note: feature

Status: proposed

## Problem

feature problem

## Proposal

feature proposal

## Alternatives considered

- alternative

## Plan

1. plan one
2. plan two

## Acceptance criteria

1. ac one
2. ac two

## Risks

- risk one
- risk two
`)
mkdirSync(path.join(lifecycleWorkspace, '.artifacts'), { recursive: true })
writeFileSync(path.join(lifecycleWorkspace, '.artifacts', 'verify.txt'), 'verified\n')
const lifecycleAgent = { id: 'session-lifecycle', session: { header: {} } }
const lifecycleHost = fakeHost(lifecycleWorkspace)
const lifecycleInit = await lifecycleHost.commands['gate-init'].handler({ agent: lifecycleAgent, rawInput: '', attachments: [] })
check('gate-init provisions notes roots and AGENTS', lifecycleInit.kind === 'success' && existsSync(path.join(lifecycleWorkspace, 'AGENTS.md')) && existsSync(path.join(lifecycleWorkspace, '.agents', 'notes', 'rejected', '.gitkeep')))
const initPackage = JSON.parse(readFileSync(path.join(lifecycleWorkspace, 'package.json'), 'utf8'))
check('gate-init configures verify-notes npm script', initPackage.scripts?.['verify-notes'] === 'node .agents/gate/verify-notes.mjs' && existsSync(path.join(lifecycleWorkspace, '.agents', 'gate', 'verify-notes.mjs')))
const launcherText = readFileSync(path.join(lifecycleWorkspace, '.agents', 'gate', 'verify-notes.mjs'), 'utf8')
check('verify-notes launcher uses project-local scripts', launcherText.includes(".agents', 'gate', 'ci") && !launcherText.includes(lifecycleWorkspace))
const ciWorkflow = path.join(lifecycleWorkspace, '.github', 'workflows', 'verify-notes.yml')
check('gate-init configures note verification CI', existsSync(ciWorkflow) && readFileSync(ciWorkflow, 'utf8').includes('.agents/gate/ci/verify-agent-note-tree.ts') && existsSync(path.join(lifecycleWorkspace, '.agents', 'gate', 'ci', 'agent-note-tree.ts')))
const board = await lifecycleHost.commands['gate-note-board'].handler({ agent: lifecycleAgent, rawInput: 'board.html', attachments: [] })
check('gate-note-board generates a board', board.kind === 'success' && existsSync(path.join(lifecycleWorkspace, 'board.html')))
check('gate-init does not copy project skill', !existsSync(path.join(lifecycleWorkspace, '.agents', 'skills', 'write-agent-notes')))
await lifecycleHost.commands['gate-init'].handler({ agent: lifecycleAgent, rawInput: '', attachments: [] })
const agentBlock = readFileSync(path.join(lifecycleWorkspace, 'AGENTS.md'), 'utf8')
check('gate-init AGENTS block is idempotent', (agentBlock.match(/<!-- gate-notes:start -->/gu) ?? []).length === 1)
await lifecycleHost.commands['gate-enter-plan'].handler({ agent: lifecycleAgent, rawInput: '', attachments: [] })
const notePlan = await lifecycleHost.tools.gate_record.execute({
  node: 'plan', task: 'feature', workerSessionIds: ['worker-test'], noteDecision: 'new', noteSearch: 'searched active notes',
  notePaths: [{ path: '.agents/notes/proposed/process/2026-11-10-feature.md', class: 'process', lifecycle: 'proposed' }],
}, { agent: lifecycleAgent })
check('plan records notePaths', notePlan.ok === true && notePlan.state.notePaths.length === 1)
await lifecycleHost.tools.gate_record.execute({ node: 'plan-review', findings: [], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] }, architecture: { findings: [] } } }, { agent: lifecycleAgent })
await lifecycleHost.commands['gate-enter-implement'].handler({ agent: lifecycleAgent, rawInput: '', attachments: [] })
await lifecycleHost.tools.gate_record.execute({ node: 'implement', workerSessionIds: ['worker-test'] }, { agent: lifecycleAgent })
await lifecycleHost.tools.gate_record.execute({ node: 'code-review', findings: [], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] }, architecture: { findings: [] } } }, { agent: lifecycleAgent })
const lifecycleVerify = await lifecycleHost.tools.gate_record.execute({
  node: 'verify', workerSessionIds: ['worker-test'],
  verification: { commands: ['node verify.js'], evidence: ['.artifacts/verify.txt'], toolResults: ['tool-result-1'], passed: true },
}, { agent: lifecycleAgent })
check('verify PASS enters note-lifecycle', lifecycleVerify.ok === true && lifecycleVerify.state.node === 'note-lifecycle')
check('verify PASS returns the note-lifecycle procedure', lifecycleVerify.procedure?.node === 'note-lifecycle' && lifecycleVerify.procedure?.method.includes('gate-write-agent-notes'))
const lifecyclePrompt = lifecycleHost.sections.find(section => section.name === 'gate:protocol').text({ agent: lifecycleAgent })
check('note-lifecycle prompt is the static methodology', lifecyclePrompt === staticPrompt && (lifecyclePrompt.match(/## note-lifecycle/gu) ?? []).length === 1 && !lifecyclePrompt.includes('## 派发规则'))
const lifecycleStatus = await lifecycleHost.tools.gate_status.execute({}, { agent: lifecycleAgent })
check('note-lifecycle procedure has no dispatch', lifecycleStatus.procedure.text.includes('gate_note_finalize') && !lifecycleStatus.procedure.text.includes('## 派发规则'))
check('note-lifecycle gate_status keeps rounds in state', lifecycleStatus.text.includes('rounds：'))
const finalized = await lifecycleHost.tools.gate_note_finalize.execute({}, { agent: lifecycleAgent })
check('gate_note_finalize moves note', finalized.ok === true && existsSync(path.join(lifecycleWorkspace, '.agents', 'notes', 'implemented', 'process', '2026-11-10-feature.md')), JSON.stringify(finalized))
const implementedContent = readFileSync(path.join(lifecycleWorkspace, '.agents', 'notes', 'implemented', 'process', '2026-11-10-feature.md'), 'utf8')
check('finalize preserves multi-line section bodies', implementedContent.includes('ac one') && implementedContent.includes('ac two') && implementedContent.includes('risk two') && implementedContent.includes('decision body') === false && !implementedContent.includes('plan two') && !/^## Plan$/mu.test(implementedContent))
const noteVerified = await lifecycleHost.tools.gate_note_verify.execute({}, { agent: lifecycleAgent })
check('gate_note_verify sets noteVerified', noteVerified.ok === true && noteVerified.state.noteVerified === true)
const lifecycleDone = await lifecycleHost.tools.gate_record.execute({ node: 'note-lifecycle' }, { agent: lifecycleAgent })
check('note-lifecycle returns to discuss', lifecycleDone.ok === true && lifecycleDone.state.phase === 'discuss' && lifecycleDone.state.task === null)
check('note-lifecycle record returns the discuss procedure', lifecycleDone.procedure?.phase === 'discuss' && lifecycleDone.procedure?.node === null && lifecycleDone.procedure?.text.includes('用户授权后调用 gate_start_phase'))

const sequenceWorkspace = makeWorkspace()
mkdirSync(path.join(sequenceWorkspace, '.artifacts'), { recursive: true })
writeFileSync(path.join(sequenceWorkspace, '.artifacts', 'verify.txt'), 'verified\n')
const sequenceAgent = { id: 'session-sequence', session: { header: {} } }
const sequenceHost = fakeHost(sequenceWorkspace)
const sequenceSection = sequenceHost.sections.find(section => section.name === 'gate:protocol')
const sequenceTexts = []
const sequenceLabels = []
const renderSequence = label => { sequenceLabels.push(label); sequenceTexts.push(sequenceSection.text({ agent: sequenceAgent })) }
const runSequence = async action => { await action(); }
renderSequence('discuss')
await runSequence(() => sequenceHost.commands['gate-enter-plan'].handler({ agent: sequenceAgent, rawInput: '', attachments: [] }))
renderSequence('plan')
const sequenceNote = addTestNote(sequenceWorkspace)
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'plan', task: 'work', workerSessionIds: ['worker-test'], noteDecision: 'new', noteSearch: 'search', notePaths: [{ path: sequenceNote, class: 'feature', lifecycle: 'proposed' }] }, { agent: sequenceAgent }))
renderSequence('plan-review')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'plan-review', findings: [{ id: 'F1' }], reviewAxes: { standards: { findings: [] }, spec: { findings: [] }, architecture: { findings: [] } }, workerSessionIds: ['worker-test'] }, { agent: sequenceAgent }))
renderSequence('plan-revise')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'plan-revise', workerSessionIds: ['worker-test'] }, { agent: sequenceAgent }))
renderSequence('plan-review-2')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'plan-review', findings: [], reviewAxes: { standards: { findings: [] }, spec: { findings: [] }, architecture: { findings: [] } }, workerSessionIds: ['worker-test'] }, { agent: sequenceAgent }))
renderSequence('discuss-plan-ready')
await runSequence(() => sequenceHost.commands['gate-enter-implement'].handler({ agent: sequenceAgent, rawInput: '', attachments: [] }))
renderSequence('implement')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'implement', workerSessionIds: ['worker-test'] }, { agent: sequenceAgent }))
renderSequence('code-review')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'code-review', findings: [{ id: 'C1' }], reviewAxes: { standards: { findings: [] }, spec: { findings: [] } }, workerSessionIds: ['worker-test'] }, { agent: sequenceAgent }))
renderSequence('implement-revise')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'implement-revise', workerSessionIds: ['worker-test'] }, { agent: sequenceAgent }))
renderSequence('code-review-2')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'code-review', findings: [], reviewAxes: { standards: { findings: [] }, spec: { findings: [] } }, workerSessionIds: ['worker-test'] }, { agent: sequenceAgent }))
renderSequence('verify')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'verify', verification: { commands: ['node verify.js'], evidence: ['.artifacts/verify.txt'], toolResults: ['tool-result-1'], passed: true }, workerSessionIds: ['worker-test'] }, { agent: sequenceAgent }))
renderSequence('note-lifecycle')
await runSequence(() => sequenceHost.tools.gate_note_finalize.execute({}, { agent: sequenceAgent }))
renderSequence('note-lifecycle-finalized')
await runSequence(() => sequenceHost.tools.gate_note_verify.execute({}, { agent: sequenceAgent }))
renderSequence('note-lifecycle-verified')
await runSequence(() => sequenceHost.tools.gate_record.execute({ node: 'note-lifecycle' }, { agent: sequenceAgent }))
renderSequence('discuss-done')
const sequenceChanges = sequenceLabels.filter((label, index) => index > 0 && sequenceTexts[index] !== sequenceTexts[index - 1])
check('root prompt never changes across the sequence', sequenceChanges.length === 0 && sequenceTexts.every(text => text === staticPrompt), JSON.stringify(sequenceChanges))
check('static prompt is methodology, not procedure', staticPrompt.includes('## Gate 方法论') && !staticPrompt.includes('状态：') && !staticPrompt.includes('reviewAxes') && !staticPrompt.includes('workerSessionIds') && !staticPrompt.includes('rounds：'))
const sequenceFinalStatus = await sequenceHost.tools.gate_status.execute({}, { agent: sequenceAgent })
check('sequence ends with the discuss procedure', sequenceFinalStatus.procedure?.phase === 'discuss' && sequenceFinalStatus.procedure?.node === null && sequenceFinalStatus.procedure?.text.includes('用户授权后调用 gate_start_phase'))

const rapidWorkspace = makeWorkspace()
const rapidAgent = { id: 'session-rapid', session: { header: {} } }
const rapidHost = fakeHost(rapidWorkspace)
const rapidSection = rapidHost.sections.find(section => section.name === 'gate:protocol')
const rapidChecks = []
const rapidCheck = async (label, phase, node) => {
  const status = await rapidHost.tools.gate_status.execute({}, { agent: rapidAgent })
  rapidChecks.push([label, rapidSection.text({ agent: rapidAgent }) === staticPrompt, status.procedure?.phase === phase, status.procedure?.node === node])
}
await rapidHost.commands['gate-enter-plan'].handler({ agent: rapidAgent, rawInput: '', attachments: [] })
await rapidCheck('plan', 'orchestrating', 'plan')
await rapidHost.commands['gate-block'].handler({ agent: rapidAgent, rawInput: 'pause', attachments: [] })
await rapidCheck('blocked', 'blocked', null)
await rapidHost.commands['gate-resume'].handler({ agent: rapidAgent, rawInput: '', attachments: [] })
await rapidCheck('resume', 'orchestrating', 'plan')
await rapidHost.commands['gate-return-discuss'].handler({ agent: rapidAgent, rawInput: '', attachments: [] })
await rapidCheck('discuss', 'discuss', null)
await rapidHost.commands['gate-docs'].handler({ agent: rapidAgent, rawInput: '', attachments: [] })
await rapidCheck('docs', 'docs', null)
await rapidHost.tools.gate_record.execute({ node: 'docs' }, { agent: rapidAgent })
await rapidCheck('docs-done', 'discuss', null)
await rapidHost.commands['gate-fix-bug'].handler({ agent: rapidAgent, rawInput: 'fix', attachments: [] })
await rapidCheck('fix-bug', 'orchestrating', 'fix-bug')
await rapidHost.tools.gate_record.execute({ node: 'fix-bug', workerSessionIds: ['worker-test'] }, { agent: rapidAgent })
await rapidCheck('fix-done', 'discuss', null)
await rapidHost.commands['gate-enter-implement'].handler({ agent: rapidAgent, rawInput: 'direct', attachments: [] })
await rapidCheck('direct-implement', 'orchestrating', 'implement')
check('rapid switches keep static prompt and current procedure', rapidChecks.every(([, stable, phase, node]) => stable && phase && node), JSON.stringify(rapidChecks))

const invalidNoteWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-invalid-note-'))
addGate(invalidNoteWorkspace)
mkdirSync(path.join(invalidNoteWorkspace, '.agents', 'notes', 'proposed', 'feature'), { recursive: true })
writeFileSync(path.join(invalidNoteWorkspace, '.agents', 'notes', 'proposed', 'feature', '2026-11-10-bad.md'), '# Agent Note: bad\n\nStatus: proposed\n\n## Problem\n\np\n')
const invalidNoteAgent = { id: 'session-invalid-note', session: { header: {} } }
const invalidNoteHost = fakeHost(invalidNoteWorkspace)
await invalidNoteHost.commands['gate-enter-plan'].handler({ agent: invalidNoteAgent, rawInput: '', attachments: [] })
const invalidPlanRecord = await invalidNoteHost.tools.gate_record.execute({ node: 'plan', task: 'bad', workerSessionIds: ['worker-test'], noteDecision: 'new', notePaths: [{ path: '.agents/notes/proposed/feature/2026-11-10-bad.md', class: 'feature', lifecycle: 'proposed' }] }, { agent: invalidNoteAgent })
check('plan rejects a note that fails format', invalidPlanRecord.ok === false && invalidPlanRecord.code === 'note-format-invalid')

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
























