import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { NOTES_SKILL_DIR } from '../paths.js'
import { resolveNodeBinary } from './fs.js'
import type { NotePath } from '../state.js'
import { rmSync } from 'node:fs'

export function runNotesScripts(root: string) {
  const node = resolveNodeBinary()
  if (node === undefined) return { ok: false, code: 'notes-runtime-unavailable', results: [] }
  const notes = path.join(root, '.agents', 'notes')
  const scripts = [
    'verify-agent-note-tree.ts',
    'verify-agent-note-format.ts',
    'verify-agent-note-lifecycle.ts',
    'verify-archived-agent-notes.ts',
  ]
  const results = []
  for (const name of scripts) {
    const script = path.join(NOTES_SKILL_DIR, 'scripts', name)
    try {
      const output = execFileSync(node, [script, '--root', notes], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      results.push({ name, ok: true, output: String(output).trim() })
    } catch (error) {
      return {
        ok: false,
        code: 'note-verification-failed',
        results: [...results, { name, ok: false, output: String((error as any)?.stdout ?? '').trim(), error: String((error as any)?.stderr ?? (error as any)?.message ?? error).trim() }],
      }
    }
  }
  return { ok: true, results }
}


export function runFormatOnNote(root: string, entry: NotePath, content: string) {
  const node = resolveNodeBinary()
  if (node === undefined) return { code: 'notes-runtime-unavailable', reason: '无法定位 Node 可执行文件。' }
  const temp = path.join(root, '.agents', 'notes', `.gate-validate-${randomUUID()}`)
  const relative = path.join(String(entry.lifecycle ?? 'proposed'), String(entry.class ?? 'feature'), path.basename(String(entry.path)))
  try {
    mkdirSync(path.dirname(path.join(temp, relative)), { recursive: true })
    writeFileSync(path.join(temp, relative), content)
    execFileSync(node, [path.join(NOTES_SKILL_DIR, 'scripts', 'verify-agent-note-format.ts'), '--root', temp], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return undefined
  } catch (error) {
    return { code: 'note-format-invalid', path: entry.path, reason: String((error as any)?.stderr ?? (error as any)?.message ?? error).trim() }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}


