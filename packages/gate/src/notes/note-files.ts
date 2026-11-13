import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { NotePath } from '../state.js'
import type { NoteDecision } from '../note-decisions.js'
import { NOTE_DECISION_LIFECYCLE, isMechanicalDecision } from '../note-decisions.js'
import { isInside, pathHasSymlink, resolveNodeBinary } from './fs.js'
import { runFormatOnNote, runNotesScripts } from './scripts.js'
import { NOTES_SKILL_DIR } from '../paths.js'

export interface NoteSection {
  heading: string
  body: string[]
}

export function splitNoteSections(content: string): { preamble: string[]; sections: NoteSection[] } {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n')
  const preamble: string[] = []
  const sections: NoteSection[] = []
  let current: NoteSection | null = null
  let fenced = false
  for (const line of lines) {
    if (/^\s*```/u.test(line)) fenced = !fenced
    if (!fenced && /^## /u.test(line)) {
      current = { heading: line, body: [] }
      sections.push(current)
    } else if (current === null) {
      preamble.push(line)
    } else {
      current.body.push(line)
    }
  }
  return { preamble, sections }
}

export function transformImplemented(content: string): string {
  const { preamble, sections } = splitNoteSections(content)
  const statusIndex = preamble.findIndex(line => /^Status:/u.test(line))
  if (statusIndex >= 0) preamble[statusIndex] = 'Status: implemented'
  const kept: NoteSection[] = []
  const extras: Array<{ heading: string; body: string }> = []
  let hasDecision = false
  let consequences: NoteSection | null = null
  for (const section of sections) {
    if (/^## Proposal\s*$/u.test(section.heading)) {
      section.heading = '## Decision'
      hasDecision = true
    }
    if (/^## Plan\s*$/u.test(section.heading)) continue
    if (/^## Acceptance criteria\s*$/u.test(section.heading)) {
      extras.push({ heading: '### Acceptance criteria', body: section.body.join('\n').trim() })
      continue
    }
    if (/^## Risks\s*$/u.test(section.heading)) {
      extras.push({ heading: '### Risks', body: section.body.join('\n').trim() })
      continue
    }
    if (/^## Consequences\s*$/u.test(section.heading)) consequences = section
    kept.push(section)
  }
  if (!hasDecision) throw new Error('Note 缺少 ## Proposal，无法转成 ## Decision')
  const extraText = extras.filter(item => item.body !== '').map(item => `${item.heading}\n\n${item.body}`).join('\n\n')
  if (extraText !== '') {
    if (consequences === null) {
      consequences = { heading: '## Consequences', body: [] }
      kept.push(consequences)
    }
    consequences.body.push('', extraText)
  }
  const out = [...preamble, ...kept.flatMap(section => [section.heading, ...section.body])]
  return `${out.join('\n').replace(/\s+$/u, '')}\n`
}

export function replaceSectionBody(content: string, heading: string, body: string): string {
  const { preamble, sections } = splitNoteSections(content)
  const target = sections.find(section => section.heading === heading)
  if (target === undefined) throw new Error(`缺少 ${heading}`)
  target.body = ['', body]
  return `${[...preamble, ...sections.flatMap(section => [section.heading, ...section.body])].join('\n').replace(/\s+$/u, '')}\n`
}

export function recoverFinalize(root: string, sessionId: string) {
  const journal = path.join(root, '.agents', 'notes', `.gate-finalize-${sessionId}.json`)
  if (!existsSync(journal)) return []
  let data
  try { data = JSON.parse(readFileSync(journal, 'utf8')) } catch { return [] }
  if (data?.owner !== sessionId) return []
  const recovered = []
  const source = path.join(root, data.source)
  const backup = path.join(root, data.backup)
  const target = path.join(root, data.target)
  try {
    if (existsSync(backup)) {
      if (!existsSync(source) && !existsSync(target)) {
        renameSync(backup, source)
        recovered.push('restored-source')
      } else if (!existsSync(source) && existsSync(target)) {
        const check = runNotesScripts(root)
        if (!check.ok) {
          rmSync(target, { force: true })
          renameSync(backup, source)
          recovered.push('restored-source-after-bad-target')
        } else {
          rmSync(backup, { force: true })
          recovered.push('kept-target')
        }
      } else if (existsSync(source) && !existsSync(target)) {
        rmSync(backup, { force: true })
        recovered.push('removed-backup')
      }
    }
    const temp = typeof data.temp === 'string' ? path.join(root, data.temp) : undefined
    if (!existsSync(backup) && (temp === undefined || !existsSync(temp))) recovered.push('journal-orphan')
    rmSync(journal, { force: true })
  } catch { /* keep journal for manual recovery */ }
  return recovered
}

export function finalizeNote(root: string, entry: NotePath, sessionId: string, decisionBody: string | undefined) {
  const sourceRelative = entry.path.replaceAll('\\', '/')
  const source = path.join(root, sourceRelative)
  const targetRelative = sourceRelative.replace('.agents/notes/proposed/', '.agents/notes/implemented/')
  const target = path.join(root, targetRelative)
  if (existsSync(target)) throw new Error(`目标已存在：${targetRelative}`)
  if (pathHasSymlink(root, source) || pathHasSymlink(root, target)) throw new Error('finalize 路径含 symlink')
  const content = readFileSync(source, 'utf8')
  let next = transformImplemented(content)
  if (typeof decisionBody === 'string' && decisionBody !== '') next = replaceSectionBody(next, '## Decision', decisionBody)
  const sourceFromNotes = sourceRelative.replace(/^\.agents\/notes\//u, '')
  const targetFromNotes = targetRelative.replace(/^\.agents\/notes\//u, '')
  next = next.replaceAll(sourceRelative, targetRelative).replaceAll(sourceFromNotes, targetFromNotes)
  const dir = path.dirname(target)
  mkdirSync(dir, { recursive: true })
  const journalRelative = path.join('.agents', 'notes', `.gate-finalize-${sessionId}.json`).replaceAll('\\', '/')
  const journal = path.join(root, journalRelative)
  const backup = `${source}.gate-backup`
  const temp = path.join(dir, `.gate-finalize-${path.basename(target)}.tmp`)
  writeFileSync(journal, JSON.stringify({ owner: sessionId, source: sourceRelative, target: targetRelative, backup: path.relative(root, backup).replaceAll('\\', '/'), temp: path.relative(root, temp).replaceAll('\\', '/') }, null, 2))
  try {
    writeFileSync(temp, next)
    renameSync(source, backup)
    renameSync(temp, target)
    const check = runNotesScripts(root)
    if (!check.ok) throw new Error(`finalize 后的 notes 校验失败：${JSON.stringify(check.results)}`)
    rmSync(backup, { force: true })
    rmSync(journal, { force: true })
    return targetRelative.replaceAll('\\', '/')
  } catch (error) {
    rmSync(target, { force: true })
    rmSync(temp, { force: true })
    if (existsSync(backup) && !existsSync(source)) renameSync(backup, source)
    rmSync(journal, { force: true })
    throw error
  }
}



export const NOTE_CLASSES = new Set(['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'])

export function noteTopic(file: string) {
  return path.basename(file).replace(/^\d{4}-\d{2}-\d{2}-/u, '').replace(/\.md$/u, '').replace(/-implemented$/u, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
}


export function normalizeNotePaths(value: unknown): NotePath[] {
  if (!Array.isArray(value)) return value as NotePath[]
  return value.map((entry: any): NotePath => {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') return entry as NotePath
    const normalized = entry.path.replaceAll('\\', '/').replace(/^\.\//u, '')
    if (normalized.startsWith('.agents/notes/')) return { ...entry, path: normalized }
    const parts = normalized.split('/')
    if (parts[0] === 'proposed' || parts[0] === 'implemented') return { ...entry, path: `.agents/notes/${normalized}` }
    if (typeof entry.class === 'string' && parts[0] === entry.class && typeof entry.lifecycle === 'string') {
      return { ...entry, path: `.agents/notes/${entry.lifecycle}/${normalized}` }
    }
    return { ...entry, path: normalized }
  })
}

export function notePathsForDecision(value: unknown, decision: NoteDecision): NotePath[] {
  return isMechanicalDecision(decision) ? value as NotePath[] : normalizeNotePaths(value)
}

export function validateNotePaths(root: string, value: NotePath[], decision: NoteDecision) {
  if (isMechanicalDecision(decision)) {
    if (!Array.isArray(value) || value.length !== 0) return { code: 'note-paths-required', reason: 'mechanical 的 notePaths 必须为空。' }
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0) return { code: 'note-paths-required', reason: '非 mechanical 工作项至少需要一个 notePath。' }
  const seenTopics = new Set()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.class !== 'string' || typeof entry.lifecycle !== 'string') {
      return { code: 'invalid-note-path', reason: 'notePaths[] 需要 {path,class,lifecycle}。' }
    }
    if (!NOTE_CLASSES.has(entry.class)) return { code: 'invalid-note-class', class: entry.class }
    if (!['proposed', 'implemented'].includes(entry.lifecycle)) return { code: 'invalid-note-lifecycle', lifecycle: entry.lifecycle }
    const expectedLifecycle = NOTE_DECISION_LIFECYCLE[decision]
    if (expectedLifecycle !== null && entry.lifecycle !== expectedLifecycle) {
      return { code: 'note-decision-mismatch', reason: `${decision} 只能 ${expectedLifecycle}。` }
    }
    const normalized = entry.path.replaceAll('\\', '/')
    if (normalized.startsWith('/') || normalized.includes('..')) return { code: 'invalid-note-path', path: entry.path }
    const parts = normalized.split('/')
    if (parts.length !== 5 || parts[0] !== '.agents' || parts[1] !== 'notes' || parts[2] !== entry.lifecycle || parts[3] !== entry.class) {
      return { code: 'invalid-note-path', path: entry.path, reason: '需要 .agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md。' }
    }
    const filePart = parts[4]
    if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/u.test(String(filePart))) return { code: 'invalid-note-path', path: entry.path, reason: '文件名需要 yyyy-mm-dd-topic.md。' }
    const absolute = path.join(root, ...parts)
    if (!isInside(root, absolute) || pathHasSymlink(root, absolute)) return { code: 'invalid-note-path', path: entry.path, reason: '路径越界或含 symlink。' }
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return { code: 'note-missing', path: entry.path }
    const content = readFileSync(absolute, 'utf8')
    const status = content.match(/^Status:\s*(proposed|implemented)\s*$/mu)?.[1]
    if (status !== entry.lifecycle) return { code: 'note-status-mismatch', path: entry.path, expected: entry.lifecycle, got: status ?? 'missing' }
    const format = runFormatOnNote(root, entry, content)
    if (format !== undefined) return format
    const topic = noteTopic(String(filePart))
    if (seenTopics.has(topic)) return { code: 'note-topic-duplicate', topic, reason: '同一 topic 只能有一篇。' }
    seenTopics.add(topic)
    for (const other of ['proposed', 'implemented', 'rejected']) {
      const dir = path.join(root, '.agents', 'notes', other, entry.class)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md') || name === path.basename(String(filePart))) continue
        if (noteTopic(name) === topic) return { code: 'note-topic-duplicate', topic, other: path.join(dir, name) }
      }
    }
  }
  return undefined
}


