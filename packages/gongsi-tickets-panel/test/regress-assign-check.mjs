/**
 * One-off helper: make a regressed copy of the panel and run the assign
 * picker test against it, to prove the test fails when the picker regresses.
 *
 * The copy loses the two things the test guards: the list no longer opens
 * upward, and the keyword is asked for on every keystroke again.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, '..', 'client.js')
const test = path.join(here, 'assign-picker.test.mjs')

const tmp = path.join(os.tmpdir(), 'gongsi-assign-regress')
mkdirSync(path.join(tmp, 'test'), { recursive: true })
writeFileSync(path.join(tmp, 'client.js'), readFileSync(source, 'utf8'), 'utf8')
copyFileSync(test, path.join(tmp, 'test', 'assign-picker.test.mjs'))

const target = path.join(tmp, 'client.js')
let code = readFileSync(target, 'utf8')
const before = code
// The list always opens downward again.
code = code.replace(
  /setUpward\(below < 240 && above > below\)/,
  'setUpward(false)',
)
// The keyword is asked for on every keystroke again.
code = code.replace(
  /\}, keyword === '' \? 0 : 220\)/,
  '}, 0)',
)
if (code === before) throw new Error('the regressed copy was not patched')
writeFileSync(target, code, 'utf8')

const run = spawnSync(process.execPath, [path.join(tmp, 'test', 'assign-picker.test.mjs')], { encoding: 'utf8' })
process.stdout.write(run.stdout ?? '')
process.stdout.write(run.stderr ?? '')
process.stdout.write(`exit code: ${run.status}\n`)
