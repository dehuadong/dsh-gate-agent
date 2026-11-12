/**
 * Bundle the Node entry for DSH's native ESM loader.
 *
 * The host imports the package root with native `import()`; relative imports
 * and workspace dependencies are not resolved across the profile boundary, so
 * the entry is emitted as one file. `node:*` and host-provided packages stay
 * external.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST_EXTERNAL = ['@deepseek-ai/*', 'node:*']

fs.rmSync(path.join(packageRoot, 'lib'), { recursive: true, force: true })

function assertNoRelativeImports(outfile, output) {
  const leftover = /(?:from\s*|require\(\s*)["']\.[^"']*["']/.exec(output)
  if (leftover !== null) throw new Error(`${outfile} 残留相对导入：${leftover[0]}`)
}

const result = await esbuild.build({
  entryPoints: [path.join(packageRoot, 'src', 'index.ts')],
  outfile: path.join(packageRoot, 'lib', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: HOST_EXTERNAL,
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'warning',
  metafile: true,
})
const output = fs.readFileSync(path.join(packageRoot, 'lib', 'index.js'), 'utf8')
assertNoRelativeImports('lib/index.js', output)
const modules = Object.keys(result.metafile.inputs).length
console.log(`[bundle] lib/index.js ok (${(fs.statSync(path.join(packageRoot, 'lib', 'index.js')).size / 1024).toFixed(1)} KB, 内联 ${modules} 个模块)`)
