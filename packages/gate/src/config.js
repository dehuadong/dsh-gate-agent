import { existsSync } from 'node:fs'
import path from 'node:path'

export const PROJECT_ANCHOR = '.git'

export function findProjectRoot(workspace) {
  let current = path.resolve(workspace)
  for (;;) {
    if (existsSync(path.join(current, PROJECT_ANCHOR))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
