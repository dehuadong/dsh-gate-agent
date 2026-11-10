/**
 * Lifecycle check for Agent Notes: one topic, one active lifecycle.
 *
 * This is the generic part of the rule; it does not read the capability ledger.
 * A project may add a wrapper for product-specific status.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : process.argv.find(arg => arg.startsWith('--root='))?.slice('--root='.length) ?? '.agents/notes'
const LIFEcycles = ['proposed', 'implemented', 'rejected']
const STATUS = { proposed: 'proposed', implemented: 'implemented', rejected: 'rejected' }
const errors = []
const byTopic = new Map()

function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
}

function topicOf(file) {
  const base = path.basename(file, '.md')
  return normalize(base.replace(/^\d{4}-\d{2}-\d{2}-/u, '').replace(/-implemented$/u, ''))
}

function walk(lifecycle) {
  const dir = path.join(ROOT, lifecycle)
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name)
      for (const nested of readdirSync(sub, { withFileTypes: true })) {
        if (nested.isFile() && nested.name.endsWith('.md')) files.push(path.join(sub, nested.name))
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path.join(dir, entry.name))
    }
  }
  return files
}

for (const lifecycle of LIFEcycles) {
  for (const file of walk(lifecycle)) {
    const topic = topicOf(file)
    if (topic === '') {
      errors.push(`${file}: 无法从文件名得到 topic`)
      continue
    }
    const status = /^Status:\s*(\S+)/mu.exec(readFileSync(file, 'utf8'))?.[1]
    if (status !== STATUS[lifecycle]) {
      errors.push(`${file}: Status=${String(status)}，目录要求 ${STATUS[lifecycle]}`)
    }
    const entry = byTopic.get(topic) ?? []
    entry.push({ lifecycle, file })
    byTopic.set(topic, entry)
  }
}

for (const [topic, entries] of byTopic) {
  if (entries.length > 1) {
    errors.push(`${topic}: 同主题多份（${entries.map(entry => `${entry.lifecycle}:${path.basename(entry.file)}`).join('；')}）`)
  }
  const lifecycles = new Set(entries.map(entry => entry.lifecycle))
  if (lifecycles.has('proposed') && lifecycles.has('implemented')) {
    errors.push(`${topic}: proposed 与 implemented 不能并存`)
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL ${error}`)
  process.exit(1)
}
console.log(`ok: ${byTopic.size} note topics, one lifecycle each`)
