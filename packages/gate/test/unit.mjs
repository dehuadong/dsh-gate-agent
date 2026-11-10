// Core checks for the P0 gate: state, docs, commands, gate_record, workers, write surface.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, Config, DISCUSS_ORCHESTRATION } from '../index.js'
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
    skills: { register: () => {} },
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
  let withWorkers = ['plan', 'plan-review', 'plan-revise', 'implement', 'code-review', 'implement-revise', 'verify', 'review'].includes(args.node)
    && args.workerSessionIds === undefined
    ? { ...args, workerSessionIds: ['worker-test'] }
    : args
  if (args.node === 'plan' && args.noteDecision === undefined) {
    const notePath = addTestNote(workspace)
    withWorkers = { ...withWorkers, noteDecision: 'new', noteSearch: 'test search', notePaths: [{ path: notePath, class: 'feature', lifecycle: 'proposed' }] }
  }
  const withAxes = ['plan-review', 'code-review', 'review'].includes(args.node) && withWorkers.reviewAxes === undefined
    ? { ...withWorkers, reviewAxes: { standards: { findings: [] }, spec: { findings: [] } } }
    : withWorkers
  const withToolResults = args.node === 'verify' && withAxes.verification !== undefined && withAxes.verification.toolResults === undefined
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
check('discuss protocol is read-only and default', DISCUSS_ORCHESTRATION.includes('discuss 是默认阶段') && DISCUSS_ORCHESTRATION.includes('只读讨论') && !DISCUSS_ORCHESTRATION.includes('/discuss'))
const gateSection = host.sections.find(section => section.name === 'gate:protocol')
check('discuss prompt does not claim orchestration', gateSection.text({ agent }).includes('只读讨论') && !gateSection.text({ agent }).includes('编排中'))
check('discuss denies worker dispatch', (await exec('subagent', { description: 'x', prompt: 'x' })).kind === 'deny')
check('discuss denies apply_patch', (await exec('apply_patch', { input: '*** Begin Patch\n*** Add File: src/x.ts\n+x\n*** End Patch' })).kind === 'deny')

const withoutPlan = await run('gate-enter-implement')
check('implement without plan review is rejected', withoutPlan.kind === 'error' && stateOf().planReady !== true)

await run('gate-enter-plan')
check('plan command enters orchestrating', stateOf().phase === 'orchestrating' && stateOf().node === 'plan')
const noWorker = await record({ node: 'plan', task: 'work', workerSessionIds: [] })
check('worker-required blocks gate_record', noWorker.ok === false && noWorker.code === 'worker-required')
const ghostWorker = await record({ node: 'plan', task: 'work', workerSessionIds: ['ghost'] })
check('worker-not-descendant blocks gate_record', ghostWorker.ok === false && ghostWorker.code === 'worker-not-descendant')
const noTask = await record({ node: 'plan' })
check('plan record requires task', noTask.ok === false && noTask.code === 'task-required')
check('plan review can start', (await record({ node: 'plan', task: 'work' })).ok === true && stateOf().node === 'plan-review')
const noAxes = await host.tools.gate_record.execute({ node: 'plan-review', findings: [], workerSessionIds: ['worker-test'] }, { agent, signal: new AbortController().signal })
check('review requires standards and spec axes', noAxes.ok === false && noAxes.code === 'review-axes-required')
check('empty plan review returns to discuss', (await record({ node: 'plan-review', findings: [] })).phase === 'discuss')
check('clean plan review sets planReady', stateOf().planReady === true)

await run('gate-enter-implement')
check('implement command enters orchestrating', stateOf().phase === 'orchestrating' && stateOf().node === 'implement')
await record({ node: 'implement' })
check('implement moves to code review', stateOf().node === 'code-review')
check('empty code review moves to verify', (await record({ node: 'code-review', findings: [] })).node === 'verify')
const missingVerify = await record({ node: 'verify' })
check('verify without evidence is rejected', missingVerify.code === 'verification-required', JSON.stringify(missingVerify))
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
check('verify passes', verified.phase === 'complete', JSON.stringify(verified))
check('verify records execution-bound evidence hash', stateOf().verification?.executionBound === true && stateOf().verification?.selfReported === false && /^[a-f0-9]{64}$/u.test(stateOf().verification?.evidence?.[0]?.sha256 ?? ''))
check('status shows verify evidence', (await run('gate-status', '')).text.includes('verify：PASS（verified）'))

await run('gate-enter-implement')
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
await run('gate-enter-implement')
check('re-enter implement preserves review rounds', stateOf().rounds.codeReview === 2)
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
check('resume returns to discuss', stateOf().phase === 'discuss')
check('needs-decision plan is not ready', (await run('gate-enter-implement')).kind === 'error')

await run('gate-enter-plan')
await record({ node: 'plan', task: 'work' })
await record({ node: 'plan-review', findings: [] })
await run('gate-enter-implement')
const implementationBlocked = await record({ node: 'implement', requiresDiscussion: true, discussionReason: 'contract choice' })
check('implement can return to blocked discussion', implementationBlocked.phase === 'blocked' && stateOf().blockReason === 'needs-user-decision')
await run('gate-resume')
check('resume returns implement discussion to discuss', stateOf().phase === 'discuss')

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

await run('gate-code-review', 'src/x.ts')
check('standalone code review enters reviewing', stateOf().phase === 'reviewing' && stateOf().node === 'review')
check('standalone review denies writes', (await exec('write', { file_path: 'src/x.ts' })).kind === 'deny')
check('standalone review ends in discuss', (await record({ node: 'review', findings: [] })).phase === 'discuss')

await run('gate-block', 'manual pause')
check('block freezes the gate', stateOf().phase === 'blocked' && stateOf().work === 'blocked')
check('block denies writes', (await exec('write', { file_path: 'docs/x.md' })).kind === 'deny')
await run('gate-resume')
check('resume returns to discuss after manual block', stateOf().phase === 'discuss' && stateOf().work === 'active')

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
check('gate-enter-plan wakes the agent for orchestration', wakeMessages.length === 1 && wakeMessages[0].content?.[0]?.text?.includes('gate-planning') && wakeMessages[0].source?.kind === 'gate-command' && wakeMessages[0].source?.command === 'gate-enter-plan')
const planWakeText = wakeMessages[0].content?.[0]?.text ?? ''
check('plan wake names notes skill and required note fields', planWakeText.includes('gate-write-agent-notes') && planWakeText.includes('noteDecision') && planWakeText.includes('notePaths') && planWakeText.includes('noteSearch'))

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
check('implement wake names review, verify and lifecycle steps', implementWakeText.includes('gate-code-review') && implementWakeText.includes('gate-verify') && implementWakeText.includes('note-lifecycle'))

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
check('worker prompt uses root node', workerPrompt.includes('Gate worker') && workerPrompt.includes('节点：plan') && !workerPrompt.includes('只读讨论') && !workerPrompt.includes('gate-planning'))
check('worker prompt does not ask the worker to load methods', !workerPrompt.includes('## Method files') && workerPrompt.includes('主代理已经加载'))
check('main prompt names the exact phase skill', workerSection.text({ agent: rootAgent }).includes('## 阶段方法') && workerSection.text({ agent: rootAgent }).includes('当前节点：plan') && workerSection.text({ agent: rootAgent }).includes('`gate-planning`'))
check('main prompt requires a fresh skill load per dispatch', workerSection.text({ agent: rootAgent }).includes('## 派发规则') && workerSection.text({ agent: rootAgent }).includes('加载“阶段方法”') && !workerSection.text({ agent: rootAgent }).includes('## Method files'))
check('plan worker generic write is denied', (await execWith(workerHost, childAgent, 'write', { file_path: '.agents/notes/proposed/feature/x.md' })).kind === 'deny')
const noteWrite = await workerHost.tools.gate_note_write.execute({ path: 'feature/2026-11-10-y.md', content: '# Note\n' }, { agent: childAgent })
check('plan worker can write a proposed note', noteWrite.ok === true)
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
check('worker prompt falls back to durable parent lineage', fallbackPrompt.includes('Gate worker') && fallbackPrompt.includes('节点：plan') && !fallbackPrompt.includes('## Method files'))
check('fallback child cannot call gate_record', (await fallbackHost.tools.gate_record.execute({ node: 'plan', task: 'x' }, { agent: fallbackChild })).code === 'root-only')

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
check('implement without proposed note is rejected', noNoteEnter.kind === 'error' && noNoteEnter.text.includes('工作项'))

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
check('projection prompt starts in discuss', projectionSection.text({ agent: projectionAgent }).includes('状态：discuss'))
await projectionHost.commands['gate-enter-plan'].handler({ agent: projectionAgent, rawInput: '', attachments: [] })
projection.apply(projectionAgent.session, { type: 'command/run', data: { commandId: 'cmd-1', name: 'gate-enter-plan', args: '' } })
projection.apply(projectionAgent.session, { type: 'command/done', data: { commandId: 'cmd-1', kind: 'success' } })
check('projection folds plan command', projection.stateOf(projectionAgent.session).phase === 'orchestrating' && projection.stateOf(projectionAgent.session).node === 'plan')
check('projection prompt reads plan', projectionSection.text({ agent: projectionAgent }).includes('节点：plan'))
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
await limitHost.tools.gate_record.execute({ node: 'plan-review', findings: [{ id: 'L1' }], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] } } }, { agent: limitAgent })
await limitHost.tools.gate_record.execute({ node: 'plan-revise', workerSessionIds: ['worker-test'] }, { agent: limitAgent })
const limited = await limitHost.tools.gate_record.execute({ node: 'plan-review', findings: [{ id: 'L2' }], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] } } }, { agent: limitAgent })
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
await lifecycleHost.tools.gate_record.execute({ node: 'plan-review', findings: [], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] } } }, { agent: lifecycleAgent })
await lifecycleHost.commands['gate-enter-implement'].handler({ agent: lifecycleAgent, rawInput: '', attachments: [] })
await lifecycleHost.tools.gate_record.execute({ node: 'implement', workerSessionIds: ['worker-test'] }, { agent: lifecycleAgent })
await lifecycleHost.tools.gate_record.execute({ node: 'code-review', findings: [], workerSessionIds: ['worker-test'], reviewAxes: { standards: { findings: [] }, spec: { findings: [] } } }, { agent: lifecycleAgent })
const lifecycleVerify = await lifecycleHost.tools.gate_record.execute({
  node: 'verify', workerSessionIds: ['worker-test'],
  verification: { commands: ['node verify.js'], evidence: ['.artifacts/verify.txt'], toolResults: ['tool-result-1'], passed: true },
}, { agent: lifecycleAgent })
check('verify PASS enters note-lifecycle', lifecycleVerify.ok === true && lifecycleVerify.state.node === 'note-lifecycle')
const lifecyclePrompt = lifecycleHost.sections.find(section => section.name === 'gate:protocol').text({ agent: lifecycleAgent })
check('note-lifecycle prompt does not dispatch workers', lifecyclePrompt.includes('Note lifecycle') && lifecyclePrompt.includes('不派 worker') && !lifecyclePrompt.includes('## 派发规则'))
const finalized = await lifecycleHost.tools.gate_note_finalize.execute({}, { agent: lifecycleAgent })
check('gate_note_finalize moves note', finalized.ok === true && existsSync(path.join(lifecycleWorkspace, '.agents', 'notes', 'implemented', 'process', '2026-11-10-feature.md')), JSON.stringify(finalized))
const implementedContent = readFileSync(path.join(lifecycleWorkspace, '.agents', 'notes', 'implemented', 'process', '2026-11-10-feature.md'), 'utf8')
check('finalize preserves multi-line section bodies', implementedContent.includes('ac one') && implementedContent.includes('ac two') && implementedContent.includes('risk two') && implementedContent.includes('decision body') === false && !implementedContent.includes('plan two') && !/^## Plan$/mu.test(implementedContent))
const noteVerified = await lifecycleHost.tools.gate_note_verify.execute({}, { agent: lifecycleAgent })
check('gate_note_verify sets noteVerified', noteVerified.ok === true && noteVerified.state.noteVerified === true)
const lifecycleDone = await lifecycleHost.tools.gate_record.execute({ node: 'note-lifecycle' }, { agent: lifecycleAgent })
check('note-lifecycle completes gate', lifecycleDone.ok === true && lifecycleDone.state.phase === 'complete')

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



