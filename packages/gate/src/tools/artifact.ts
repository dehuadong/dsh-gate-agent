import type { GateDeps } from '../runtime/deps.js'
import { effectiveState, resolveGate } from '../runtime/session.js'
import { artifactRuleAllows, checkArtifactPath, loadArtifactPolicy, writeArtifact } from '../artifacts/policy.js'

export function registerArtifactTools(ctx: any, deps: GateDeps) {
  const { store } = deps
  ctx.tools.register({
    name: 'gate_artifact_write',
    description: '按 .agents/gate/artifact-policy.json 写白名单 artifact（handoff/prd/research 等）。只写文件，不走普通 workspace write 权限。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', description: 'policy 中的 artifact kind。' },
        path: { type: 'string', description: 'workspace 内相对路径。' },
        content: { type: 'string' },
      },
      required: ['kind', 'path', 'content'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(args: any, exec: any) {
      const gate = resolveGate(ctx, exec.agent)
      if (gate.root === undefined) return { ok: false, code: 'state-unavailable', reason: '无法确定工作区。' }
      const effective = effectiveState(ctx, exec.agent, gate, store)
      const loaded = loadArtifactPolicy(gate.root)
      if (loaded.policy === undefined) return { ok: false, code: 'artifact-policy-invalid', reason: loaded.error }
      const allowed = artifactRuleAllows(loaded.policy, effective.state, effective.worker, String(args?.kind ?? ''))
      if (allowed.rule === undefined) return { ok: false, code: 'artifact-denied', reason: allowed.error }
      const checked = checkArtifactPath(gate.root, allowed.rule, String(args?.path ?? ''), String(args?.kind ?? ''))
      if (checked.absolute === undefined) return { ok: false, code: 'artifact-denied', reason: checked.error }
      const written = writeArtifact(gate.root, checked.relative ?? String(args?.path ?? ''), String(args?.content ?? ''))
      if (written.relative === undefined) return { ok: false, code: 'artifact-write-failed', reason: written.error }
      return { ok: true, kind: String(args.kind), path: written.relative, bytes: Buffer.byteLength(String(args.content ?? '')) }
    },
  })
}
