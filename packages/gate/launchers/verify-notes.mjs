import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const scriptsDir = join(process.cwd(), '.agents', 'gate', 'ci')
const notesRoot = join(process.cwd(), '.agents', 'notes')
const scripts = [
  'verify-agent-note-tree.ts',
  'verify-agent-note-format.ts',
  'verify-agent-note-lifecycle.ts',
  'verify-archived-agent-notes.ts',
]

for (const name of scripts) {
  const result = spawnSync(
    process.execPath,
    [join(scriptsDir, name), '--root', notesRoot],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
}
