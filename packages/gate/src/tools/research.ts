import type { GateDeps } from '../runtime/deps.js'
import { effectiveState, resolveGate, rootAgentOf } from '../runtime/session.js'
import { artifactRuleAllows, loadArtifactPolicy } from '../artifacts/policy.js'

export function registerResearchDispatch(ctx: any, deps: GateDeps) {
  const { store } = deps
  ctx.tools.register({
    name: 'gate_research_dispatch',
    description: 'root-only：在 discuss 或 orchestrating/plan 派 research worker，等待结果；worker 只能通过 artifact policy 写 research 文档。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        purpose: { type: 'string' },
      },
      required: ['question'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(args: any, exec: any) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_research_dispatch 只能由 root agent 调用。' }
      const gate = resolveGate(ctx, exec.agent)
      if (gate.root === undefined) return { ok: false, code: 'state-unavailable', reason: '无法确定工作区。' }
      const state = store.read(gate.root, root)
      if (!(state.phase === 'discuss' || (state.phase === 'orchestrating' && state.node === 'plan'))) {
        return { ok: false, code: 'wrong-phase', reason: 'research dispatch 只允许 discuss 或 orchestrating/plan。' }
      }
      const loaded = loadArtifactPolicy(gate.root)
      if (loaded.policy === undefined) return { ok: false, code: 'artifact-policy-invalid', reason: loaded.error }
      const allowed = artifactRuleAllows(loaded.policy, state, true, 'research')
      if (allowed.rule === undefined) return { ok: false, code: 'artifact-denied', reason: allowed.error }
      const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
      if (subagents?.startActivation === undefined || subagents?.getProvider === undefined) {
        return { ok: false, code: 'subagents-unavailable', reason: 'ctx.subagents 不可用，无法派 research worker。' }
      }
      const provider = subagents.getProvider('spawn')
      if (provider === undefined) return { ok: false, code: 'provider-unavailable', reason: 'ctx.subagents 没有 spawn provider。' }
      const question = String(args?.question ?? '').trim()
      if (question === '') return { ok: false, code: 'question-required', reason: 'research 需要 question。' }
      const purpose = String(args?.purpose ?? '').trim()
      const prompt = [{
        type: 'text',
        text: [
          'Research worker task. Investigate primary sources and write a Markdown report.',
          `Question: ${question}`,
          purpose === '' ? '' : `Purpose: ${purpose}`,
          'Use gate_artifact_write({ kind: \'research\', path, content }) to save the report.',
          'Prefer project docs research location; otherwise .scratch/research/. Cite sources. Do not modify product code.',
        ].filter(Boolean).join('\n'),
      }]
      let activation: any
      try {
        activation = await subagents.startActivation({
          provider: 'spawn',
          label: 'gate-research',
          prompt,
          parent: exec.agent,
          signal: exec.signal,
          delivery: 'caller',
        })
        const result = await activation.result
        const output = result?.output
        const text = typeof output === 'string' ? output : JSON.stringify(output ?? result)
        return { ok: true, name: activation.name, text }
      } catch (error) {
        return { ok: false, code: 'research-dispatch-failed', reason: error instanceof Error ? error.message : String(error) }
      } finally {
        if (activation?.dispose !== undefined) {
          try { await activation.dispose() } catch { /* result already captured */ }
        }
      }
    },
  })
}
