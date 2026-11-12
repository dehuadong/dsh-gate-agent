import type { GateDeps } from '../runtime/deps.js'
import { procedureFor, procedureResultText, renderProcedureResult, statusText } from '../protocol.js'
import { rootAgentOf, resolveGate } from '../runtime/session.js'
export function registerStatus(ctx: any, deps: GateDeps) {
  const { store, reviewLimit, wake } = deps
  ctx.tools.register({
    name: 'gate_status',
    description: '读取 Gate 当前状态与当前 procedure（root）。只读；派发 worker 前、推进节点前、compaction 后、失败后恢复时使用。worker 调用返回 root 状态但不返回 root procedure。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(_args: any, exec: any) {
      const root = rootAgentOf(ctx, exec.agent)
      if (exec.agent?.session?.header?.origin === 'subagent' && root?.id === exec.agent?.id) {
        return { ok: false, code: 'root-unresolved', reason: '无法解析 worker 的 root session；不返回 worker 自身的状态。' }
      }
      if (root?.session === undefined) {
        return { ok: false, code: 'root-unresolved', reason: 'root session 不完整；无法读取 Gate 状态。' }
      }
      const gate = resolveGate(ctx, exec.agent)
      if (gate.root === undefined) return { ok: false, code: 'state-unavailable', reason: '无法确定工作区。' }
      const state = store.read(gate.root, root)
      if (root?.id !== exec.agent?.id) {
        return { ok: true, procedure: null, method: null, text: statusText(state, reviewLimit) }
      }
      const procedure = procedureFor(state, { reviewLimit })
      const includeRounds = !procedure.hasRounds
      return {
        ok: true,
        procedure,
        method: procedure.method,
        text: procedureResultText(procedure, statusText(state, reviewLimit, { includeRounds })),
      }
    },
  })

}
