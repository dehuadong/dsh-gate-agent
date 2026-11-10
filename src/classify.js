/** Pure decisions for the implement gate; the Host plugin owns state and dispatch. */

import path from 'node:path'

/** Normalize a user message before exact gate matching. */
export function normalizeMessage(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

/** Compare paths case-insensitively on Windows/macOS, byte-wise on Linux. */
export function foldPath(value) {
  const text = String(value ?? '').replaceAll('\\', '/').replace(/\/+$/u, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? text.toLowerCase() : text
}

/** Whether `relative` is `base` or below it, using platform case folding. */
export function isWithin(relative, base) {
  const child = foldPath(relative)
  const parent = foldPath(base)
  return child === parent || child.startsWith(`${parent}/`)
}

/** Match a gate command only from an owner-authored, whole user message. */
export function gateCommand(message, header, commands) {
  if (message === undefined || message === null) return undefined
  if (message.source?.kind !== 'user' || message.source.principal !== undefined) return undefined
  if (header?.origin === 'subagent') return undefined
  const text = normalizeMessage((message.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join(''))
  for (const kind of ['implement', 'planning', 'docs']) {
    const pattern = commands?.[kind]
      ?? (kind === 'docs' ? /^批准，执行文档治理\s+(.+)$/u : undefined)
    if (pattern === undefined) continue
    const match = pattern.exec(text)
    if (match === null || match[0] !== text || match[1] === undefined || match[1].trim() === '') continue
    return { kind, task: match[1].trim() }
  }
  return undefined
}

function isCode(relative, policy) {
  const normalized = relative.replace(/[. ]+$/u, '')
  const ext = path.extname(normalized).toLowerCase()
  if (policy.codeExtensions.includes(ext)) return true
  return policy.codePaths.some(entry => entry.endsWith('/')
    ? isWithin(relative, entry.slice(0, -1))
    : foldPath(relative) === foldPath(entry))
}

function isProtected(relative, policy) {
  return policy.protected.some(entry => isWithin(relative, entry))
}

/** Classify a file target relative to the workspace root. */
export function classifyPath(root, value, policy) {
  const absolute = path.resolve(root, String(value ?? ''))
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  const outside = relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
  const proposed = !outside && policy.proposed !== undefined && isWithin(relative, policy.proposed)
  const protectedPath = !outside && isProtected(relative, policy)
  const code = !outside && isCode(relative, policy)
  return {
    absolute,
    relative,
    outside,
    proposed,
    code,
    protected: protectedPath,
    docs: !outside && !code && !protectedPath,
  }
}

const WRITE_VERB = /(?:^|[\s;(])(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-Item|rm|mv|cp|sed\s+-i)\b/iu

function pathArgs(text) {
  const beforePipe = String(text).split('|')[0]
  return [...beforePipe.matchAll(/(?:'([^']+)'|"([^"]+)"|(\S+))/gu)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter(value => value !== undefined && !value.startsWith('-'))
}

/** Simple same-command assignment map; anything else stays unresolved. */
function assignments(text) {
  const map = new Map()
  for (const match of String(text).matchAll(/(?:^|[;\n])\s*\$?([A-Za-z_]\w*)\s*=\s*(?:'([^']*)'|"([^"]*)"|(\S+))/gu)) {
    map.set(match[1], match[2] ?? match[3] ?? match[4])
  }
  return map
}

function resolveToken(token, map) {
  const variable = /^\$([A-Za-z_]\w*)$/u.exec(token)
  if (variable === null) return token
  return map.get(variable[1]) ?? token
}

function redirectionTargets(text) {
  return [...String(text).matchAll(/(?:^|\s)>{1,2}\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/gu)]
    .map(match => match[1] ?? match[2] ?? match[3])
}

function addTarget(targets, token, map) {
  if (token === undefined || token === '') return
  if (token.startsWith('$')) {
    const resolved = resolveToken(token, map)
    if (resolved !== token) targets.push(resolved)
    return
  }
  targets.push(token)
}

/** Decide one shell statement: which explicit paths it writes and whether it is code. */
function segmentAccess(text, root, policy, cwd, map) {
  if (/\bgit\s+(?:status|add|commit|push)\b/iu.test(text)) {
    return { write: false, forceCode: false, targets: [], codeTargets: [], protectedTargets: [], outsideTargets: [] }
  }
  if (/\bgit\s+(?:checkout|reset|clean)\b/iu.test(text)) {
    return { write: true, forceCode: true, targets: [], codeTargets: [], protectedTargets: [], outsideTargets: [] }
  }
  const raw = []
  const trash = /(?:^|\s)(?:node\s+)?[^\s]*trash\.mjs\b([\s\S]*)$/iu.exec(text)
  if (trash !== null) {
    for (const token of pathArgs(trash[1])) addTarget(raw, token, map)
  } else {
    const verb = WRITE_VERB.exec(text)
    if (verb !== null) {
      const tail = text.slice(verb.index + verb[0].length)
      for (const token of pathArgs(tail)) addTarget(raw, token, map)
    }
    for (const token of redirectionTargets(text)) addTarget(raw, token, map)
  }
  const targets = []
  const codeTargets = []
  const protectedTargets = []
  const outsideTargets = []
  const docsTargets = []
  for (const value of raw) {
    const target = classifyPath(root, path.resolve(cwd, value), policy)
    if (target.outside) { outsideTargets.push(target.absolute); continue }
    targets.push(target.absolute)
    if (target.protected) protectedTargets.push(target.relative)
    if (target.code) codeTargets.push(target.relative)
    if (target.docs) docsTargets.push(target.relative)
  }
  return { write: raw.length > 0 || WRITE_VERB.test(text), forceCode: false, targets, codeTargets, protectedTargets, outsideTargets, docsTargets }
}

/** Split statements; pipelines stay in one statement. */
function segments(text) {
  return String(text).split(/&&|\|\||;|\r?\n/u).map(part => part.trim()).filter(Boolean)
}

/** Summarize explicit writes and whether any target is code. */
export function shellAccess(command, root, policy, cwd = root) {
  const map = assignments(command)
  const parts = segments(command).map(part => segmentAccess(part, root, policy, cwd, map)).filter(item => item.write)
  return {
    write: parts.length > 0,
    forceCode: parts.some(item => item.forceCode),
    targets: parts.flatMap(item => item.targets ?? []),
    codeTargets: parts.flatMap(item => item.codeTargets ?? []),
    protectedTargets: parts.flatMap(item => item.protectedTargets ?? []),
    outsideTargets: parts.flatMap(item => item.outsideTargets ?? []),
    docsTargets: parts.flatMap(item => item.docsTargets ?? []),
  }
}
