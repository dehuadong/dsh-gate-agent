// Core checks for the P0 gate: state, docs, commands, gate_record, workers, write surface.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, Config, DISCUSS_ORCHESTRATION, GATE_RECORD_NODES, NODE_METHODS, WORKER_NODES, loadState, saveState, defaultState, normalizeState } from '../lib/index.js'

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
check('gate tools declare output schema and render', Object.values(host.tools).every(tool => tool?.output?.schema !== undefined && typeof tool.output.render === 'function'))
check('discuss denies root code writes', (await exec('write', { file_path: 'src/x.ts' })).kind === 'deny')
check('discuss denies root docs writes', (await exec('write', { file_path: 'docs/x.md' })).kind === 'deny')
check('discuss denies root shell writes', (await exec('pwsh', { command: 'Set-Content docs/x.md x' })).kind === 'deny')
check('discuss allows root read-only shell', (await exec('pwsh', { command: 'Get-ChildItem' })).kind === 'allow')
check('discuss allows git add', (await exec('pwsh', { command: 'git add src/x.ts' })).kind === 'allow')
check('discuss allows git commit', (await exec('pwsh', { command: 'git commit -m discuss' })).kind === 'allow')
check('discuss allows git push', (await exec('pwsh', { command: 'git push origin main' })).kind === 'allow')
check('discuss allows git -C commit', (await exec('pwsh', { command: 'git -C . commit -m discuss' })).kind === 'allow')
check('discuss denies git checkout', (await exec('pwsh', { command: 'git checkout main' })).kind === 'deny')
check('discuss denies git -C checkout', (await exec('pwsh', { command: 'git -C . checkout main' })).kind === 'deny')
check('discuss denies git -c checkout', (await exec('pwsh', { command: 'git -c core.autocrlf=false checkout .' })).kind === 'deny')
check('discuss denies git.exe stash', (await exec('pwsh', { command: 'git.exe stash' })).kind === 'deny')
check('discuss allows git work-tree push', (await exec('pwsh', { command: 'git --work-tree . push' })).kind === 'allow')
check('discuss allows git --git-dir commit', (await exec('pwsh', { command: 'git --git-dir .git commit -m discuss' })).kind === 'allow')
check('discuss denies git stash', (await exec('pwsh', { command: 'git stash' })).kind === 'deny')
await run('gate-block', 'pause')
const blockedWrite = await exec('write', { file_path: 'src/x.ts' })
check('blocked denies root writes', blockedWrite.kind === 'deny')
check('blocked denial only recommends resume', blockedWrite.reason?.includes('/gate-resume') === true && !blockedWrite.reason?.includes('/gate-return-discuss'))
check('blocked allows read-only shell', (await exec('pwsh', { command: 'Get-ChildItem' })).kind === 'allow')
check('blocked denies write shell', (await exec('pwsh', { command: 'Set-Content docs/x.md x' })).kind === 'deny')
const blockedDispatch = []
for (const name of ['subagent', 'subagent_fork', 'workflow']) blockedDispatch.push((await exec(name, { description: 'x', prompt: 'x' })).kind === 'deny')
check('blocked denies worker dispatch', blockedDispatch.every(Boolean))
await run('gate-resume')
check('resume returns to discuss after block', stateOf().phase === 'discuss')
await run('gate-docs', 'docs/')
check('docs command enters docs with optional scope', stateOf().phase === 'docs' && stateOf().task === 'docs/')
check('docs phase allows docs', (await exec('write', { file_path: 'docs/x.md' })).kind === 'allow')
check('docs phase allows code writes (no content classification)', (await exec('write', { file_path: 'src/x.ts' })).kind === 'allow')
check('docs phase can end through gate_record', (await record({ node: 'docs' })).phase === 'discuss')
check('docs gate_record leaves docs', stateOf().phase === 'discuss')
await run('gate-return-discuss')
check('return enters discuss', stateOf().phase === 'discuss')
const status = await run('gate-status', '')
check('status is factual and suggests next commands', status.text.includes('状态：discuss') && status.text.includes('blockReason：无') && status.text.includes('下一步命令'))
const statusTool = await host.tools.gate_status.execute({}, { agent })
check('gate_status tool is registered and includes /gate-status state', statusTool.ok === true && statusTool.text.startsWith('当前 phase/node') && statusTool.text.includes('状态：discuss') && statusTool.procedure?.phase === 'discuss')
check('discuss procedure is file read-only and short', statusTool.procedure?.text.includes('discuss 不派 worker') && statusTool.procedure?.text.includes('文件默认只读') && !statusTool.procedure?.text.includes('主代理可自行读/写') && !statusTool.procedure?.text.includes('无 worker/write') && !statusTool.procedure?.text.includes('不创建提案、Note 或规格文件'))
check('discuss access is file read-only with repo push', statusTool.access?.write === 'none' && statusTool.access?.shell === 'read' && statusTool.access?.repoWrite === 'push' && statusTool.text.includes('权限：'))
for (const [phase, node, expected] of [
  ['docs', null, { write: 'workspace', noteWrite: false, shell: 'write', repoWrite: 'push' }],
  ['orchestrating', 'note-lifecycle', { write: 'workspace', noteWrite: true, shell: 'write', repoWrite: 'push' }],
  ['complete', null, { write: 'workspace', noteWrite: false, shell: 'write', repoWrite: 'push' }],
  ['blocked', null, { write: 'none', noteWrite: false, shell: 'read', repoWrite: 'push' }],
]) {
  saveState(workspace, agent, { ...defaultState(), phase, node, work: 'active', blockReason: phase === 'blocked' ? 'fixture' : null })
  const matrixStatus = await host.tools.gate_status.execute({}, { agent })
  check(`access matrix ${phase}/${node ?? 'none'}`, matrixStatus.access?.write === expected.write && matrixStatus.access?.noteWrite === expected.noteWrite && matrixStatus.access?.shell === expected.shell && matrixStatus.access?.repoWrite === expected.repoWrite)
}
saveState(workspace, agent, defaultState())
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
check('static prompt points to gate_help', staticPrompt.includes('gate_help'))
check('static prompt has no blocked return-discuss guidance', !staticPrompt.includes('/gate-return-discuss'))
check('static methodology has no old aliases', !['## plan', '## reviewing-code', '## reviewing-proposal', '## reviewing-verify', '## blocked / complete'].some(heading => staticPrompt.split('\n').some(line => line.trim() === heading)))
const methodologyCases = [
  ['discuss', { phase: 'discuss', node: null }, 'discuss'],
  ['blocked', { phase: 'blocked', node: null, work: 'blocked', blockReason: 'fixture' }, 'blocked'],
  ['complete', { phase: 'complete', node: null }, 'complete'],
  ['docs', { phase: 'docs', node: null }, 'docs'],
  ['orchestrating fallback', { phase: 'orchestrating', node: null }, 'orchestrating'],
  ['reviewing fallback', { phase: 'reviewing', node: null }, 'reviewing'],
]
for (const node of GATE_RECORD_NODES) {
  if (node === 'docs') continue
  const phase = ['code-review-standalone', 'proposal-review', 'verify-standalone'].includes(node) ? 'reviewing' : 'orchestrating'
  methodologyCases.push([`${phase}/${node}`, { phase, node, task: 'work', work: 'active' }, `${phase}/${node}`])
}
const expectedMethodologyKeys = [...new Set(methodologyCases.map(item => item[2]))]
const methodologyHeadingTokens = staticPrompt.split('\n')
  .filter(line => line.startsWith('## '))
  .flatMap(line => line.slice(3).split(' · ').map(token => token.trim()))
  .filter(token => token !== 'Gate 方法论')
check('static methodology keys exactly match procedures', expectedMethodologyKeys.every(key => methodologyHeadingTokens.filter(token => token === key).length === 1) && methodologyHeadingTokens.length === expectedMethodologyKeys.length && methodologyHeadingTokens.every(token => expectedMethodologyKeys.includes(token)))
const methodologyChecks = []
for (const [label, state, expected] of methodologyCases) {
  saveState(workspace, agent, { ...defaultState(), ...state })
  const result = await host.tools.gate_status.execute({}, { agent })
  methodologyChecks.push(result.procedure?.methodologyKey === expected && result.text.includes(`方法论：${expected}`))
}
saveState(workspace, agent, defaultState())
check('procedure methodologyKey matches phase/node', methodologyChecks.every(Boolean), JSON.stringify(methodologyChecks))
check('static discuss methodology carries the full rules',
  (staticPrompt.match(/^## discuss$/gmu) ?? []).length === 1
  && ['讨论不是被动访谈', '不要要求用户重复已有信息', '不创建提案、Note 或规格文件', '文件默认只读', '提交已有改动', 'slash command或 ask_user_question 中给出'].every(text => staticPrompt.includes(text)),
  JSON.stringify(staticPrompt.match(/^## discuss$/gmu) ?? []),
)
check('root prompt is the static methodology',
  staticPrompt.startsWith('## Gate 方法论')
  && ['## discuss', '## orchestrating/plan · orchestrating/plan-review · orchestrating/plan-revise', '## orchestrating/implement · orchestrating/implement-revise', '## orchestrating/code-review', '## orchestrating/verify', '## orchestrating/note-lifecycle', '## docs', '## reviewing/code-review-standalone', '## reviewing/proposal-review', '## reviewing/verify-standalone', '## blocked', '## complete', '## orchestrating', '## reviewing'].every(heading => staticPrompt.includes(heading))
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
check('discuss denies root apply_patch', (await exec('apply_patch', { input: '*** Begin Patch\n*** Add File: src/x.ts\n+x\n*** End Patch' })).kind === 'deny')

const withoutPlan = await run('gate-enter-implement')
check('implement without a brief is rejected', withoutPlan.kind === 'error' && withoutPlan.text.includes('一句话'))

const followupWorkspace = makeWorkspace()
let followupText = ''
const followupAgent = { id: 'session-followup', session: { header: {} }, followup: message => { followupText = message.content?.[0]?.text ?? '' } }
const followupHost = fakeHost(followupWorkspace, followupAgent)
await followupHost.commands['gate-enter-plan'].handler({ agent: followupAgent, rawInput: 'do it', attachments: [] })
check('command follow-up includes the current procedure', followupText.startsWith('当前 phase/node：orchestrating / plan') && followupText.includes('## Step 1') && followupText.includes('## 技能加载规则'))

const directWorkspace = makeWorkspace()
const directHost = fakeHost(directWorkspace)
const directAgent = { id: 'session-direct', session: { header: {} } }
const directEnter = await directHost.commands['gate-enter-implement'].handler({ agent: directAgent, rawInput: '把日志级别改成 info', attachments: [] })
check('implement accepts a simple brief without planning', directEnter.kind === 'success' && loadState(directWorkspace, directAgent).node === 'implement' && loadState(directWorkspace, directAgent).task === '把日志级别改成 info')
check('direct implement is automatically mechanical', loadState(directWorkspace, directAgent).noteDecision === 'mechanical' && loadState(directWorkspace, directAgent).notePaths.length === 0)
const directImplementRecord = await directHost.tools.gate_record.execute({ node: 'implement', workerSessionIds: ['worker-test'] }, { agent: directAgent })
check('direct implement record keeps mechanical and moves to review', directImplementRecord.ok === true && directImplementRecord.state.node === 'code-review' && directImplementRecord.state.noteDecision === 'mechanical')
check('direct implement noteVerified stays false until verify', directImplementRecord.state.noteVerified === false)
const directReview = await directHost.tools.gate_record.execute({ node: 'code-review', findings: [], reviewAxes: { standards: { findings: [] }, spec: { findings: [] } }, workerSessionIds: ['worker-test'] }, { agent: directAgent })
check('direct implement review advances to verify', directReview.ok === true && directReview.state.node === 'verify')
mkdirSync(path.join(directWorkspace, 'artifacts'), { recursive: true })
writeFileSync(path.join(directWorkspace, 'artifacts', 'direct.txt'), 'ok')
const directVerify = await directHost.tools.gate_record.execute({ node: 'verify', workerSessionIds: ['worker-test'], verification: { commands: ['node verify.js'], evidence: ['artifacts/direct.txt'], toolResults: ['tool-result-1'], passed: true } }, { agent: directAgent })
check('direct implement verify skips note-lifecycle', directVerify.ok === true && directVerify.state.phase === 'discuss' && directVerify.commitHint?.includes('建议提交实现') === true)

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
check('gate_start_phase direct implement is mechanical', loadState(startImplSurface, startImplAgent).noteDecision === 'mechanical')
check('implement start access is workspace/write shell', startedImplement.access?.write === 'workspace' && startedImplement.access?.shell === 'write' && startedImplement.access?.repoWrite === 'push')

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
const emptyPlanReview = await record({ node: 'plan-review', findings: [] })
check('empty plan review returns to discuss', emptyPlanReview.phase === 'discuss')
check('clean plan review sets planReady', stateOf().planReady === true)
check('plan review empty returns a planning commit hint', emptyPlanReview.commitHint?.includes('planning baseline') === true)
check('plan review result access is discuss read-only', emptyPlanReview.access?.write === 'none' && emptyPlanReview.access?.repoWrite === 'push' && emptyPlanReview.access?.shell === 'read')

const notePathWorkspace = makeWorkspace()
const notePathHost = fakeHost(notePathWorkspace)
const notePathAgent = { id: 'session-note-path', session: { header: {} } }
const canonicalNote = addTestNote(notePathWorkspace)
const notesRelative = canonicalNote.replace(/^\.agents\/notes\//u, '')
const classRelative = notesRelative.split('/').slice(1).join('/')
for (const [label, input] of [['notes-relative', notesRelative], ['class-relative', classRelative]]) {
  saveState(notePathWorkspace, notePathAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work', work: 'active' })
  const result = await notePathHost.tools.gate_record.execute({ node: 'plan', task: 'work', noteDecision: 'new', noteSearch: 'x', notePaths: [{ path: input, class: 'feature', lifecycle: 'proposed' }], workerSessionIds: ['worker-test'] }, { agent: notePathAgent })
  check(`plan accepts ${label} notePaths`, result.ok === true && result.state.notePaths[0].path === canonicalNote, JSON.stringify({ ok: result.ok, code: result.code, path: result.state?.notePaths?.[0]?.path }))
}
saveState(notePathWorkspace, notePathAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work', work: 'active' })
const implementNotePath = await notePathHost.tools.gate_record.execute({ node: 'implement', noteDecision: 'new', notePaths: [{ path: notesRelative, class: 'feature', lifecycle: 'proposed' }], workerSessionIds: ['worker-test'] }, { agent: notePathAgent })
check('implement normalizes notePaths', implementNotePath.ok === true && implementNotePath.state.notePaths[0].path === canonicalNote)

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
const mechanicalWorkspace = makeWorkspace()
const mechanicalHost = fakeHost(mechanicalWorkspace)
const mechanicalAgent = { id: 'session-mechanical-verify', session: { header: {} } }
mkdirSync(path.join(mechanicalWorkspace, 'artifacts'), { recursive: true })
writeFileSync(path.join(mechanicalWorkspace, 'artifacts', 'mechanical.txt'), 'ok')
saveState(mechanicalWorkspace, mechanicalAgent, { ...defaultState(), phase: 'orchestrating', node: 'verify', task: 'verify', work: 'active', noteDecision: 'mechanical' })
const mechanicalVerify = await mechanicalHost.tools.gate_record.execute({ node: 'verify', workerSessionIds: ['worker-test'], verification: { commands: ['node verify.js'], evidence: ['artifacts/mechanical.txt'], toolResults: ['tool-result-1'], passed: true } }, { agent: mechanicalAgent })
check('mechanical verify returns a commit hint without note-lifecycle', mechanicalVerify.ok === true && mechanicalVerify.state.phase === 'discuss' && mechanicalVerify.commitHint?.includes('建议提交实现') === true)
const mechanicalPlanWorkspace = makeWorkspace()
const mechanicalPlanHost = fakeHost(mechanicalPlanWorkspace)
const mechanicalPlanAgent = { id: 'session-mechanical-plan', session: { header: {} } }
saveState(mechanicalPlanWorkspace, mechanicalPlanAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work', work: 'active' })
const mechanicalPlan = await mechanicalPlanHost.tools.gate_record.execute({ node: 'plan', task: 'no-prefix mechanical plan', noteDecision: 'mechanical', notePaths: [], workerSessionIds: ['worker-test'] }, { agent: mechanicalPlanAgent })
check('plan mechanical does not require task prefix', mechanicalPlan.ok === true && mechanicalPlan.state.node === 'plan-review' && mechanicalPlan.state.noteDecision === 'mechanical')
const mechanicalReviseWorkspace = makeWorkspace()
const mechanicalReviseHost = fakeHost(mechanicalReviseWorkspace)
const mechanicalReviseAgent = { id: 'session-mechanical-revise', session: { header: {} } }
saveState(mechanicalReviseWorkspace, mechanicalReviseAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan-revise', task: 'work', work: 'active' })
const mechanicalRevise = await mechanicalReviseHost.tools.gate_record.execute({ node: 'plan-revise', noteDecision: 'mechanical', notePaths: [], workerSessionIds: ['worker-test'] }, { agent: mechanicalReviseAgent })
check('plan-revise mechanical does not require task prefix', mechanicalRevise.ok === true && mechanicalRevise.state.node === 'plan-review' && mechanicalRevise.state.noteDecision === 'mechanical')
saveState(mechanicalPlanWorkspace, mechanicalPlanAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work', work: 'active' })
const mechanicalWithPath = await mechanicalPlanHost.tools.gate_record.execute({ node: 'plan', task: 'mechanical with path', noteDecision: 'mechanical', notePaths: [{ path: '.agents/notes/proposed/feature/x.md', class: 'feature', lifecycle: 'proposed' }], workerSessionIds: ['worker-test'] }, { agent: mechanicalPlanAgent })
check('mechanical still rejects non-empty notePaths', mechanicalWithPath.code === 'note-paths-required')
check('invalid noteDecision normalizes to null', normalizeState({ ...defaultState(), noteDecision: 'bogus' }).noteDecision === null)
const invalidDecisionWorkspace = makeWorkspace()
const invalidDecisionHost = fakeHost(invalidDecisionWorkspace)
const invalidDecisionAgent = { id: 'session-invalid-decision', session: { header: {} } }
saveState(invalidDecisionWorkspace, invalidDecisionAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work', work: 'active' })
const invalidPlanDecision = await invalidDecisionHost.tools.gate_record.execute({ node: 'plan', task: 'work', noteDecision: 'bogus', workerSessionIds: ['worker-test'] }, { agent: invalidDecisionAgent })
check('plan rejects invalid noteDecision', invalidPlanDecision.code === 'note-decision-required')
saveState(invalidDecisionWorkspace, invalidDecisionAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work', work: 'active' })
const invalidImplementDecision = await invalidDecisionHost.tools.gate_record.execute({ node: 'implement', noteDecision: 'bogus', workerSessionIds: ['worker-test'] }, { agent: invalidDecisionAgent })
check('implement rejects invalid noteDecision', invalidImplementDecision.code === 'note-decision-required')
saveState(invalidDecisionWorkspace, invalidDecisionAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan-revise', task: 'work', work: 'active' })
const invalidReviseDecision = await invalidDecisionHost.tools.gate_record.execute({ node: 'plan-revise', noteDecision: 'bogus', workerSessionIds: ['worker-test'] }, { agent: invalidDecisionAgent })
check('plan-revise rejects invalid noteDecision', invalidReviseDecision.code === 'note-decision-required')
const normalVerifyWorkspace = makeWorkspace()
const normalVerifyHost = fakeHost(normalVerifyWorkspace)
const normalVerifyAgent = { id: 'session-normal-verify', session: { header: {} } }
mkdirSync(path.join(normalVerifyWorkspace, 'artifacts'), { recursive: true })
writeFileSync(path.join(normalVerifyWorkspace, 'artifacts', 'normal.txt'), 'ok')
saveState(normalVerifyWorkspace, normalVerifyAgent, { ...defaultState(), phase: 'orchestrating', node: 'verify', task: 'work', work: 'active', noteDecision: 'new', notePaths: [{ path: '.agents/notes/proposed/feature/normal.md', class: 'feature', lifecycle: 'proposed' }] })
const normalVerify = await normalVerifyHost.tools.gate_record.execute({ node: 'verify', workerSessionIds: ['worker-test'], verification: { commands: ['node verify.js'], evidence: ['artifacts/normal.txt'], toolResults: ['tool-result-1'], passed: true } }, { agent: normalVerifyAgent })
check('normal verify enters note-lifecycle without a commit hint', normalVerify.ok === true && normalVerify.state.node === 'note-lifecycle' && normalVerify.commitHint === undefined)
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
check('standalone review allows root writes', (await exec('write', { file_path: 'src/x.ts' })).kind === 'allow')
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
await sandboxHost.commands['gate-block'].handler({ agent: sandboxAgent, rawInput: 'pause', attachments: [] })
await sandboxHost.commands['gate-resume'].handler({ agent: sandboxAgent, rawInput: '', attachments: [] })
await sandboxHost.commands['gate-return-discuss'].handler({ agent: sandboxAgent, rawInput: '', attachments: [] })
await sandboxHost.commands['gate-docs'].handler({ agent: sandboxAgent, rawInput: 'docs/', attachments: [] })
check('gate does not append sandbox/mode', sandboxModes.length === 0, JSON.stringify(sandboxModes))

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
check('discuss root restriction hides write tools but leaves shell', restrictionCalls.at(-1)?.deny?.includes('write') === true && restrictionCalls.at(-1)?.deny?.includes('pwsh') !== true)
saveState(workspace, restrictedAgent, { ...defaultState(), phase: 'blocked', work: 'blocked', blockReason: 'fixture' })
await restrictedHost.handlers['agent/pre-step']({ agent: restrictedAgent }, async () => ({ kind: 'allow' }))
check('blocked root restriction denies write tools but leaves shell', restrictionCalls.at(-1)?.deny?.includes('write') === true && restrictionCalls.at(-1)?.deny?.includes('pwsh') !== true)
saveState(workspace, restrictedAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', work: 'active' })
await restrictedHost.handlers['agent/pre-step']({ agent: restrictedAgent }, async () => ({ kind: 'allow' }))
check('restriction disposes the blocked filter', restrictionDisposals > 0)
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
check('worker prompt uses root node', workerPrompt.includes('Gate worker') && workerPrompt.includes('gate_note_write') && workerPrompt.includes('权限：') && !workerPrompt.includes('只读讨论') && !workerPrompt.includes('## 节点方法'))
check('worker prompt does not ask the worker to load methods', !workerPrompt.includes('## Method files') && workerPrompt.includes('主代理已经加载'))
check('root can git commit in plan', (await execWith(workerHost, rootAgent, 'pwsh', { command: 'git commit -m baseline' })).kind === 'allow')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'blocked', work: 'blocked', blockReason: 'fixture' })
check('root can git commit in blocked', (await execWith(workerHost, rootAgent, 'pwsh', { command: 'git commit -m blocked' })).kind === 'allow')
for (const node of ['implement', 'code-review', 'implement-revise', 'verify', 'note-lifecycle']) {
  saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node, task: 'work', work: 'active' })
  check(`root can git commit in ${node}`, (await execWith(workerHost, rootAgent, 'pwsh', { command: 'git commit -m root' })).kind === 'allow')
}
saveState(workspace, rootAgent, { ...defaultState(), phase: 'discuss', node: null, work: 'active' })
check('root can git commit in discuss', (await execWith(workerHost, rootAgent, 'pwsh', { command: 'git commit -m discuss' })).kind === 'allow')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'complete', node: null, work: 'active' })
check('root can git commit in complete', (await execWith(workerHost, rootAgent, 'pwsh', { command: 'git commit -m complete' })).kind === 'allow')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'code-review', task: 'work', work: 'active' })
check('review worker cannot git commit', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git commit -m review' })).kind === 'deny')
check('review worker cannot commit via --git-dir', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git --git-dir=.git commit -m review' })).kind === 'deny')
for (const node of ['plan', 'plan-review', 'verify']) {
  saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node, task: 'work', work: 'active' })
  check(`${node} worker cannot git commit`, (await execWith(workerHost, childAgent, 'pwsh', { command: 'git commit -m worker' })).kind === 'deny')
}
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work', work: 'active' })
check('implement worker can git commit', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git commit -m implement' })).kind === 'allow')
for (const node of ['implement-revise']) {
  saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node, task: 'work', work: 'active' })
  check(`${node} worker can git commit`, (await execWith(workerHost, childAgent, 'pwsh', { command: 'git commit -m worker' })).kind === 'allow')
}
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work' })
const workerStatus = await workerHost.tools.gate_status.execute({}, { agent: childAgent })
check('gate_status reads root state for a worker but returns no root procedure', workerStatus.ok === true && workerStatus.text.includes('节点：plan') && workerStatus.procedure === null)
check('worker nextCommands are empty', workerStatus.nextCommands?.length === 0)
check('planning worker access is note-only read-shell', workerStatus.access?.write === 'none' && workerStatus.access?.noteWrite === true && workerStatus.access?.shell === 'read' && workerStatus.access?.repoWrite === 'none')
const workerCommandStatus = await workerHost.commands['gate-status'].handler({ agent: childAgent, rawInput: '', attachments: [] })
check('/gate-status matches gate_status for a worker', workerCommandStatus.text === workerStatus.text, JSON.stringify({ command: workerCommandStatus.text, tool: workerStatus.text }))
saveState(workspace, rootAgent, { ...defaultState(), phase: 'reviewing', node: 'verify-standalone', task: 'x', work: 'active' })
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work' })
const rootStatus = await workerHost.tools.gate_status.execute({}, { agent: rootAgent })
check('main prompt is static; the procedure names the current method', workerSection.text({ agent: rootAgent }) === staticPrompt && rootStatus.procedure?.text.includes('gate-planning') && rootStatus.method.includes('gate-planning'))
check('procedure reuses already-loaded skills', rootStatus.procedure.text.includes('## 技能加载规则') && rootStatus.procedure.text.includes('直接复用') && rootStatus.procedure.text.includes('不要重复调用') && !rootStatus.procedure.text.includes('再重新加载 gate-planning'))
check('plan procedure requires rfc for design work', rootStatus.procedure.text.includes('rfc.md') && rootStatus.procedure.text.includes('proposal.md') && rootStatus.procedure.text.includes('设计节'))
const help = await workerHost.tools.gate_help.execute({}, { agent: rootAgent })
check('gate_help lists all commands and tools', help.ok === true && help.commands.length === 16 && help.tools.length === 10 && help.commands.some(item => item.command === '/gate-enter-plan') && help.commands.some(item => item.command === '/gate-prd') && help.tools.some(item => item.name === 'gate_artifact_write') && help.tools.some(item => item.name === 'gate_research_dispatch') && help.tools.some(item => item.name === 'gate_init_verify'))
check('gate_help explains command vs tool', help.text.includes('命令由用户执行') && help.text.includes('工具由模型调用') && help.current?.phase === 'orchestrating' && help.note?.includes('命令由用户执行'))
const registeredToolNames = JSON.parse(readFileSync(new URL('./registry.snapshot.json', import.meta.url), 'utf8')).tools.map(tool => tool.name)
check('gate_help tools match registry', help.tools.length === registeredToolNames.length && registeredToolNames.every(name => help.tools.some(tool => tool.name === name)))
check('gate_help has applicability for every command', help.commands.every(item => typeof item.when === 'string' && item.when.length > 0))
const unifiedHint = '<具体工作事项或上下文语义>'
const freeTextCommands = ['/gate-enter-plan', '/gate-enter-implement', '/gate-implement-review', '/gate-code-verify', '/gate-propose-review']
check('free-text command hints are unified', freeTextCommands.every(name => help.commands.find(item => item.command === name)?.hint === unifiedHint))
const helpWhen = Object.fromEntries(help.commands.map(item => [item.command, item.when]))
check('gate_help carries command applicability', helpWhen['/gate-enter-plan'] === 'discuss/complete' && helpWhen['/gate-resume'] === 'blocked' && helpWhen['/gate-return-discuss'] === 'non-blocked')
const helpState = loadState(workspace, rootAgent)
await workerHost.tools.gate_help.execute({}, { agent: rootAgent })
check('gate_help is read-only', JSON.stringify(loadState(workspace, rootAgent)) === JSON.stringify(helpState))
check('gate_help is root-only', (await workerHost.tools.gate_help.execute({}, { agent: childAgent })).code === 'root-only')
const readmeCommandLabels = [...readFileSync(new URL('../README.md', import.meta.url), 'utf8').matchAll(/^\| `(\/gate-[^ `]+)[^`]*`/gmu)].map(match => match[1])
check('README command table matches gate_help', readmeCommandLabels.length === help.commands.length && help.commands.every(item => readmeCommandLabels.includes(item.command)))
saveState(workspace, rootAgent, defaultState())
check('discuss nextCommands point to plan/implement', (await workerHost.tools.gate_status.execute({}, { agent: rootAgent })).nextCommands.map(item => item.command).join(',') === '/gate-enter-plan,/gate-enter-implement')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'blocked', work: 'blocked', blockReason: 'fixture' })
check('blocked nextCommands only resume', (await workerHost.tools.gate_status.execute({}, { agent: rootAgent })).nextCommands.map(item => item.command).join(',') === '/gate-resume')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'complete', work: 'active' })
check('complete nextCommands include plan/implement', (await workerHost.tools.gate_status.execute({}, { agent: rootAgent })).nextCommands.length === 2)
saveState(workspace, rootAgent, { ...defaultState(), phase: 'docs', work: 'active' })
check('docs nextCommands are empty', (await workerHost.tools.gate_status.execute({}, { agent: rootAgent })).nextCommands.length === 0)
saveState(workspace, rootAgent, { ...defaultState(), phase: 'discuss' })
const rootDiscussStatus = await workerHost.tools.gate_status.execute({}, { agent: rootAgent })
check('gate_status text exposes nextCommands', rootDiscussStatus.text.includes('下一步命令') && rootDiscussStatus.text.includes('/gate-enter-plan'))
check('/gate-status exposes nextCommands', (await workerHost.commands['gate-status'].handler({ agent: rootAgent, rawInput: '', attachments: [] })).text.includes('下一步命令'))
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'plan', task: 'work' })
const planningSkill = readFileSync(new URL('../skills/gate-planning/SKILL.md', import.meta.url), 'utf8')
check('gate-planning skill makes rfc a required design read', planningSkill.includes('必读资源') && planningSkill.includes('写设计节') && planningSkill.includes('rfc.md'))
const planningBrief = readFileSync(new URL('../skills/gate-planning/assets/worker-briefs/gate-enter-plan.md', import.meta.url), 'utf8')
check('planning brief carries design checks', planningBrief.includes('Design 检查项'))
const verifyBrief = readFileSync(new URL('../skills/gate-verify/assets/worker-briefs/gate-verify.md', import.meta.url), 'utf8')
const userVerifyBrief = readFileSync(new URL('../skills/gate-user-verify/assets/worker-briefs/gate-code-verify.md', import.meta.url), 'utf8')
const gateReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
check('verify briefs and README require real callIds', verifyBrief.includes('call_...') && userVerifyBrief.includes('call_...') && gateReadme.includes('"call_..."') && gateReadme.includes('executionBound:true'))
check('plan worker generic write is denied', (await execWith(workerHost, childAgent, 'write', { file_path: '.agents/notes/proposed/feature/x.md' })).kind === 'deny')
const noteWrite = await workerHost.tools.gate_note_write.execute({ path: 'feature/2026-11-10-y.md', content: '# Note\n' }, { agent: childAgent })
check('plan worker can write a proposed note', noteWrite.ok === true)
const noteWritePrefixed = await workerHost.tools.gate_note_write.execute({ path: 'proposed/feature/2026-11-10-z.md', content: '# Note\n' }, { agent: childAgent })
check('proposed/ path prefix is accepted', noteWritePrefixed.ok === true && existsSync(path.join(workspace, '.agents', 'notes', 'proposed', 'feature', '2026-11-10-z.md')))
check('plan worker cannot write code', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'deny')
check('plan worker can read shell', (await execWith(workerHost, childAgent, 'pwsh', { command: 'Get-ChildItem' })).kind === 'allow')
check('plan worker cannot write shell', (await execWith(workerHost, childAgent, 'pwsh', { command: 'Set-Content docs/x.md x' })).kind === 'deny')
check('plan worker cannot git commit', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git -C . commit -m plan' })).kind === 'deny')
check('plan worker cannot git add', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git add src/x.ts' })).kind === 'deny')
check('plan worker cannot git push', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git push origin main' })).kind === 'deny')
check('plan worker git log --grep commit is read-only', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git log --grep commit' })).kind === 'allow')
check('plan worker git.exe commit is denied', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git.exe commit -m plan' })).kind === 'deny')
check('plan worker global-option checkout is denied', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git -C . checkout main' })).kind === 'deny')
check('plan worker global-option reset is denied', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git --no-pager reset --hard' })).kind === 'deny')
check('main agent can write in orchestrating', (await execWith(workerHost, rootAgent, 'write', { file_path: 'docs/x.md' })).kind === 'allow')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'note-lifecycle', task: 'work', work: 'active' })
check('main agent can write in note-lifecycle', (await execWith(workerHost, rootAgent, 'write', { file_path: 'docs/x.md' })).kind === 'allow')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'complete', task: 'work', work: 'active' })
check('main agent can write in complete', (await execWith(workerHost, rootAgent, 'write', { file_path: 'docs/x.md' })).kind === 'allow')
const rootShellCases = [
  ['discuss', null],
  ['docs', null],
  ['orchestrating', 'plan'],
  ['orchestrating', 'implement'],
  ['reviewing', 'code-review-standalone'],
  ['orchestrating', 'note-lifecycle'],
  ['complete', null],
]
const rootShellChecks = []
for (const [phase, node] of rootShellCases) {
  saveState(workspace, rootAgent, { ...defaultState(), phase, node, task: 'work', work: 'active' })
  rootShellChecks.push((await execWith(workerHost, rootAgent, 'pwsh', { command: 'Set-Content docs/x.md x' })).kind === 'allow')
}
check('root shell-write is denied only in discuss', rootShellChecks[0] === false && rootShellChecks.slice(1).every(Boolean), JSON.stringify(rootShellChecks))
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work' })
check('child cannot call gate_record', (await workerHost.tools.gate_record.execute({ node: 'plan', task: 'x' }, { agent: childAgent })).code === 'root-only')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'implement', task: 'work' })
check('implement worker can write code', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'allow')
check('implement worker can apply_patch code', (await execWith(workerHost, childAgent, 'apply_patch', { input: '*** Begin Patch\n*** Add File: src/y.ts\n+x\n*** End Patch' })).kind === 'allow')
saveState(workspace, rootAgent, { ...defaultState(), phase: 'orchestrating', node: 'code-review', task: 'work' })
check('review worker cannot write', (await execWith(workerHost, childAgent, 'write', { file_path: 'src/x.ts' })).kind === 'deny')
check('review worker cannot shell-write docs', (await execWith(workerHost, childAgent, 'pwsh', { command: 'Set-Content docs/x.md x' })).kind === 'deny')
check('review worker can read shell', (await execWith(workerHost, childAgent, 'pwsh', { command: 'Get-ChildItem' })).kind === 'allow')
check('review worker cannot git push', (await execWith(workerHost, childAgent, 'pwsh', { command: 'git push origin main' })).kind === 'deny')

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
check('gate-init initializes git and base gitignore', initialized.kind === 'success' && existsSync(path.join(initWorkspace, '.git')) && readFileSync(path.join(initWorkspace, '.gitignore'), 'utf8').includes('node_modules/') && initialized.text.includes('git：initialized') && initialized.text.includes('ignore：created'))
const initPolicy = JSON.parse(readFileSync(path.join(initWorkspace, '.agents', 'gate', 'artifact-policy.json'), 'utf8'))
check('gate-init creates artifact policy base', initPolicy.version === 1 && initPolicy.artifacts.handoff && initPolicy.artifacts.prd && initPolicy.artifacts.research)
check('gate-init base gitignore includes scratch', readFileSync(path.join(initWorkspace, '.gitignore'), 'utf8').includes('.scratch/'))
const artifactWrite = await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: '.scratch/prd/one.md', content: '# PRD\n' }, { agent: initAgent })
check('artifact write accepts policy file', artifactWrite.ok === true && existsSync(path.join(initWorkspace, '.scratch', 'prd', 'one.md')))
const artifactBlockedPath = await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: '.agents/gate/artifact-policy.json', content: '{}' }, { agent: initAgent })
check('artifact write rejects reserved policy path', artifactBlockedPath.code === 'artifact-denied')
const artifactCaseReserved = await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: '.AGENTS/gate/artifact-policy.json', content: '{}' }, { agent: initAgent })
check('artifact write rejects case-folded reserved path', artifactCaseReserved.code === 'artifact-denied')
const artifactDoubleSlash = await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: '.agents//notes/x.md', content: 'x' }, { agent: initAgent })
check('artifact write rejects normalized reserved path', artifactDoubleSlash.code === 'artifact-denied')
const artifactOutside = await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: '../outside.md', content: 'x' }, { agent: initAgent })
check('artifact write rejects outside path', artifactOutside.code === 'artifact-denied')
saveState(initWorkspace, initAgent, { ...defaultState(), phase: 'blocked', work: 'blocked', blockReason: 'fixture' })
check('artifact write rejects blocked', (await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: '.scratch/prd/blocked.md', content: 'x' }, { agent: initAgent })).code === 'artifact-denied')
saveState(initWorkspace, initAgent, defaultState())
const prdCommand = await initHost.commands['gate-prd'].handler({ agent: initAgent, rawInput: '产品主题', attachments: [] })
check('gate-prd stays in discuss and requests skill', prdCommand.kind === 'success' && loadState(initWorkspace, initAgent).phase === 'discuss')
const researchCalls = []
const researchHost = fakeHost(initWorkspace, undefined, { subagents: {
  getProvider: () => ({}),
  startActivation: async spec => { researchCalls.push(spec); return { name: 'research-1', result: Promise.resolve({ output: 'research done' }), dispose: async () => {} } },
} })
const research = await researchHost.tools.gate_research_dispatch.execute({ question: 'What is gate?' }, { agent: initAgent, signal: new AbortController().signal })
check('research dispatch starts a caller worker', research.ok === true && researchCalls.length === 1 && researchCalls[0].delivery === 'caller' && researchCalls[0].parent === initAgent)
const customPolicy = { version: 1, artifacts: {
  handoff: { phases: ['discuss'], roles: ['root'], paths: ['.scratch/handoff/exact.md'] },
  prd: { phases: ['discuss'], roles: ['root'], paths: ['docs/prd/*.md'] },
  research: { phases: ['discuss'], roles: ['root', 'worker'], paths: ['.scratch/research/**'] },
} }
const policyFile = path.join(initWorkspace, '.agents', 'gate', 'artifact-policy.json')
writeFileSync(policyFile, JSON.stringify(customPolicy))
await initHost.commands['gate-init'].handler({ agent: initAgent, rawInput: '', attachments: [] })
check('gate-init preserves existing artifact policy', readFileSync(policyFile, 'utf8') === JSON.stringify(customPolicy))
saveState(initWorkspace, initAgent, defaultState())
check('artifact exact file matches', (await initHost.tools.gate_artifact_write.execute({ kind: 'handoff', path: '.scratch/handoff/exact.md', content: 'x' }, { agent: initAgent })).ok === true)
check('artifact exact file rejects sibling', (await initHost.tools.gate_artifact_write.execute({ kind: 'handoff', path: '.scratch/handoff/other.md', content: 'x' }, { agent: initAgent })).code === 'artifact-denied')
check('artifact single-level glob matches direct file', (await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: 'docs/prd/one.md', content: 'x' }, { agent: initAgent })).ok === true)
check('artifact single-level glob rejects nested file', (await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: 'docs/prd/sub/two.md', content: 'x' }, { agent: initAgent })).code === 'artifact-denied')
writeFileSync(policyFile, '{ invalid json')
check('artifact invalid policy fails safe', (await initHost.tools.gate_artifact_write.execute({ kind: 'prd', path: 'docs/prd/one.md', content: 'x' }, { agent: initAgent })).code === 'artifact-policy-invalid')
const manifestWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-init-manifest-'))
const manifestHost = fakeHost(manifestWorkspace)
const manifestAgent = { id: 'session-init-manifest', session: { header: {} } }
const manifestInit = await manifestHost.commands['gate-init'].handler({ agent: manifestAgent, rawInput: '', attachments: [] })
const manifestPath = path.join(manifestWorkspace, '.agents', 'gate', 'init-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
check('gate-init creates init manifest', manifestInit.kind === 'success' && manifestInit.text.includes('init manifest') && manifestInit.text.includes('（created）') && manifest.version === 1 && manifest.createdAt && manifest.updatedAt === undefined && Object.keys(manifest.immutable).length === 6)
check('init manifest hashes CI scripts and launcher', Object.keys(manifest.immutable).some(key => key.endsWith('verify-archived-agent-notes.ts')) && Object.keys(manifest.immutable).some(key => key.endsWith('verify-notes.mjs')))
const manifestCreatedAt = manifest.createdAt
const manifestRerun = await manifestHost.commands['gate-init'].handler({ agent: manifestAgent, rawInput: '', attachments: [] })
const manifestAgain = JSON.parse(readFileSync(manifestPath, 'utf8'))
check('gate-init reports manifest update', manifestRerun.text.includes('（updated）'))
check('init manifest is stable across rerun', manifestAgain.createdAt === manifestCreatedAt && manifestAgain.updatedAt === undefined && JSON.stringify(manifestAgain.immutable) === JSON.stringify(manifest.immutable))
const manifestVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify passes fresh init', manifestVerify.ok === true && manifestVerify.manifest === 'ok' && manifestVerify.artifactPolicy === 'ok' && manifestVerify.notes === 'ok')
const mutatedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
delete mutatedManifest.immutable['.agents/gate/verify-notes.mjs']
writeFileSync(manifestPath, JSON.stringify(mutatedManifest, null, 2) + '\n')
const missingKeyVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify detects deleted immutable entry', missingKeyVerify.ok === false && missingKeyVerify.immutable.some(item => item.status === 'missing'))
writeFileSync(manifestPath, JSON.stringify(manifestAgain, null, 2) + '\n')

const ciFile = path.join(manifestWorkspace, '.agents', 'gate', 'ci', 'agent-note-tree.ts')
const ciOriginal = readFileSync(ciFile, 'utf8')
writeFileSync(ciFile, ciOriginal + '\n// tampered\n')
const ciVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify detects immutable modification', ciVerify.ok === false && ciVerify.immutable.some(item => item.status === 'modified'))
writeFileSync(ciFile, ciOriginal)
const customManifestPolicy = { version: 1, artifacts: { prd: { phases: ['discuss'], roles: ['root'], paths: ['.scratch/prd/**'] } } }
writeFileSync(path.join(manifestWorkspace, '.agents', 'gate', 'artifact-policy.json'), JSON.stringify(customManifestPolicy))
const customPolicyVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify accepts customized policy', customPolicyVerify.ok === true && customPolicyVerify.artifactPolicy === 'customized')
const packagePath = path.join(manifestWorkspace, 'package.json')
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
pkg.scripts['verify-notes'] = 'node custom-verify.mjs'
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')
const customScriptVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify reports custom package script', customScriptVerify.ok === true && customScriptVerify.packageScript === 'customized')
const workflowPath = path.join(manifestWorkspace, '.github', 'workflows', 'verify-notes.yml')
rmSync(workflowPath, { force: true })
const missingWorkflowVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify reports missing workflow as warning', missingWorkflowVerify.ok === true && missingWorkflowVerify.workflow === 'missing' && missingWorkflowVerify.issues.some(issue => issue.code === 'workflow-missing'))
rmSync(path.join(manifestWorkspace, '.agents', 'notes', 'implemented'), { recursive: true, force: true })
const missingNotesVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify detects missing notes tree', missingNotesVerify.ok === false && missingNotesVerify.notes === 'missing')
writeFileSync(path.join(manifestWorkspace, '.agents', 'gate', 'artifact-policy.json'), '{ invalid')
const invalidPolicyVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify detects invalid policy', invalidPolicyVerify.ok === false && invalidPolicyVerify.artifactPolicy === 'invalid')
const staleManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
staleManifest.gateVersion = '0.0.0'
writeFileSync(manifestPath, JSON.stringify(staleManifest, null, 2) + '\n')
const staleVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify reports stale gate version', staleVerify.issues.some(issue => issue.code === 'stale-init'))
writeFileSync(manifestPath, JSON.stringify(manifestAgain, null, 2) + '\n')
writeFileSync(manifestPath, '{ invalid')
const invalidManifestVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify detects invalid manifest', invalidManifestVerify.ok === false && invalidManifestVerify.manifest === 'invalid')
rmSync(manifestPath, { force: true })
const missingManifestVerify = await manifestHost.tools.gate_init_verify.execute({}, { agent: manifestAgent })
check('gate_init_verify detects missing manifest', missingManifestVerify.ok === false && missingManifestVerify.manifest === 'missing')




let gateInitCommitted = false
try {
  execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: initWorkspace, stdio: 'ignore' })
  gateInitCommitted = true
} catch { /* no commits yet is expected */ }
check('gate-init does not create a commit', gateInitCommitted === false)
const existingIgnoreWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-init-ignore-'))
writeFileSync(path.join(existingIgnoreWorkspace, '.gitignore'), 'custom-ignore\n')
const existingIgnoreHost = fakeHost(existingIgnoreWorkspace)
const existingIgnoreInit = await existingIgnoreHost.commands['gate-init'].handler({ agent: initAgent, rawInput: '', attachments: [] })
check('gate-init preserves an existing gitignore', existsSync(path.join(existingIgnoreWorkspace, '.git')) && readFileSync(path.join(existingIgnoreWorkspace, '.gitignore'), 'utf8') === 'custom-ignore\n' && existingIgnoreInit.text.includes('ignore：existing'))
const existingRepoWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-init-repo-'))
execFileSync('git', ['init'], { cwd: existingRepoWorkspace, stdio: 'ignore' })
const existingRepoHost = fakeHost(existingRepoWorkspace)
const existingRepoInit = await existingRepoHost.commands['gate-init'].handler({ agent: initAgent, rawInput: '', attachments: [] })
check('gate-init does not reinitialize an existing repo', existingRepoInit.text.includes('git：existing') && readFileSync(path.join(existingRepoWorkspace, '.gitignore'), 'utf8').includes('node_modules/'))
const unavailableWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-init-no-git-'))
const unavailableHost = fakeHost(unavailableWorkspace)
const oldPath = process.env.PATH
process.env.PATH = path.join(unavailableWorkspace, 'no-such-path')
let unavailableInit
try {
  unavailableInit = await unavailableHost.commands['gate-init'].handler({ agent: initAgent, rawInput: '', attachments: [] })
} finally {
  process.env.PATH = oldPath
}
check('gate-init reports git unavailable without failing notes', unavailableInit.kind === 'success' && unavailableInit.text.includes('git：unavailable') && existsSync(path.join(unavailableWorkspace, '.agents', 'notes', 'proposed')) && existsSync(path.join(unavailableWorkspace, '.gitignore')))
const brokenGitWorkspace = mkdtempSync(path.join(os.tmpdir(), 'gate-init-broken-git-'))
writeFileSync(path.join(brokenGitWorkspace, '.git'), 'not-a-gitdir\n')
const brokenGitHost = fakeHost(brokenGitWorkspace)
const brokenGitInit = await brokenGitHost.commands['gate-init'].handler({ agent: initAgent, rawInput: '', attachments: [] })
check('gate-init reports git init failure with stderr', brokenGitInit.kind === 'success' && brokenGitInit.text.includes('git：init-failed') && brokenGitInit.text.includes('invalid gitfile format'))

const noAutoWorkspace = makeWorkspace()
execFileSync('git', ['init'], { cwd: noAutoWorkspace, stdio: 'ignore' })
execFileSync('git', ['config', 'user.email', 'gate-test@example.com'], { cwd: noAutoWorkspace, stdio: 'ignore' })
execFileSync('git', ['config', 'user.name', 'Gate Test'], { cwd: noAutoWorkspace, stdio: 'ignore' })
const noAutoNote = addTestNote(noAutoWorkspace)
execFileSync('git', ['add', '-A'], { cwd: noAutoWorkspace, stdio: 'ignore' })
execFileSync('git', ['commit', '-m', 'baseline'], { cwd: noAutoWorkspace, stdio: 'ignore' })
const noAutoHost = fakeHost(noAutoWorkspace)
const noAutoAgent = { id: 'session-no-auto-commit', session: { header: {} } }
saveState(noAutoWorkspace, noAutoAgent, { ...defaultState(), phase: 'orchestrating', node: 'note-lifecycle', task: 'work', work: 'active', notePaths: [{ path: noAutoNote, class: 'feature', lifecycle: 'proposed' }], noteVerified: true })
const noAutoDone = await noAutoHost.tools.gate_record.execute({ node: 'note-lifecycle' }, { agent: noAutoAgent })
const noAutoCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: noAutoWorkspace, encoding: 'utf8' }).trim()
check('note-lifecycle does not auto-commit in a git repo', noAutoDone.ok === true && noAutoCount === '1' && noAutoDone.commitHint?.includes('建议提交本次实现') === true)
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
check('projection prompt starts in discuss', projectionSection.text({ agent: projectionAgent }) === staticPrompt && projectionDiscussStatus.procedure?.text.includes('discuss 不派 worker'))
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
check('note-lifecycle prompt is the static methodology', lifecyclePrompt === staticPrompt && (lifecyclePrompt.match(/## orchestrating\/note-lifecycle/gu) ?? []).length === 1 && !lifecyclePrompt.includes('## 技能加载规则'))
const lifecycleStatus = await lifecycleHost.tools.gate_status.execute({}, { agent: lifecycleAgent })
check('note-lifecycle procedure has no dispatch', lifecycleStatus.procedure.text.includes('gate_note_finalize') && !lifecycleStatus.procedure.text.includes('## 技能加载规则'))
check('note-lifecycle gate_status keeps rounds in state', lifecycleStatus.text.includes('rounds：'))
const finalized = await lifecycleHost.tools.gate_note_finalize.execute({}, { agent: lifecycleAgent })
check('gate_note_finalize moves note', finalized.ok === true && existsSync(path.join(lifecycleWorkspace, '.agents', 'notes', 'implemented', 'process', '2026-11-10-feature.md')), JSON.stringify(finalized))
const implementedContent = readFileSync(path.join(lifecycleWorkspace, '.agents', 'notes', 'implemented', 'process', '2026-11-10-feature.md'), 'utf8')
check('finalize preserves multi-line section bodies', implementedContent.includes('ac one') && implementedContent.includes('ac two') && implementedContent.includes('risk two') && implementedContent.includes('decision body') === false && !implementedContent.includes('plan two') && !/^## Plan$/mu.test(implementedContent))
const noteVerified = await lifecycleHost.tools.gate_note_verify.execute({}, { agent: lifecycleAgent })
check('gate_note_verify sets noteVerified', noteVerified.ok === true && noteVerified.state.noteVerified === true)
const lifecycleDone = await lifecycleHost.tools.gate_record.execute({ node: 'note-lifecycle' }, { agent: lifecycleAgent })
check('note-lifecycle returns to discuss', lifecycleDone.ok === true && lifecycleDone.state.phase === 'discuss' && lifecycleDone.state.task === null)
check('note-lifecycle record returns the discuss procedure', lifecycleDone.procedure?.phase === 'discuss' && lifecycleDone.procedure?.node === null && lifecycleDone.procedure?.text.includes('discuss 不派 worker'))
check('note-lifecycle completion returns a commit hint', lifecycleDone.commitHint?.includes('建议提交本次实现') === true)

const selfWorkspace = makeWorkspace()
const selfHost = fakeHost(selfWorkspace)
const selfAgent = { id: 'session-self-note', session: { header: {} } }
const selfPath = addTestNote(selfWorkspace)
const selfRelative = selfPath.replace(/^\.agents\/notes\//u, '')
writeFileSync(path.join(selfWorkspace, selfPath), `# Agent Note: self reference\n\nStatus: proposed\n\n## Problem\n\np\n\n## Proposal\n\nself: ${selfRelative} and ${selfPath}; other: proposed/feature/other.md\n\n## Alternatives considered\n\n- a\n\n## Acceptance criteria\n\n- c\n\n## Risks\n\n- r\n`)
saveState(selfWorkspace, selfAgent, { ...defaultState(), phase: 'orchestrating', node: 'note-lifecycle', task: 'work', work: 'active', notePaths: [{ path: selfPath, class: 'feature', lifecycle: 'proposed' }] })
const selfFinalized = await selfHost.tools.gate_note_finalize.execute({}, { agent: selfAgent })
const selfImplemented = selfPath.replace('/proposed/', '/implemented/')
const selfContent = readFileSync(path.join(selfWorkspace, selfImplemented), 'utf8')
check('finalize replaces its own proposed reference', selfFinalized.ok === true && selfContent.includes(selfImplemented.replace(/^\.agents\/notes\//u, '')) && !selfContent.includes(selfRelative) && !selfContent.includes(selfPath) && selfContent.includes('proposed/feature/other.md'))

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
check('sequence ends with the discuss procedure', sequenceFinalStatus.procedure?.phase === 'discuss' && sequenceFinalStatus.procedure?.node === null && sequenceFinalStatus.procedure?.text.includes('discuss 不派 worker'))

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
























