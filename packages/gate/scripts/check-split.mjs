/** Static guard for the source-module split: no cycles, no forbidden edges, small entry. */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')
const failures = []
const imported = (file) => {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/gu)].map(match => path.resolve(path.dirname(file), match[1]))
}

const graph = new Map()
function visit(file) {
  if (graph.has(file)) return graph.get(file)
  const deps = imported(file).map(dep => existsSync(dep) ? dep : dep.replace(/\.js$/u, '.ts')).filter(dep => dep.startsWith(src) && existsSync(dep))
  graph.set(file, deps)
  for (const dep of deps) visit(dep)
  return deps
}
visit(path.join(src, 'index.ts'))

const state = new Map()
function checkCycle(file, stack) {
  if (state.get(file) === 'done') return
  if (state.get(file) === 'visiting') {
    failures.push(`cycle: ${[...stack, file].map(item => path.relative(root, item)).join(' -> ')}`)
    return
  }
  state.set(file, 'visiting')
  for (const dep of graph.get(file) ?? []) checkCycle(dep, [...stack, file])
  state.set(file, 'done')
}
checkCycle(path.join(src, 'index.ts'), [])

const rel = (file) => path.relative(src, file).replaceAll('\\', '/')
for (const [file, deps] of graph) {
  const from = rel(file)
  for (const dep of deps) {
    const to = rel(dep)
    if ((from.startsWith('tools/') || from === 'commands.ts') && to === 'index.ts') failures.push(`${from} imports index.ts`)
    if (from.startsWith('notes/') && to.startsWith('runtime/')) failures.push(`${from} imports ${to}`)
    if (from === 'protocol.ts' && to.startsWith('runtime/')) failures.push(`protocol.ts imports ${to}`)
  }
}

const entryLines = readFileSync(path.join(src, 'index.ts'), 'utf8').split('\n').length
if (entryLines > 250) failures.push(`src/index.ts has ${entryLines} lines (max 250)`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exit(1)
}
console.log(`ok   split graph (${graph.size} modules) and entry ${entryLines} lines`)
