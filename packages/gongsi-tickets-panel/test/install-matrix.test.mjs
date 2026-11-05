#!/usr/bin/env node
// 安装矩阵自检：验证分发包不会触发 pnpm 的 ERR_PNPM_LINKING_FAILED。
//
// 背景：老版本把 @deepseek-ai/schemastery 等依赖用 bundleDependencies 打进了 tarball，
// 于是 tarball 里 node_modules/@deepseek-ai/schemastery 是个「实体目录」；
// 而 pnpm 自己装依赖时在同一路径放的是「软链」。
// 两者类型不一致时，pnpm 搬目录直接报：
//   ERR_PNPM_LINKING_FAILED Cannot overwrite directory '...' with non-directory '...'
//
// 这里验证：新包（1）tarball 内不含 node_modules，（2）各种安装顺序都不会撞车。
//
// 用法：node test/install-matrix.test.mjs
// 找不到 pnpm 时自动跳过（不失败）。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

// ---- 找 pnpm：优先 PATH，其次 DSH 内置 runtime ------------------------------
function findPnpm() {
  const candidates = []
  if (process.env.PNPM_BIN) candidates.push(process.env.PNPM_BIN)
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const runtimeRoot = join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
  candidates.push(
    join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs'),
    join(runtimeRoot, 'node', 'bin', 'node.exe'),
  )
  const mjs = candidates.find((p) => p.endsWith('pnpm.mjs') && existsSync(p))
  if (mjs) {
    const nodeBin = join(runtimeRoot, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    return { cmd: process.execPath, args: [mjs], label: mjs }
  }
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pnpm'], { stdio: 'pipe' })
    return { cmd: 'pnpm', args: [], label: 'pnpm (PATH)' }
  } catch {
    return null
  }
}

const pnpm = findPnpm()
if (!pnpm) {
  console.log('SKIP: 找不到 pnpm，跳过安装矩阵自检')
  process.exit(0)
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  ok   ${name}`)
  } catch (err) {
    results.push({ name, ok: false, err })
    console.log(`  FAIL ${name}\n       ${String(err.message ?? err).split('\n').slice(0, 6).join('\n       ')}`)
  }
}

function run(args, cwd) {
  return execFileSync(pnpm.cmd, [...pnpm.args, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, npm_config_manage_package_manager_versions: 'false' },
  })
}

// pnpm 11 会在 package.json 里写 packageManager 字段自切版本，这里固定住
function writeProject(dir, { hoisted }) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'matrix-fixture', version: '1.0.0', private: true }))
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    hoisted ? 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
            : 'packages:\n  - .\n\nautoInstallPeers: false\n',
  )
}

const tmp = mkdtempSync(join(tmpdir(), 'gongsi-install-matrix-'))
try {
  console.log(`打包并验证：${pkgJson.name}@${pkgJson.version}`)

  // ---- 1. 打包 ----------------------------------------------------------
  // 先把包复制到临时目录并「装上依赖」，再打包。
  // 这样打出来的包一定是「依赖齐备」的状态 —— 要是有人把 bundleDependencies 加回来，
  // 下面「tarball 里不含 node_modules」这条就会真的红掉（而不是因为没装依赖而侥幸通过）。
  const pkgCopy = join(tmp, 'pkg')
  mkdirSync(pkgCopy, { recursive: true })
  for (const entry of readdirSync(pkgRoot, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === '.git') continue
    cpSync(join(pkgRoot, entry.name), join(pkgCopy, entry.name), { recursive: true })
  }
  run(['install', '--ignore-workspace', '--prefer-offline'], pkgCopy)

  const distDir = join(tmp, 'dist')
  mkdirSync(distDir, { recursive: true })
  run(['pack', '--pack-destination', distDir], pkgCopy)
  const tgz = readdirSync(distDir).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error('pnpm pack 没产出 .tgz')
  const tgzPath = join(distDir, tgz)

  check('tarball 里不含 node_modules（这是修复的核心）', () => {
    const listing = execFileSync('tar', ['-tf', tgzPath], { encoding: 'utf8' })
    const hits = listing.split('\n').filter((l) => l.includes('node_modules'))
    if (hits.length) throw new Error(`包内仍有 node_modules：${hits.slice(0, 3).join(', ')}`)
  })

  check('package.json 不再声明 bundleDependencies', () => {
    if (pkgJson.bundleDependencies) throw new Error('bundleDependencies 还在，tarball 会再次内置依赖目录')
  })

  check('依赖仍然声明（走 registry，由 pnpm 统一管理）', () => {
    if (!pkgJson.dependencies?.['@deepseek-ai/schemastery']) throw new Error('缺少 @deepseek-ai/schemastery 依赖声明')
  })

  // ---- 2. 安装矩阵 -------------------------------------------------------
  const scenarios = [
    { name: '全新安装（hoisted 布局）', hoisted: true, pre: null },
    { name: '全新安装（isolated 布局）', hoisted: false, pre: null },
    {
      name: '覆盖安装：先装 tarball 再装 tarball',
      hoisted: true,
      pre: (dir) => run(['add', tgzPath], dir),
    },
    {
      name: '覆盖安装：先装目录（软链依赖）再装 tarball',
      hoisted: true,
      pre: (dir) => {
        const linkTarget = join(tmp, 'link-target')
        cpSync(pkgRoot, linkTarget, {
          recursive: true,
          filter: (src) => !src.includes(`${'node_modules'}`) && !src.includes('test'),
        })
        run(['install', '--ignore-workspace'], linkTarget)
        run(['add', `link:${linkTarget}`], dir)
      },
    },
  ]

  for (const sc of scenarios) {
    check(sc.name, () => {
      const dir = join(tmp, `proj-${results.length}`)
      writeProject(dir, { hoisted: sc.hoisted })
      if (sc.pre) sc.pre(dir)
      const out = run(['add', tgzPath], dir)
      if (out.includes('ERR_PNPM_LINKING_FAILED')) throw new Error(out)
    })
  }

  // ---- 3. 离线安装：依赖已在 store 里时不需要联网 -------------------------
  check('离线安装（--offline，依赖走本地 store）', () => {
    const dir = join(tmp, 'proj-offline')
    writeProject(dir, { hoisted: true })
    try {
      run(['add', '--offline', tgzPath], dir)
    } catch (err) {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
      if (out.includes('ERR_PNPM_OFFLINE_MISSING_DEPENDENCY')) {
        throw new Error('本地 store 里还没有这些依赖版本，联网装一次即可（不是打包缺陷）')
      }
      throw new Error(out.split('\n').slice(0, 5).join('\n'))
    }
  })
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length) {
  console.log('失败：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.err.message ?? f.err}`)
  process.exit(1)
}
