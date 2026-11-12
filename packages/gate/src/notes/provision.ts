import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { NOTES_CI_SCRIPTS, NOTES_CI_TEMPLATE, NOTES_LAUNCHER_TEMPLATE } from '../paths.js'
import { execFileSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { NOTES_SKILL_DIR } from '../paths.js'
import { pathHasSymlink } from './fs.js'

export const NOTES_BLOCK_START = '<!-- gate-notes:start -->'
export const NOTES_BLOCK_END = '<!-- gate-notes:end -->'
export const NOTES_AGENTS_TEXT = `${NOTES_BLOCK_START}
## 重要改动必须留笔记

1. 非平凡改动（行为、架构、跨文件契约、流程/工具链、测试策略、落盘/网络/配置格式）在动手前使用内置技能 \`gate-write-agent-notes\`，按 §3 检索、§4 判定归属与 class；机械性小改直接提交。
2. 既有决定未变时原地同步 \`implemented/\` Note；新想法先放 \`proposed/\`；落地随同代码转 \`implemented/\`。
3. 被放弃的方案先写最强理由再否决。
4. 提交前运行 \`npm run verify-notes\` 检查；gate 会话内也可用 \`/gate-note-verify\`。gate 的 lifecycle 由 \`gate_note_finalize\` → \`gate_note_verify\` → \`gate_record({node:'note-lifecycle'})\` 完成。
${NOTES_BLOCK_END}`

export function provisionNotes(root: string) {
  const notes = path.join(root, '.agents', 'notes')
  if (pathHasSymlink(root, notes)) throw new Error('notes 路径包含 symlink')
  for (const lifecycle of ['proposed', 'implemented', 'rejected', 'archived']) {
    const dir = path.join(notes, lifecycle)
    if (pathHasSymlink(root, dir)) throw new Error(`${lifecycle} 路径包含 symlink`)
    mkdirSync(dir, { recursive: true })
    const keep = path.join(dir, '.gitkeep')
    if (!existsSync(keep)) writeFileSync(keep, '')
  }
  const agents = path.join(root, 'AGENTS.md')
  if (existsSync(agents) && lstatSync(agents).isSymbolicLink()) throw new Error('AGENTS.md 是 symlink')
  const existing = existsSync(agents) ? readFileSync(agents, 'utf8') : ''
  const block = /<!-- gate-notes:start -->[\s\S]*?<!-- gate-notes:end -->/u
  const next = block.test(existing)
    ? existing.replace(block, NOTES_AGENTS_TEXT)
    : `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}\n${NOTES_AGENTS_TEXT}\n`
  writeFileSync(agents, next)
  return { notes: path.relative(root, notes).replaceAll('\\', '/'), agents: path.relative(root, agents).replaceAll('\\', '/') }
}


export function provisionProjectScripts(root: string) {
  const dir = path.join(root, '.agents', 'gate')
  const launcher = path.join(dir, 'verify-notes.mjs')
  mkdirSync(dir, { recursive: true })
  copyFileSync(NOTES_LAUNCHER_TEMPLATE, launcher)
  const packagePath = path.join(root, 'package.json')
  let pkg: any = { private: true }
  if (existsSync(packagePath)) {
    try { pkg = JSON.parse(readFileSync(packagePath, 'utf8')) } catch { throw new Error('package.json 不是有效 JSON') }
    if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json 必须是对象')
  }
  pkg.scripts = pkg.scripts !== null && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {}
  const command = 'node .agents/gate/verify-notes.mjs'
  const existing = pkg.scripts['verify-notes']
  if (existing === undefined) pkg.scripts['verify-notes'] = command
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  return {
    launcher: path.relative(root, launcher).replaceAll('\\', '/'),
    package: path.relative(root, packagePath).replaceAll('\\', '/'),
    command: existing === undefined ? command : String(existing),
    changed: existing === undefined,
  }
}



export const BASE_GITIGNORE = `node_modules/
.env
.env.*
!.env.example
*.log
.DS_Store
Thumbs.db
coverage/
dist/
.agents/notes/.gate-finalize-*
.agents/notes/.gate-validate-*
.agents/notes/*.gate-backup
`

export function provisionGit(root: string) {
  const ignore = path.join(root, '.gitignore')
  let ignoreStatus = 'existing'
  if (!existsSync(ignore)) {
    writeFileSync(ignore, BASE_GITIGNORE)
    ignoreStatus = 'created'
  }
  const git = (args: any, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let gitError = null
  const init = () => {
    try {
      git(['init', '-b', 'main'])
    } catch (first) {
      try { git(['init']) } catch (second) {
        gitError = String((second as any)?.stderr ?? (second as any)?.message ?? (first as any)?.stderr ?? (first as any)?.message ?? second).trim()
        return 'init-failed'
      }
    }
    return 'initialized'
  }
  let gitStatus
  try {
    gitStatus = git(['rev-parse', '--is-inside-work-tree']).trim() === 'true' ? 'existing' : init()
  } catch (error) {
    gitStatus = (error as any)?.code === 'ENOENT' ? 'unavailable' : init()
  }
  return { git: gitStatus, ignore: ignoreStatus, gitError }
}

export function provisionCi(root: string) {
  const ciDir = path.join(root, '.agents', 'gate', 'ci')
  mkdirSync(ciDir, { recursive: true })
  for (const name of NOTES_CI_SCRIPTS) {
    copyFileSync(path.join(NOTES_SKILL_DIR, 'scripts', name), path.join(ciDir, name))
  }
  const workflow = path.join(root, '.github', 'workflows', 'verify-notes.yml')
  mkdirSync(path.dirname(workflow), { recursive: true })
  const existing = existsSync(workflow)
  if (!existing) copyFileSync(NOTES_CI_TEMPLATE, workflow)
  return { workflow: path.relative(root, workflow).replaceAll('\\', '/'), scripts: path.relative(root, ciDir).replaceAll('\\', '/'), changed: !existing }
}

