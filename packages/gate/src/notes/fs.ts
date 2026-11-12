import { existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { NOTES_SKILL_DIR } from '../paths.js'

export function isInside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function resolveNotesSkill() {
  const skill = path.join(NOTES_SKILL_DIR, 'SKILL.md')
  if (!existsSync(skill)) return undefined
  const template = path.join(NOTES_SKILL_DIR, 'templates', 'proposed.md')
  return { skill, template: existsSync(template) ? template : undefined }
}


export function resolveNodeBinary() {
  if (!process.versions?.electron) return process.execPath
  const configured = process.env.DSH_DESKTOP_NODE_EXECUTABLE
  if (typeof configured === 'string' && configured !== '' && existsSync(configured)) return configured
  if (typeof (process as any).resourcesPath === 'string' && (process as any).resourcesPath !== '') {
    const bin = path.join((process as any).resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(bin)) return bin
  }
  return undefined
}


export function pathHasSymlink(base: string, absolute: string) {
  const relative = path.relative(base, absolute)
  if (relative === '' || relative.startsWith('..')) return true
  let current = base
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true
  for (const part of relative.split(path.sep)) {
    if (part === '') continue
    current = path.join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true
  }
  return false
}

