/** Pure path and shell-write classification for the gate. */

import path from 'node:path'

/** Compare paths case-insensitively on Windows/macOS, byte-wise on Linux. */
export function foldPath(value) {
  const text = String(value ?? '').replaceAll('\\', '/').replace(/\/+$/u, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? text.toLowerCase() : text
}

/** Whether `relative` is `base` or below it, using platform case folding. */
export function isWithin(relative, base) {
  const child = foldPath(relative)
  const parent = foldPath(base)
  if (parent === '') return true
  return child === parent || child.startsWith(`${parent}/`)
}

function isCode(relative, policy) {
  const normalized = relative.replace(/[. ]+$/u, '')
  const ext = path.extname(normalized).toLowerCase()
  if (policy.codeExtensions.includes(ext)) return true
  return policy.codePaths.some(entry => entry.endsWith('/')
    ? isWithin(relative, entry.slice(0, -1))
    : foldPath(relative) === foldPath(entry))
}

/** Classify a file target relative to the workspace root and the session cwd. */
export function classifyPath(root, value, policy, cwd = root) {
  const absolute = path.resolve(cwd, String(value ?? ''))
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  const outside = relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
  const protectedPath = !outside && policy.protected.some(entry => isWithin(relative, entry))
  const protectedAncestor = !outside && policy.protected.some(entry => isWithin(entry, relative))
  const protectedTarget = protectedPath || protectedAncestor
  const code = !outside && isCode(relative, policy)
  return {
    absolute,
    relative,
    outside,
    code,
    protected: protectedTarget,
    protectedAncestor,
    docs: !outside && !code && !protectedTarget,
  }
}

/** Explicit write verbs recognized in one shell statement. */
const WRITE_VERB = /(?:^|[\s;(])(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-Item|mkdir|md|touch|tee|rm|mv|cp|sed\s+-i)\b/iu

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

/** Files named by a write command after a pipe (`... | tee file`, `... | Set-Content file`). */
function pipeTargets(text) {
  const targets = []
  for (const part of String(text).split('|').slice(1)) {
    const body = part.replace(/^\s*(?:tee|Set-Content|Out-File|Add-Content)\b/iu, '')
    if (body === part) continue
    for (const token of pathArgs(body)) targets.push(token)
  }
  return targets
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
    return { write: false, forceCode: false, codeTargets: [], protectedTargets: [], outsideTargets: [] }
  }
  if (/\bgit\s+(?:checkout|reset|clean)\b/iu.test(text)) {
    return { write: true, forceCode: true, codeTargets: [], protectedTargets: [], outsideTargets: [] }
  }
  const raw = []
  const verb = WRITE_VERB.exec(text)
  if (verb !== null) {
    const tail = text.slice(verb.index + verb[0].length)
    for (const token of pathArgs(tail)) addTarget(raw, token, map)
  }
  for (const token of redirectionTargets(text)) addTarget(raw, token, map)
  for (const token of pipeTargets(text)) addTarget(raw, token, map)
  const codeTargets = []
  const protectedTargets = []
  const outsideTargets = []
  for (const value of raw) {
    const target = classifyPath(root, path.resolve(cwd, value), policy)
    if (target.outside) { outsideTargets.push(target.absolute); continue }
    if (target.protected) protectedTargets.push(target.relative)
    if (target.code) codeTargets.push(target.relative)
  }
  return { write: raw.length > 0 || WRITE_VERB.test(text), forceCode: false, codeTargets, protectedTargets, outsideTargets }
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
    codeTargets: parts.flatMap(item => item.codeTargets ?? []),
    protectedTargets: parts.flatMap(item => item.protectedTargets ?? []),
    outsideTargets: parts.flatMap(item => item.outsideTargets ?? []),
  }
}
