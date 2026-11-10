import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const MARKER = '.agents/gate.json'
export const STATE_DIR = '.agents/state/gate'
export const PROJECT_ANCHOR = '.git'
export const DEFAULT_PROTECTED = [MARKER, STATE_DIR]
export const DEFAULT_CODE_EXTENSIONS = [
  '.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.rb', '.php', '.swift', '.scala', '.lua', '.sh', '.ps1', '.sql',
  '.css', '.scss', '.html', '.vue', '.svelte', '.astro',
]
const ALLOWED = new Set(['enabled', 'version', 'codeExtensions', 'codePaths', 'protected'])

function nearest(start, marker) {
  let current = path.resolve(start)
  for (;;) {
    if (existsSync(path.join(current, marker))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function findGateRoot(workspace) {
  return nearest(workspace, MARKER)
}

export function findProjectRoot(workspace) {
  return nearest(workspace, PROJECT_ANCHOR)
}

function normalizePath(value, trailing = false) {
  if (typeof value !== 'string') return undefined
  let text = value.trim().replaceAll('\\', '/')
  if (text === '' || text === '.' || text.startsWith('//')) return undefined
  const slash = trailing && text.endsWith('/')
  text = text.replace(/\/+$/u, '')
  if (text === '' || text === '.') return undefined
  if (path.isAbsolute(text) || /^[A-Za-z]:/u.test(text)) return undefined
  if (text.split('/').includes('..') || /[*?[\]{}]/u.test(text)) return undefined
  return slash ? `${text}/` : text
}

function normalizeList(value, trailing = false) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    const normalized = normalizePath(item, trailing)
    if (normalized === undefined) return undefined
    if (!out.includes(normalized)) out.push(normalized)
  }
  return out
}

function normalizeExtensions(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    const text = item.trim().toLowerCase()
    if (!/^\.[a-z0-9]+$/u.test(text)) return undefined
    if (!out.includes(text)) out.push(text)
  }
  return out
}

export function validateConfig(value, configPath) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', configPath, reason: 'must be an object' }
  if (value.enabled === false) return { kind: 'disabled', configPath }
  if (value.enabled !== true) return { kind: 'invalid', configPath, reason: 'enabled must be true' }
  if (Object.keys(value).some(key => !ALLOWED.has(key))) return { kind: 'invalid', configPath, reason: 'unknown key' }
  if (value.version !== 2) return { kind: 'invalid', configPath, reason: 'version must be 2' }
  const codeExtensions = value.codeExtensions === undefined ? DEFAULT_CODE_EXTENSIONS : normalizeExtensions(value.codeExtensions)
  if (codeExtensions === undefined) return { kind: 'invalid', configPath, reason: 'codeExtensions must be non-empty' }
  const codePaths = value.codePaths === undefined ? [] : normalizeList(value.codePaths, true)
  if (codePaths === undefined) return { kind: 'invalid', configPath, reason: 'codePaths must be relative paths' }
  const extraProtected = value.protected === undefined ? [] : normalizeList(value.protected)
  if (extraProtected === undefined) return { kind: 'invalid', configPath, reason: 'protected must be relative paths' }
  return {
    kind: 'ok',
    configPath,
    policy: { version: 2, codeExtensions, codePaths, protected: [...new Set([...DEFAULT_PROTECTED, ...extraProtected])] },
  }
}

export function loadConfig(root) {
  const configPath = path.join(root, MARKER)
  let value
  try {
    value = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return { kind: 'invalid', configPath, reason: 'marker is not valid JSON' }
  }
  return validateConfig(value, configPath)
}
