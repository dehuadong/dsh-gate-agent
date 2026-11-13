import type { GateDeps } from '../runtime/deps.js'
import { resolveGate, rootAgentOf } from '../runtime/session.js'
import { verifyInit } from '../init-manifest.js'

export function registerInitVerify(ctx: any, _deps: GateDeps) {
  ctx.tools.register({
    name: 'gate_init_verify',
    description: 'root-only 只读校验 /gate-init 产物：init-manifest、immutable hash、artifact policy、AGENTS managed block、verify-notes script、workflow、notes 目录。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(_args: any, exec: any) {
      if (rootAgentOf(ctx, exec.agent)?.id !== exec.agent?.id) {
        return { ok: false, code: 'root-only', reason: 'gate_init_verify 只能由 root agent 调用。' }
      }
      const gate = resolveGate(ctx, exec.agent)
      if (gate.root === undefined) return { ok: false, code: 'state-unavailable', reason: '无法确定工作区。' }
      return verifyInit(gate.root)
    },
  })
}
