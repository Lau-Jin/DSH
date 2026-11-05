/**
 * One-off helper: make a regressed copy of the panel and run the layout test
 * against it, to prove the test fails when the layout regresses.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, '..', 'client.js')
const test = path.join(here, 'panel-layout.test.mjs')

const tmp = path.join(os.tmpdir(), 'gongsi-regress')
mkdirSync(path.join(tmp, 'test'), { recursive: true })
writeFileSync(path.join(tmp, 'client.js'), readFileSync(source, 'utf8'), 'utf8')
copyFileSync(test, path.join(tmp, 'test', 'panel-layout.test.mjs'))

const target = path.join(tmp, 'client.js')
let code = readFileSync(target, 'utf8')
const before = code
code = code.replace(
  /overflow: 'hidden',(\r?\n\s*boxSizing: 'border-box',)/,
  "overflow: 'auto',$1",
)
code = code.replace(
  /overflowY: 'auto',(\r?\n\s*overflowX: 'hidden',)/,
  "overflowY: 'visible',$1".replace("overflowX: 'hidden',", "overflowX: 'visible',"),
)
if (code === before) throw new Error('the regressed copy was not patched')
writeFileSync(target, code, 'utf8')

const run = spawnSync(process.execPath, [path.join(tmp, 'test', 'panel-layout.test.mjs')], { encoding: 'utf8' })
process.stdout.write(run.stdout ?? '')
process.stdout.write(run.stderr ?? '')
process.stdout.write(`exit code: ${run.status}\n`)
