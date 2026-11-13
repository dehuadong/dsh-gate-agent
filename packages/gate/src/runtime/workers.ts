import type { GateState } from '../state.js'
import type { GateDeps } from './deps.js'
import { WORKER_NODES } from '../protocol.js'

export function workerProtocol(node: string) {
  return [
    '## Gate worker',
    '你是 gate 为该节点派发的 worker。只执行该节点；不要调用 gate_record，不要推进 gate。',
    node === 'verify-standalone'
      ? '加载使用 gate-user-verify 完成验收，并按该技能 Step 6 汇报。任务与汇报模板见该技能 assets/worker-briefs/gate-code-verify.md。不修改产品代码、测试、需求或设计；可以运行测试/命令作为证据，但不得修改、放宽或重写测试；不要自行提交。'
      : node === 'fix-bug'
        ? '主代理已读取 gate-fix-bug；你执行 gate-fix-bug 的 Process 1-9（复现、回归覆盖、根因、最小修复、测试），返回修复 receipt；不要自行完成 Step 10-12，不要提交。不改产品合同、不扩大范围。'
        : '主代理已经加载所需 gate 技能，并把具体任务与相关方法要求交给你。不要自己加载 gate 技能。',
    node === 'plan' || node === 'plan-revise'
      ? '用 gate_note_write 在 .agents/notes/proposed 下创建或更新 proposed Agent Note；原地同步既有 implemented Note 时路径写 implemented/<class>/...；planning 中 write/edit/apply_patch 和仓库写被拒绝，只读 shell 可用。'
      : '',
  ].filter(Boolean).join('\n\n')
}


export const REVIEW_NODES = new Set(['plan-review', 'proposal-review', 'code-review', 'code-review-standalone'])

export function reviewAxesError(args: any) {
  if (!REVIEW_NODES.has(args.node)) return undefined
  const axes = args.reviewAxes
  const required = args.node === 'plan-review' || args.node === 'proposal-review' ? ['standards', 'spec', 'architecture'] : ['standards', 'spec']
  if (axes === null || typeof axes !== 'object' || Array.isArray(axes)) return { code: 'review-axes-required', reason: `review 节点需要 ${required.join('、')} 轴结果。` }
  for (const axis of required) {
    const value = axes[axis]
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.findings)) {
      return { code: 'review-axes-required', reason: `${axis} 轴需要 findings 数组。` }
    }
  }
  return undefined
}

export async function workerEvidenceError(ctx: any, root: any, args: any) {
  if (!WORKER_NODES.has(args.node)) return undefined
  const ids = Array.isArray(args.workerSessionIds)
    ? [...new Set(args.workerSessionIds.filter((value: any) => typeof value === 'string' && value !== ''))]
    : []
  if (ids.length === 0) return { code: 'worker-required', reason: 'gate_record 需要 workerSessionIds；没有 worker 不能推进。' }
  const service = ctx.get('subagents')
  if (service === undefined || typeof service.listDescendants !== 'function') {
    return { code: 'worker-evidence-unavailable', reason: 'subagents.listDescendants 不可用，无法验证 worker。' }
  }
  let entries
  try {
    entries = await service.listDescendants(root.id)
  } catch {
    return { code: 'worker-evidence-unavailable', reason: '读取 subagent tree 失败，无法验证 worker。' }
  }
  const children = Array.isArray(entries) ? entries.filter(entry => entry?.kind === 'child') : []
  for (const id of ids) {
    const row = children.find(entry => String(entry.id) === String(id))
    if (row === undefined) return { code: 'worker-not-descendant', workerSessionId: id, reason: 'workerSessionId 不在当前 root 的 subagent tree 中。' }
  }
  return undefined
}

export async function bindToolResults(ctx: any, workerSessionIds: string[], toolResults: string[]) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.readSession !== 'function') {
    return { code: 'verification-required', reason: 'sessionQuery 不可用，无法绑定 toolResults。' }
  }
  const found = new Set()
  for (const sessionId of workerSessionIds) {
    try {
      const snapshot = await query.readSession(sessionId)
      for (const event of snapshot?.events ?? []) {
        if (event?.type !== 'tool/result') continue
        const callId = event.data?.message?.toolCallId ?? event.data?.callId
        if (callId !== undefined) found.add(String(callId))
      }
    } catch { /* one unreadable worker session cannot prove its results */ }
  }
  const missing = toolResults.filter((id: any) => !found.has(String(id)))
  if (missing.length > 0) {
    return { code: 'verification-required', unboundToolResults: missing, reason: 'toolResults 未在 worker session log 中找到。' }
  }
  return undefined
}

