import type { GateDeps } from '../runtime/deps.js'
import { normalizeState } from '../state.js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { rootAgentOf, resolveGate, effectiveState } from '../runtime/session.js'
import { finalizeNote, recoverFinalize } from '../notes/note-files.js'
import { isInside, pathHasSymlink } from '../notes/fs.js'
import { runNotesScripts } from '../notes/scripts.js'
import { isMechanicalDecision } from '../note-decisions.js'
export function registerNoteTools(ctx: any, deps: GateDeps) {
  const { store, reviewLimit, wake } = deps
  ctx.tools.register({
    name: 'gate_note_write',
    description: '写 proposed Agent Note，或在 planning 原地更新已存在的 implemented Note。仅 planning worker；通用 write/edit/apply_patch 和仓库写被拒绝，只读 shell 可用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '相对 .agents/notes 的路径；proposed/ 可新建，implemented/ 只能编辑已存在文件。' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: any, exec: any) {
      const gate = resolveGate(ctx, exec.agent)
      const effective = effectiveState(ctx, exec.agent, gate, store)
      if (!effective.worker || !['plan', 'plan-revise'].includes(effective.state.node ?? '')) {
        return { ok: false, code: 'planning-only', reason: 'gate_note_write 只允许 planning worker 在 plan/plan-revise 节点使用。' }
      }
      let relative = String(args.path ?? '').replaceAll('\\', '/').replace(/^\.?\//u, '')
      if (relative === '' || relative.includes('..') || path.isAbsolute(relative) || !relative.endsWith('.md')) {
        return { ok: false, code: 'invalid-path' }
      }
      let lifecycle = 'proposed'
      if (relative.startsWith('proposed/')) relative = relative.slice('proposed/'.length)
      else if (relative.startsWith('implemented/')) {
        lifecycle = 'implemented'
        relative = relative.slice('implemented/'.length)
      }
      if (!/^(?:feature|bug-fix|simplification|architecture|process|testing)\/\d{4}-\d{2}-\d{2}-.+\.md$/u.test(relative)) {
        return { ok: false, code: 'invalid-path', reason: '需要 <class>/yyyy-mm-dd-topic.md，或 proposed|implemented/<class>/...。' }
      }
      const base = path.join(gate.root, '.agents', 'notes', String(lifecycle))
      const absolute = path.resolve(base, relative)
      if (!isInside(base, absolute)) return { ok: false, code: 'invalid-path' }
      if (pathHasSymlink(base, absolute)) return { ok: false, code: 'invalid-path' }
      if (lifecycle === 'implemented' && !existsSync(absolute)) {
        return { ok: false, code: 'implemented-must-exist', reason: 'implemented Note 只能原地编辑，不能新建。' }
      }
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, String(args.content ?? ''))
      return { ok: true, path: path.relative(gate.root, absolute).replaceAll('\\', '/'), lifecycle }
    },
  })

  ctx.tools.register({
    name: 'gate_note_verify',
    description: '运行内置 notes 校验；note-lifecycle 中通过后设置 noteVerified。root-only。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => value?.state === undefined ? { gate: {} } : { gate: { state: value.state } },
    },
    async execute(_args: any, exec: any) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_note_verify 只能由 root agent 调用。' }
      const gate = resolveGate(ctx, exec.agent)
      const state = store.read(gate.root, exec.agent)
      const recovered = recoverFinalize(gate.root, String(exec.agent?.session?.id ?? exec.agent?.id ?? 'unknown'))
      if (recovered.length > 0) state.noteFinalizeRecovery = [...state.noteFinalizeRecovery, ...recovered]
      const check = runNotesScripts(gate.root)
      if (!check.ok) return { ...check, state: normalizeState(state) }
      if (state.node === 'note-lifecycle') {
        if (state.noteFinalized !== true) return { ok: false, code: 'note-lifecycle-incomplete', reason: '先调用 gate_note_finalize。', state: normalizeState(state) }
        const implemented = state.notePaths.length > 0 && state.notePaths.every(entry => entry.lifecycle === 'implemented' && existsSync(path.join(gate.root, entry.path)))
        if (!implemented) return { ok: false, code: 'note-lifecycle-incomplete', reason: 'notePaths 尚未全部进入 implemented。', results: check.results, state: normalizeState(state) }
        state.noteVerified = true
        store.write(gate.root, exec.agent, state)
        return { ok: true, noteVerified: true, results: check.results, state: normalizeState(state) }
      }
      return { ok: true, noteVerified: false, results: check.results, state: normalizeState(state) }
    },
  })

  ctx.tools.register({
    name: 'gate_note_finalize',
    description: '把 note-lifecycle 中的 proposed Note 移到 implemented 并更新头块；root-only。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decisionBodies: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { path: { type: 'string' }, body: { type: 'string' } },
            required: ['path', 'body'],
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args: any, value: any) => value?.state === undefined ? { gate: {} } : { gate: { state: value.state } },
    },
    async execute(args: any, exec: any) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_note_finalize 只能由 root agent 调用。' }
      const gate = resolveGate(ctx, exec.agent)
      const state = store.read(gate.root, exec.agent)
      if (state.node !== 'note-lifecycle') return { ok: false, code: 'not-note-lifecycle', reason: '只在 note-lifecycle 节点可用。' }
      if (isMechanicalDecision(state.noteDecision)) {
        state.noteVerified = true
        state.noteFinalized = true
        store.write(gate.root, exec.agent, state)
        return { ok: true, skipped: true, state: normalizeState(state) }
      }
      const sessionId = String(exec.agent?.session?.id ?? exec.agent?.id ?? 'unknown')
      const recovered = recoverFinalize(gate.root, sessionId)
      for (const entry of state.notePaths) {
        if (entry.lifecycle !== 'proposed') continue
        const source = path.join(gate.root, entry.path)
        const targetRelative = entry.path.replaceAll('\\', '/').replace('.agents/notes/proposed/', '.agents/notes/implemented/')
        if (!existsSync(source) && existsSync(path.join(gate.root, targetRelative))) {
          entry.path = targetRelative
          entry.lifecycle = 'implemented'
          recovered.push('adopted-target')
        }
      }
      const moved = []
      const decisionBodies = new Map<string, string>((Array.isArray(args.decisionBodies) ? args.decisionBodies : []).map((item: any): [string, string] => [String(item.path).replaceAll('\\', '/'), String(item.body ?? '')]))
      try {
        for (const entry of state.notePaths) {
          if (entry.lifecycle !== 'proposed') continue
          const original = entry.path.replaceAll('\\', '/')
          const relative = finalizeNote(gate.root, entry, sessionId, decisionBodies.get(original))
          moved.push({ from: original, to: relative })
          entry.path = relative
          entry.lifecycle = 'implemented'
        }
        const finalCheck = runNotesScripts(gate.root)
        if (!finalCheck.ok) throw new Error(`finalize/decisionBodies 后的 notes 校验失败：${JSON.stringify(finalCheck.results)}`)
        state.noteFinalizeRecovery = recovered
        state.noteVerified = false
        state.noteFinalized = true
        store.write(gate.root, exec.agent, state)
        return { ok: true, moved, recovered, state: normalizeState(state) }
      } catch (error) {
        state.noteFinalizeRecovery = recovered
        store.write(gate.root, exec.agent, state)
        return { ok: false, code: 'note-finalize-failed', reason: error instanceof Error ? error.message : String(error), moved, recovered, state: normalizeState(state) }
      }
    },
  })


}









