import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const SKILLS = path.join(PACKAGE_ROOT, 'skills')
export const NOTES_SKILL_DIR = path.join(SKILLS, 'gate-write-agent-notes')
export const NOTES_LAUNCHER_TEMPLATE = path.join(PACKAGE_ROOT, 'launchers', 'verify-notes.mjs')
export const NOTES_CI_TEMPLATE = path.join(PACKAGE_ROOT, 'launchers', 'verify-notes.yml')
export const NOTES_CI_SCRIPTS = [
  'agent-note-tree.ts',
  'verify-agent-note-tree.ts',
  'verify-agent-note-format.ts',
  'verify-agent-note-lifecycle.ts',
  'verify-archived-agent-notes.ts',
]
