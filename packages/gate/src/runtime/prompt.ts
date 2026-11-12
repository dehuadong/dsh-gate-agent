import { GATE_METHODOLOGY } from '../protocol.js'
import type { GateDeps } from './deps.js'
import { effectiveState, resolveGate } from './session.js'
import { workerProtocol } from './workers.js'

export function installSystemPrompt(ctx: any, deps: GateDeps) {
  ctx.inject(['systemPrompt'], (scope: any) => {
    scope.systemPrompt.section({
      name: 'gate:protocol',
      order: scope.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: (context: any) => {
        const gate = resolveGate(ctx, context.agent)
        const effective = effectiveState(ctx, context.agent, gate, deps.store)
        if (effective.worker) return ['## Gate', 'Gate worker：只执行当前 node，不推进 phase。', workerProtocol(effective.state.node ?? '')].filter(Boolean).join('\n\n')
        return GATE_METHODOLOGY
      },
    })
  })
}
