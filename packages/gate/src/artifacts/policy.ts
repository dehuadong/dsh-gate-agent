import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { GateState } from '../state.js'
import { METHODOLOGY_KEYS, methodologyKeyFor } from '../protocol.js'
import { isInside, pathHasSymlink } from '../notes/fs.js'

export const ARTIFACT_POLICY_PATH = '.agents/gate/artifact-policy.json'

export interface ArtifactRule {
  phases: string[]
  roles: string[]
  paths: string[]
}

export interface ArtifactPolicy {
  version: 1
  artifacts: Record<string, ArtifactRule>
}

export const BASE_ARTIFACT_POLICY: ArtifactPolicy = {
  version: 1,
  artifacts: {
    handoff: { phases: ['*'], roles: ['root'], paths: ['.scratch/handoff/**'] },
    prd: { phases: ['discuss'], roles: ['root'], paths: ['docs/prd/**', '.scratch/prd/**'] },
    research: {
      phases: ['discuss', 'orchestrating/plan'],
      roles: ['root', 'worker'],
      paths: ['docs/research/**', '.scratch/research/**'],
    },
  },
}

const PHASES = new Set<string>(METHODOLOGY_KEYS)


const RESERVED = ['.agents/gate/artifact-policy.json', '.agents/notes/']

function normalizeArtifactPath(value: string): string {
  return path.posix.normalize(String(value).replaceAll('\\', '/').replace(/^\.\//u, ''))
}

function isReservedPath(value: string): boolean {
  const normalized = value.toLowerCase()
  return RESERVED.some(prefix => normalized === prefix || normalized.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
}

export function artifactPolicyText(policy = BASE_ARTIFACT_POLICY): string {
  return `${JSON.stringify(policy, null, 2)}\n`
}

export function provisionArtifactPolicy(root: string): { path: string; status: 'created' | 'existing' } {
  const file = path.join(root, ARTIFACT_POLICY_PATH)
  if (pathHasSymlink(root, file)) throw new Error('artifact policy 路径包含 symlink')
  mkdirSync(path.dirname(file), { recursive: true })
  if (existsSync(file)) return { path: ARTIFACT_POLICY_PATH, status: 'existing' }
  writeFileSync(file, artifactPolicyText())
  return { path: ARTIFACT_POLICY_PATH, status: 'created' }
}

export function parseArtifactPolicy(value: unknown): { policy?: ArtifactPolicy; error?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'artifact policy 必须是对象' }
  const source = value as any
  if (source.version !== 1) return { error: 'artifact policy version 必须为 1' }
  if (source.artifacts === null || typeof source.artifacts !== 'object' || Array.isArray(source.artifacts)) {
    return { error: 'artifact policy artifacts 必须是对象' }
  }
  for (const key of Object.keys(source)) {
    if (key !== 'version' && key !== 'artifacts') return { error: `artifact policy 未知字段：${key}` }
  }
  const artifacts: Record<string, ArtifactRule> = {}
  for (const [kind, raw] of Object.entries(source.artifacts)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: `artifact ${kind} 必须是对象` }
    const rule = raw as any
    for (const key of Object.keys(rule)) {
      if (key !== 'phases' && key !== 'roles' && key !== 'paths') return { error: `artifact ${kind} 未知字段：${key}` }
    }
    if (!Array.isArray(rule.phases) || rule.phases.length === 0 || !rule.phases.every((phase: unknown) => phase === '*' || (typeof phase === 'string' && PHASES.has(phase)))) {
      return { error: `artifact ${kind} phases 非法` }
    }
    if (!Array.isArray(rule.roles) || rule.roles.length === 0 || !rule.roles.every((role: unknown) => role === 'root' || role === 'worker')) {
      return { error: `artifact ${kind} roles 非法` }
    }
    if (!Array.isArray(rule.paths) || rule.paths.length === 0) return { error: `artifact ${kind} paths 非法` }
    const paths: string[] = []
    for (const item of rule.paths) {
      if (typeof item !== 'string' || item.trim() === '') return { error: `artifact ${kind} path 非法` }
      const normalized = normalizeArtifactPath(item)
      if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) return { error: `artifact ${kind} path 越界：${item}` }
      if (isReservedPath(normalized)) return { error: `artifact ${kind} path 是保留路径：${item}` }
      paths.push(normalized)
    }
    artifacts[kind] = { phases: [...rule.phases], roles: [...rule.roles], paths }
  }
  return { policy: { version: 1, artifacts } }
}

export function loadArtifactPolicy(root: string): { policy?: ArtifactPolicy; error?: string } {
  const file = path.join(root, ARTIFACT_POLICY_PATH)
  if (!existsSync(file)) return { error: 'artifact policy 不存在；先运行 /gate-init 并填写 .agents/gate/artifact-policy.json' }
  if (lstatSync(file).isSymbolicLink()) return { error: 'artifact policy 不能是 symlink' }
  try {
    return parseArtifactPolicy(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { error: 'artifact policy 不是有效 JSON' }
  }
}

function segmentMatches(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.split('').map(char => {
    if (char === '*') return '[^/]*'
    if (char === '?') return '[^/]'
    return char.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
  }).join('')}$`, 'u')
  return regex.test(value)
}

function pathMatches(pattern: string, relative: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean)
  const valueParts = relative.split('/').filter(Boolean)
  const walk = (p: number, v: number): boolean => {
    if (p === patternParts.length) return v === valueParts.length
    const part = patternParts[p] ?? ''
    if (part === '**') return walk(p + 1, v) || (v < valueParts.length && walk(p, v + 1))
    if (v >= valueParts.length) return false
    if (!segmentMatches(part, valueParts[v] ?? '')) return false
    return walk(p + 1, v + 1)
  }
  return walk(0, 0)
}

export function artifactRuleAllows(policy: ArtifactPolicy, state: GateState, worker: boolean, kind: string): { rule?: ArtifactRule; error?: string } {
  if (state.phase === 'blocked') return { error: 'blocked 不允许 artifact 写入' }
  const rule = policy.artifacts[kind]
  if (rule === undefined) return { error: `artifact kind 未授权：${kind}` }
  const phaseKey = methodologyKeyFor(state)
  if (!rule.phases.includes('*') && !rule.phases.includes(phaseKey)) return { error: `当前阶段 ${phaseKey} 不允许 artifact ${kind}` }
  if (!rule.roles.includes(worker ? 'worker' : 'root')) return { error: `当前角色不允许 artifact ${kind}` }
  return { rule }
}

export function checkArtifactPath(root: string, rule: ArtifactRule, requested: string, kind: string): { absolute?: string; relative?: string; error?: string } {
  const normalized = normalizeArtifactPath(requested)
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) return { error: 'artifact path 越界' }
  if (isReservedPath(normalized)) return { error: 'artifact path 是保留路径' }
  if (!rule.paths.some(pattern => pathMatches(pattern, normalized))) return { error: `artifact ${kind} path 不在白名单：${requested}` }
  const absolute = path.resolve(root, normalized)
  if (!isInside(root, absolute)) return { error: 'artifact path 越界' }
  if (pathHasSymlink(root, absolute)) return { error: 'artifact path 包含 symlink' }
  return { absolute, relative: path.relative(root, absolute).replaceAll('\\', '/') }
}

export function writeArtifact(root: string, requested: string, content: string): { relative?: string; error?: string } {
  const normalized = normalizeArtifactPath(requested)
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..') || isReservedPath(normalized)) return { error: 'artifact path 被拒绝' }
  const target = path.resolve(root, normalized)
  if (!isInside(root, target)) return { error: 'artifact path 越界' }
  if (pathHasSymlink(root, target)) return { error: 'artifact path 包含 symlink' }
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return { relative: path.relative(root, target).replaceAll('\\', '/') }
}
