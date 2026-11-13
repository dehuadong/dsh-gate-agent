/** Pure path and shell-write classification for the gate. */

import path from 'node:path'

export interface PathClassification {
  absolute: string
  relative: string
  outside: boolean
}

export interface ShellAccess {
  write: boolean
  outsideTargets: string[]
}

interface SegmentAccess {
  write: boolean
  outsideTargets: string[]
}

type AssignmentMap = Map<string, string>

/** Classify a file target relative to the workspace root and the session cwd. */
export function classifyPath(root: string, value: unknown, cwd = root): PathClassification {
  const absolute = path.resolve(cwd, String(value ?? ''))
  const relative = path.relative(root, absolute).replaceAll('\\', '/')
  const outside = relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
  return { absolute, relative, outside }
}

/** Explicit write verbs recognized in one shell statement. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
const GIT_FILE_WRITE = new Set(['checkout', 'switch', 'reset', 'clean', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick', 'apply', 'pull'])
const GIT_NON_WRITE = new Set(['status', 'add', 'commit', 'push'])

/** Return every git subcommand in a shell command, skipping global options and their values. */
export function gitSubcommands(command: string): Set<string> {
  const subcommands = new Set<string>()
  for (const segment of String(command).split(/&&|\|\||;|\r?\n|\|/u)) {
    const tokens = [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(match => match[1] ?? match[2] ?? match[3] ?? '')
    const gitIndex = tokens.findIndex(token => /^git(?:\.exe)?$/iu.test(token))
    if (gitIndex < 0) continue
    let index = gitIndex + 1
    while (index < tokens.length) {
      const token = tokens[index] ?? ''
      if (token === '--') { index += 1; break }
      if (!token.startsWith('-')) break
      const option = token.split('=', 1)[0] ?? token
      if (GIT_VALUE_OPTIONS.has(option) && !token.includes('=')) index += 2
      else index += 1
    }
    const subcommand = tokens[index]?.toLowerCase()
    if (subcommand !== undefined) subcommands.add(subcommand)
  }
  return subcommands
}

const WRITE_VERB = /(?:^|[\s;(])(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-Item|mkdir|md|touch|tee|rm|mv|cp|sed\s+-i)\b/iu

function pathArgs(text: string): string[] {
  const beforePipe = String(text).split('|')[0] ?? ''
  return [...beforePipe.matchAll(/(?:'([^']+)'|"([^"]+)"|(\S+))/gu)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter((value): value is string => value !== undefined && !value.startsWith('-'))
}

/** Simple same-command assignment map; anything else stays unresolved. */
function assignments(text: string): AssignmentMap {
  const map: AssignmentMap = new Map()
  for (const match of String(text).matchAll(/(?:^|[;\n])\s*\$?([A-Za-z_]\w*)\s*=\s*(?:'([^']*)'|"([^"]*)"|(\S+))/gu)) {
    const key = match[1]
    if (key !== undefined) map.set(key, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return map
}

function resolveToken(token: string, map: AssignmentMap): string {
  const variable = /^\$([A-Za-z_]\w*)$/u.exec(token)
  if (variable === null) return token
  const key = variable[1]
  return (key === undefined ? token : map.get(key)) ?? token
}

function redirectionTargets(text: string): string[] {
  return [...String(text).matchAll(/(?:^|\s)>{1,2}\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/gu)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter((value): value is string => value !== undefined)
}

/** Files named by a write command after a pipe (`... | tee file`, `... | Set-Content file`). */
function pipeTargets(text: string): string[] {
  const targets: string[] = []
  for (const part of String(text).split('|').slice(1)) {
    const body = part.replace(/^\s*(?:tee|Set-Content|Out-File|Add-Content)\b/iu, '')
    if (body === part) continue
    for (const token of pathArgs(body)) targets.push(token)
  }
  return targets
}

function addTarget(targets: string[], token: string | undefined, map: AssignmentMap): void {
  if (token === undefined || token === '') return
  if (token.startsWith('$')) {
    const resolved = resolveToken(token, map)
    if (resolved !== token) targets.push(resolved)
    return
  }
  targets.push(token)
}

/** Decide one shell statement: which explicit paths it writes. */
function segmentAccess(text: string, root: string, cwd: string, map: AssignmentMap): SegmentAccess {
  const git = gitSubcommands(text)
  if ([...git].some(command => GIT_FILE_WRITE.has(command))) return { write: true, outsideTargets: [] }
  if ([...git].some(command => GIT_NON_WRITE.has(command))) return { write: false, outsideTargets: [] }
  const raw: string[] = []
  const verb = WRITE_VERB.exec(text)
  if (verb !== null) {
    const tail = text.slice(verb.index + verb[0].length)
    for (const token of pathArgs(tail)) addTarget(raw, token, map)
  }
  for (const token of redirectionTargets(text)) addTarget(raw, token, map)
  for (const token of pipeTargets(text)) addTarget(raw, token, map)
  const outsideTargets: string[] = []
  for (const value of raw) {
    const target = classifyPath(root, path.resolve(cwd, value))
    if (target.outside) outsideTargets.push(target.absolute)
  }
  return { write: raw.length > 0 || WRITE_VERB.test(text), outsideTargets }
}

/** Split statements; pipelines stay in one statement. */
function segments(text: string): string[] {
  return String(text).split(/&&|\|\||;|\r?\n/u).map(part => part.trim()).filter(Boolean)
}

/** Summarize explicit writes. */
export function shellAccess(command: string, root: string, cwd = root): ShellAccess {
  const map = assignments(command)
  const parts = segments(command).map(part => segmentAccess(part, root, cwd, map)).filter(item => item.write)
  return {
    write: parts.length > 0,
    outsideTargets: parts.flatMap(item => item.outsideTargets ?? []),
  }
}
