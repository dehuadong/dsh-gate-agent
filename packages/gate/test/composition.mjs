// Bundle composition checks: manifest exports, display resources, plugin export shape.
// A full Loader boot needs a DSH profile; this file reports that limit instead of faking it.
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { apply, inject, Config } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`ok   ${name}`)
  else { failures += 1; console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
check('package is a bundle', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('manifest entry points at lib', manifest.exports?.['.'] === './lib/index.js')
check('manifest exports locale, icon and package.json',
  manifest.exports?.['./locale/*.json'] === './locale/*.json'
  && manifest.exports?.['./icon'] === './icon.svg'
  && manifest.exports?.['./package.json'] === './package.json')
check('manifest files include runtime and display resources',
  ['lib', 'skills', 'launchers', 'cordis.patch.yml', 'README.md', 'locale/*.json', 'icon.svg']
    .every(entry => manifest.files.includes(entry)))
check('manifest files exclude repository governance and sources',
  !manifest.files.some(entry => entry.startsWith('.agents') || entry === 'docs/' || entry === 'AGENTS.md' || entry === 'deepseek-harness/' || entry === 'src/' || entry === 'index.js'))
check('lib/index.js exists after build', existsSync(path.join(root, 'lib', 'index.js')))

const require = createRequire(import.meta.url)
const resolvedManifest = require.resolve('dsh-gate-agent/package.json')
check('package root resolves from package name', path.dirname(resolvedManifest) === root && existsSync(path.join(root, 'skills')) && existsSync(path.join(root, 'launchers')))

const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
check('bundle patch declares the developer preset with the package name', patch.includes('insert:') && patch.includes('preset-developer') && patch.includes("'dsh-gate-agent'"))
check('bundle patch resolves package.json for the package root', patch.includes("resolve('dsh-gate-agent/package.json')") && !patch.includes("resolve('dsh-gate-agent')"))
check('plugin exports apply and inject', typeof apply === 'function' && Array.isArray(inject) && inject.includes('tools'))
check('plugin exports a Standard Schema Config', typeof Config?.['~standard']?.validate === 'function')
check('Config accepts an empty object', Array.isArray(Config['~standard'].validate({}).issues) === false)
check('Config rejects an unknown key', Array.isArray(Config['~standard'].validate({ nope: 1 }).issues))

for (const [language, title] of [['en', 'Gate'], ['zh', 'Gate 门禁']]) {
  const file = path.join(root, 'locale', `${language}.json`)
  const locale = JSON.parse(readFileSync(file, 'utf8'))
  check(`locale ${language} has meta title and description`,
    locale.meta?.title === title && typeof locale.meta?.description === 'string' && locale.meta.description.length > 0)
}
const icon = path.join(root, 'icon.svg')
check('icon exists and is a small svg',
  existsSync(icon) && statSync(icon).size <= 256 * 1024 && readFileSync(icon, 'utf8').trimStart().startsWith('<svg'))

console.log('SKIP full Loader boot: a composed DSH profile is required; this checkout verifies the bundle manifest, display resources, and plugin exports only.')

if (failures > 0) {
  console.error(`\n${failures} COMPOSITION CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nCOMPOSITION MANIFEST CHECKS PASSED (full Loader boot is not covered here)')
