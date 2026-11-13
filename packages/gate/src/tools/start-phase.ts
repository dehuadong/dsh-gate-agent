import type { GateDeps } from '../runtime/deps.js'
import { enterPhase } from '../runtime/gate.js'
import { procedureFailure, procedureFor, renderProcedureResult } from '../protocol.js'
import { rootAgentOf, resolveGate } from '../runtime/session.js'
import { normalizeState } from '../state.js'
import { accessFor } from '../access.js'
export function registerStartPhase(ctx: any, deps: GateDeps) {
  const { store, reviewLimit, wake } = deps
  ctx.tools.register({
    name: 'gate_start_phase',
    description: '在用户明确授权后从 discuss/complete 进入 plan 或 implement。仅 root agent 可调用；授权可来自对话（包括要求用户再输入 slash command）或 ask_user_question。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node: { type: 'string', enum: ['plan', 'implement'] },
        brief: { type: 'string' },
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
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_start_phase 只能由 root agent 调用。' }
      const gate = resolveGate(ctx, exec.agent)
      const state = store.read(gate.root, exec.agent)
      const fail = (fields: any) => procedureFailure(state, reviewLimit, fields)
      if (args.node !== 'plan' && args.node !== 'implement') return fail({ code: 'invalid-node', reason: 'node 必须是 plan 或 implement。' })
      const direct = args.node === 'implement' && state.planReady !== true
      if (direct) {
        const brief = String(args.brief ?? '').trim()
        if (brief === '') return fail({ code: 'brief-required', reason: '直接 implement 需要一句说明。' })
        state.task = brief
        state.planReady = false
        state.noteDecision = null
        state.notePaths = []
        state.noteSearch = null
        state.noteVerified = false
        state.noteFinalized = false
        state.noteFinalizeRecovery = []
        store.write(gate.root, exec.agent, state)
      }
      const result = enterPhase(ctx, exec.agent, args.node, reviewLimit, store, direct ? state : undefined)
      if (result.kind === 'error') return fail({ code: 'phase-enter-failed', reason: result.text })
      const procedure = procedureFor(result.state!, { reviewLimit })
      return {
        ok: true,
        phase: result.state!.phase,
        node: result.state!.node,
        task: result.state!.task,
        procedure,
        method: procedure.method,
        access: accessFor(normalizeState(result.state!), false),
        state: normalizeState(result.state!),
      }
    },
  })

}
