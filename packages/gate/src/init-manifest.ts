import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { NOTES_CI_SCRIPTS, PACKAGE_ROOT } from './paths.js'
import { parseArtifactPolicy } from './artifacts/policy.js'

export const INIT_MANIFEST_PATH = '.agents/gate/init-manifest.json'
const ARTIFACT_POLICY_PATH = '.agents/gate/artifact-policy.json'
const AGENTS_BLOCK = /<!-- gate-notes:start -->[\s\S]*?<!-- gate-notes:end -->/u

export interface InitManifest {
  version: 1
  gateVersion: string
  createdAt: string
  immutable: Record<string, string>
  managed: {
    artifactPolicy: { path: string; schemaVersion: 1; sha256: string }
    agentsBlockHash: string | null
    packageScript: string | null
    workflow: string
  }
  notes: { path: string; lifecycles: string[] }
}

function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function sha256File(file: string): string | null {
  try { return sha256Bytes(readFileSync(file)) } catch { return null }
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch { return 'unknown' }
}

function currentAgentsBlock(root: string): string | null {
  try {
    const text = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
    return AGENTS_BLOCK.exec(text)?.[0] ?? null
  } catch { return null }
}

function readManifest(root: string): InitManifest | null {
  try {
    const value = JSON.parse(readFileSync(path.join(root, INIT_MANIFEST_PATH), 'utf8'))
    if (value === null || typeof value !== 'object' || value.version !== 1) return null
    if (typeof value.createdAt !== 'string' || typeof value.gateVersion !== 'string') return null
    if (value.immutable === null || typeof value.immutable !== 'object' || Array.isArray(value.immutable)) return null
    if (value.managed === null || typeof value.managed !== 'object' || Array.isArray(value.managed)) return null
    if (value.notes === null || typeof value.notes !== 'object' || Array.isArray(value.notes)) return null
    return value as InitManifest
  } catch { return null }
}

export function immutablePaths(): string[] {
  return [
    ...NOTES_CI_SCRIPTS.map(name => `.agents/gate/ci/${name}`),
    '.agents/gate/verify-notes.mjs',
  ]
}

export function provisionInitManifest(root: string, packageScript: string): { path: string; manifest: InitManifest; status: 'created' | 'updated' } {
  const previous = readManifest(root)
  const createdAt = typeof previous?.createdAt === 'string' ? previous.createdAt : new Date().toISOString()
  const immutable: Record<string, string> = {}
  for (const relative of immutablePaths()) {
    const hash = sha256File(path.join(root, relative))
    if (hash !== null) immutable[relative] = hash
  }
  const policyFile = path.join(root, ARTIFACT_POLICY_PATH)
  const policyHash = sha256File(policyFile) ?? sha256Bytes('')
  const block = currentAgentsBlock(root)
  let pkgScript: string | null = null
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    pkgScript = typeof pkg.scripts?.['verify-notes'] === 'string' ? pkg.scripts['verify-notes'] : null
  } catch { /* missing package is handled by verify */ }
  const manifest: InitManifest = {
    version: 1,
    gateVersion: packageVersion(),
    createdAt,
    immutable,
    managed: {
      artifactPolicy: { path: ARTIFACT_POLICY_PATH, schemaVersion: 1, sha256: policyHash },
      agentsBlockHash: block === null ? null : sha256Bytes(block),
      packageScript: pkgScript ?? packageScript,
      workflow: '.github/workflows/verify-notes.yml',
    },
    notes: { path: '.agents/notes', lifecycles: ['proposed', 'implemented', 'rejected', 'archived'] },
  }
  mkdirSync(path.dirname(path.join(root, INIT_MANIFEST_PATH)), { recursive: true })
  writeFileSync(path.join(root, INIT_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`)
  return { path: INIT_MANIFEST_PATH, manifest, status: previous === null ? 'created' : 'updated' }
}

export function verifyInit(root: string) {
  const manifest = readManifest(root)
  const issues: Array<{ severity: 'error' | 'warning'; code: string; message: string }> = []
  const immutable: Array<{ path: string; status: 'ok' | 'missing' | 'modified' | 'unknown' }> = []
  for (const relative of immutablePaths()) {
    const actual = sha256File(path.join(root, relative))
    const expected = manifest?.immutable?.[relative]
    if (actual === null) {
      immutable.push({ path: relative, status: manifest === null ? 'unknown' : 'missing' })
      if (manifest !== null) issues.push({ severity: 'error', code: 'immutable-missing', message: `${relative} 缺失` })
    } else if (manifest === null) {
      immutable.push({ path: relative, status: 'unknown' })
    } else if (expected === undefined) {
      immutable.push({ path: relative, status: 'missing' })
      issues.push({ severity: 'error', code: 'immutable-manifest-missing', message: `${relative} 不在 init-manifest.immutable` })
    } else if (actual !== expected) {
      immutable.push({ path: relative, status: 'modified' })
      issues.push({ severity: 'error', code: 'immutable-modified', message: `${relative} 与 init-manifest 不一致` })
    } else {
      immutable.push({ path: relative, status: 'ok' })
    }
  }
  const manifestExists = existsSync(path.join(root, INIT_MANIFEST_PATH))
  if (manifest === null) issues.push({ severity: 'error', code: manifestExists ? 'manifest-invalid' : 'manifest-missing', message: manifestExists ? 'init-manifest 无效；重新运行 /gate-init' : 'init-manifest 缺失；重新运行 /gate-init' })

  let artifactPolicy: 'ok' | 'customized' | 'missing' | 'invalid' = 'missing'
  const policyFile = path.join(root, ARTIFACT_POLICY_PATH)
  if (existsSync(policyFile)) {
    try {
      const parsed = parseArtifactPolicy(JSON.parse(readFileSync(policyFile, 'utf8')))
      if (parsed.policy === undefined) artifactPolicy = 'invalid'
      else {
        const actualHash = sha256File(policyFile)
        artifactPolicy = manifest?.managed?.artifactPolicy?.sha256 !== undefined && actualHash !== manifest.managed.artifactPolicy.sha256 ? 'customized' : 'ok'
      }
    } catch { artifactPolicy = 'invalid' }
  }
  if (artifactPolicy === 'missing') issues.push({ severity: 'error', code: 'artifact-policy-missing', message: 'artifact-policy.json 缺失' })
  if (artifactPolicy === 'invalid') issues.push({ severity: 'error', code: 'artifact-policy-invalid', message: 'artifact-policy.json 无效' })

  const currentBlock = currentAgentsBlock(root)
  let agentsBlock: 'ok' | 'modified' | 'missing' | 'unknown' = manifest === null ? 'unknown' : 'missing'
  if (currentBlock !== null && manifest !== null) {
    agentsBlock = manifest.managed?.agentsBlockHash !== null && manifest.managed?.agentsBlockHash !== undefined && sha256Bytes(currentBlock) !== manifest.managed.agentsBlockHash ? 'modified' : 'ok'
  }
  if (agentsBlock === 'missing') issues.push({ severity: 'error', code: 'agents-block-missing', message: 'AGENTS.md 缺少 gate managed block' })
  if (agentsBlock === 'modified') issues.push({ severity: 'warning', code: 'agents-block-modified', message: 'AGENTS.md managed block 已修改' })

  let packageScript: 'ok' | 'customized' | 'missing' | 'unknown' = manifest === null ? 'unknown' : 'missing'
  let currentScript: string | null = null
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    currentScript = typeof pkg.scripts?.['verify-notes'] === 'string' ? pkg.scripts['verify-notes'] : null
  } catch { /* missing */ }
  if (currentScript === null) {
    packageScript = 'missing'
    issues.push({ severity: 'error', code: 'package-script-missing', message: 'package.json 缺少 scripts.verify-notes' })
  } else if (manifest === null) {
    packageScript = 'unknown'
  } else if (manifest.managed?.packageScript !== null && manifest.managed?.packageScript !== undefined && currentScript !== manifest.managed.packageScript) {
    packageScript = 'customized'
    issues.push({ severity: 'warning', code: 'package-script-customized', message: 'scripts.verify-notes 与 init 时不同' })
  } else packageScript = 'ok'

  const workflowPath = manifest?.managed?.workflow ?? '.github/workflows/verify-notes.yml'
  const workflow = existsSync(path.join(root, workflowPath)) ? 'existing' : 'missing'
  if (workflow === 'missing') issues.push({ severity: 'warning', code: 'workflow-missing', message: `${workflowPath} 缺失` })

  let notes: 'ok' | 'missing' = 'ok'
  for (const lifecycle of ['proposed', 'implemented', 'rejected', 'archived']) {
    if (!existsSync(path.join(root, '.agents', 'notes', lifecycle))) {
      notes = 'missing'
      issues.push({ severity: 'error', code: 'notes-missing', message: `.agents/notes/${lifecycle} 缺失` })
    }
  }

  const currentVersion = packageVersion()
  if (manifest !== null && manifest.gateVersion !== currentVersion) {
    issues.push({ severity: 'warning', code: 'stale-init', message: `init gateVersion=${manifest.gateVersion}，当前=${currentVersion}；建议重新运行 /gate-init` })
  }

  const ok = !issues.some(issue => issue.severity === 'error')
  const lines = [
    `init verify：${ok ? 'ok' : 'FAILED'}`,
    `manifest：${manifest === null ? 'missing/invalid' : 'ok'}`,
    `gateVersion：${manifest?.gateVersion ?? 'unknown'}（current ${currentVersion}）`,
    `artifact-policy：${artifactPolicy}`,
    `agents block：${agentsBlock}`,
    `package script：${packageScript}`,
    `workflow：${workflow}`,
    `notes：${notes}`,
    ...issues.map(issue => `${issue.severity}: ${issue.message}`),
  ]
  return { ok, manifest: manifest === null ? (manifestExists ? 'invalid' : 'missing') : 'ok', immutable, artifactPolicy, agentsBlock, packageScript, workflow, notes, issues, text: lines.join('\n') }
}
