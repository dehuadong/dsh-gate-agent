import type { GateDeps } from '../runtime/deps.js'
import { normalizeState } from '../state.js'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { GATE_RECORD_NODES, procedureFailure, procedureFor, renderProcedureResult } from '../protocol.js'
import { rootAgentOf, resolveGate } from '../runtime/session.js'
import { classifyPath } from '../classify.js'
import { notePathsForDecision, normalizeNotePaths, validateNotePaths } from '../notes/note-files.js'
import { REVIEW_NODES, bindToolResults, reviewAxesError, workerEvidenceError } from '../runtime/workers.js'
import { accessFor } from '../access.js'
export function registerRecord(ctx: any, deps: GateDeps) {
  const { store, reviewLimit, wake } = deps
  ctx.tools.register({
    name: 'gate_record',
    description: '记录 root agent 派发的节点 worker 结果并推进 gate 状态。worker 节点要求 workerSessionIds；review 节点要求两轴结果；verify 要求 toolResults。仅 root agent 可调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', enum: GATE_RECORD_NODES },
        workerSessionIds: { type: 'array', items: { type: 'string' } },
        reviewAxes: { type: 'object', additionalProperties: true },
        task: { type: 'string' },
        findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
        requiresDiscussion: { type: 'boolean' },
        discussionReason: { type: 'string' },
        notePaths: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: '接受 .agents/notes/<lifecycle>/<class>/...、<lifecycle>/<class>/... 或 <class>/...；state 归一为完整路径。' },
              class: { type: 'string', enum: ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'] },
              lifecycle: { type: 'string', enum: ['proposed', 'implemented'] },
            },
            required: ['path', 'class', 'lifecycle'],
          },
        },
        noteDecision: { type: 'string', enum: ['new', 'update', 'in-place', 'mechanical'] },
        noteSearch: { type: 'string' },
        verification: {
          type: 'object',
          additionalProperties: false,
          properties: {
            commands: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string', description: 'gate workspace 内普通文件路径。' } },
            toolResults: { type: 'array', items: { type: 'string', description: 'verify worker session log 中真实 tool/result 的 call_... id。' } },
            passed: { type: 'boolean' },
          },
          required: ['commands', 'evidence', 'toolResults', 'passed'],
        },
      },
      required: ['node'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => renderProcedureResult(value),
      presentationMeta: (_args: any, value: any) => value?.state === undefined ? { gate: {} } : { gate: { state: value.state } },
    },
    async execute(args: any, exec: any) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_record 只能由 root agent 调用；worker 完成当前 node 后返回 receipt。' }
      const gate = resolveGate(ctx, exec.agent)
      const state = store.read(gate.root, exec.agent)
      const fail = (fields: any) => procedureFailure(state, reviewLimit, fields)

      if (state.phase === 'docs') {
        if (args.node !== 'docs') return fail({ code: 'wrong-node', expected: 'docs', got: args.node ?? null, reason: 'docs 阶段只能通过 gate_record({node:"docs"}) 结束。' })
        state.phase = 'discuss'; state.node = null; state.work = 'active'; state.blockReason = null; state.blockedFrom = null
        store.write(gate.root, exec.agent, state)
        const procedure = procedureFor(state, { reviewLimit })
        return { ok: true, phase: state.phase, node: state.node, procedure, method: procedure.method, access: accessFor(normalizeState(state), false), state: normalizeState(state) }
      }
      if (state.phase !== 'orchestrating' && state.phase !== 'reviewing') {
        return fail({ code: 'not-orchestrating', phase: state.phase, stateSource: store.source, reason: `当前 phase 是 ${state.phase}；先进入对应阶段。` })
      }
      if (state.node !== args.node) return fail({ code: 'wrong-node', expected: state.node ?? null, got: args.node ?? null, reason: `当前节点是 ${state.node ?? '无'}，请求的 node 是 ${args.node ?? '未提供'}。` })

      const axesError = reviewAxesError(args)
      if (axesError !== undefined) return fail(axesError)
      const workerError = await workerEvidenceError(ctx, root, args)
      if (workerError !== undefined) return fail(workerError)

      const topFindings = Array.isArray(args.findings) ? args.findings : []
      const axesFindings = REVIEW_NODES.has(args.node)
        ? [
            ...args.reviewAxes.standards.findings,
            ...args.reviewAxes.spec.findings,
            ...(args.node === 'plan-review' || args.node === 'proposal-review' ? args.reviewAxes.architecture.findings : []),
          ]
        : []
      const findings = [...axesFindings, ...topFindings]
      let commitHint = null
      if (args.requiresDiscussion === true) {
        if (args.node === 'plan-review') state.planReady = false
        state.blockedFrom = { phase: state.phase, node: state.node }
        state.phase = 'blocked'
        state.node = null
        state.work = 'blocked'
        state.blockReason = 'needs-user-decision'
        store.write(gate.root, exec.agent, state)
        const procedure = procedureFor(state, { reviewLimit })
        return { ok: true, phase: state.phase, blockReason: state.blockReason, reason: args.discussionReason ?? null, procedure, method: procedure.method, access: accessFor(normalizeState(state), false), state: normalizeState(state) }
      }
      if (args.node === 'proposal-review') {
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
        state.blockedFrom = null
      } else if (args.node === 'code-review-standalone') {
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
      } else if (args.node === 'plan') {
        if (typeof args.task !== 'string' || args.task.trim() === '') {
          return fail({ code: 'task-required', reason: 'node=plan 必须携带 task（工作项简述；mechanical 用 noteDecision 表示）。' })
        }
        const decision = args.noteDecision
        if (!['new', 'update', 'in-place', 'mechanical'].includes(decision)) {
          return fail({ code: 'note-decision-required', reason: 'node=plan 需要 noteDecision（new/update/in-place/mechanical）。' })
        }
        const optionNotePaths = notePathsForDecision(args.notePaths, decision)
        const noteError = validateNotePaths(gate.root, optionNotePaths, decision)
        if (noteError !== undefined) return fail(noteError)
        state.task = args.task.trim()
        state.notePaths = decision === 'mechanical' ? [] : optionNotePaths
        state.noteDecision = decision
        state.noteSearch = typeof args.noteSearch === 'string' ? args.noteSearch : null
        state.noteVerified = decision === 'mechanical'
        state.node = 'plan-review'
      } else if (args.node === 'plan-revise') {
        if (args.noteDecision !== undefined || args.notePaths !== undefined) {
          const decision = args.noteDecision ?? state.noteDecision
          if (!['new', 'update', 'in-place', 'mechanical'].includes(decision)) {
            return fail({ code: 'note-decision-required', reason: 'plan-revise 需要合法 noteDecision。' })
          }
          const requestedNotePaths = args.notePaths ?? state.notePaths
          const optionNotePaths = notePathsForDecision(requestedNotePaths, decision)
          const noteError = validateNotePaths(gate.root, optionNotePaths, decision)
          if (noteError !== undefined) return fail(noteError)
          state.notePaths = decision === 'mechanical' ? [] : optionNotePaths
          state.noteDecision = decision
          if (typeof args.noteSearch === 'string') state.noteSearch = args.noteSearch
          state.noteVerified = decision === 'mechanical'
        }
        state.node = 'plan-review'
      } else if (args.node === 'plan-review') {
        state.rounds.planReview += 1
        if (findings.length === 0) {
          state.phase = 'discuss'
          state.node = null
          state.planReady = true
          state.work = 'active'
          state.blockReason = null
          commitHint = '建议提交 planning baseline（Note + 计划）'
        } else if (state.rounds.planReview >= reviewLimit) {
          state.exhausted.plan = true
          state.blockedFrom = { phase: 'discuss', node: null }
          state.phase = 'blocked'
          state.node = null
          state.work = 'blocked'
          state.blockReason = 'plan-review-rounds-exhausted'
        } else state.node = 'plan-revise'
      } else if (args.node === 'implement') {
        if (args.noteDecision === 'mechanical') {
          state.noteDecision = 'mechanical'
          state.notePaths = []
          state.noteVerified = true
        } else {
          if (Array.isArray(args.notePaths)) {
            const nextNotePaths = normalizeNotePaths(args.notePaths)
            const noteError = validateNotePaths(gate.root, nextNotePaths, args.noteDecision ?? state.noteDecision)
            if (noteError !== undefined) return fail(noteError)
            state.notePaths = nextNotePaths
          }
          if (['new', 'update', 'in-place'].includes(args.noteDecision)) state.noteDecision = args.noteDecision
        }
        state.node = 'code-review'
      }
      else if (args.node === 'implement-revise') state.node = 'code-review'
      else if (args.node === 'code-review') {
        state.rounds.codeReview += 1
        if (findings.length === 0) state.node = 'verify'
        else if (state.rounds.codeReview >= reviewLimit) {
          state.exhausted.code = true
          state.blockedFrom = { phase: 'discuss', node: null }
          state.phase = 'blocked'
          state.node = null
          state.work = 'blocked'
          state.blockReason = 'code-review-rounds-exhausted'
        } else state.node = 'implement-revise'
      } else if (args.node === 'verify' || args.node === 'verify-standalone') {
        const verification = args.verification
        const commands = Array.isArray(verification?.commands) ? verification.commands.filter((item: any) => typeof item === 'string' && item.trim() !== '') : []
        const evidence = Array.isArray(verification?.evidence) ? verification.evidence.filter((item: any) => typeof item === 'string' && item.trim() !== '') : []
        const toolResults = Array.isArray(verification?.toolResults) ? verification.toolResults.filter((item: any) => typeof item === 'string' && item.trim() !== '') : []
        const unbound = await bindToolResults(ctx, Array.isArray(args.workerSessionIds) ? args.workerSessionIds : [], toolResults)
        if (unbound !== undefined) return fail(unbound)
        const records = []
        const invalidEvidence = []
        for (const item of evidence) {
          const target = classifyPath(gate.workspace, item)
          try {
            if (target.outside || !existsSync(target.absolute) || !lstatSync(target.absolute).isFile()) {
              invalidEvidence.push(item)
              continue
            }
            const bytes = readFileSync(target.absolute)
            records.push({ path: target.relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
          } catch {
            invalidEvidence.push(item)
          }
        }
        if (commands.length === 0 || evidence.length === 0 || toolResults.length === 0 || invalidEvidence.length > 0 || records.length !== evidence.length || typeof verification?.passed !== 'boolean') {
          return fail({ code: 'verification-required', invalidEvidence, commands, evidence, toolResults, reason: 'verify 需要非空 commands、workspace 内的普通 evidence 文件、toolResults，以及明确的 passed。' })
        }
        state.verification = {
          commands,
          evidence: records,
          toolResults,
          passed: verification.passed,
          selfReported: false,
          executionBound: true,
          verifiedAt: new Date().toISOString(),
        }
        if (args.node === 'verify-standalone') {
          state.phase = 'discuss'
          state.node = null
          state.work = 'active'
          state.blockReason = null
          state.blockedFrom = null
        } else if (verification.passed !== true) {
          state.node = 'implement-revise'
          state.noteVerified = false
        } else if (state.noteDecision === 'mechanical') {
          state.noteVerified = true
          state.noteFinalized = true
          commitHint = '建议提交实现'
          state.phase = 'discuss'
          state.node = null
          state.work = 'active'
          state.blockReason = null
          state.blockedFrom = null
          state.task = null
          state.planReady = false
        } else {
          state.phase = 'orchestrating'
          state.node = 'note-lifecycle'
          state.work = 'active'
          state.noteVerified = false
          state.noteFinalized = false
          state.noteFinalizeRecovery = []
        }
      } else if (args.node === 'fix-bug') {
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
        state.blockedFrom = null
        state.task = null
        state.planReady = false
      } else if (args.node === 'note-lifecycle') {
        if (state.noteVerified !== true) {
          return fail({ code: 'note-lifecycle-incomplete', reason: 'note-lifecycle 需要先 gate_note_finalize + gate_note_verify。' })
        }
        commitHint = '建议提交本次实现与 Note'
        state.phase = 'discuss'
        state.node = null
        state.work = 'active'
        state.blockReason = null
        state.blockedFrom = null
        state.task = null
        state.planReady = false
      }
      store.write(gate.root, exec.agent, state)
      const next = normalizeState(state)
      const procedure = procedureFor(next, { reviewLimit })
      return { ok: true, phase: state.phase, node: state.node, rounds: state.rounds, blockReason: state.blockReason, verification: state.verification, procedure, method: procedure.method, access: accessFor(next, false), state: next, ...(commitHint === null ? {} : { commitHint }) }
    },
  })

}
