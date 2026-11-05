/**
 * Host loader entry for the SiYuan Bridge panel.
 *
 * Two host-side jobs:
 *   1. heartbeat — tell the bridge the Harness really loaded this plugin, so
 *      `/api/status` can tell "installed but not loaded" from "loaded";
 *   2. ensure the bridge service is running — if 127.0.0.1:5599 is closed, spawn
 *      `server.mjs` detached so the panel has something to frame after a reboot.
 *
 * The panel itself is pure UI: the service owns the SiYuan kernel token and
 * every read/write, so nothing here touches SiYuan or its credentials.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.1.0'
const SERVICE = 'http://127.0.0.1:5599'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '..', '..', 'server.mjs')
const SERVER_DIR = path.dirname(SERVER)

/** True when the bridge answers at all. */
async function reachable() {
  try {
    const res = await fetch(SERVICE + '/api/status', { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** Report this plugin's load to the bridge, ignoring every failure. */
function hello(attempt = 0) {
  try {
    fetch(SERVICE + '/api/plugin-hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'dsh', version: VERSION, ua: 'dsh-host' }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => {
      if (attempt < 4) setTimeout(() => hello(attempt + 1), 1500)
    })
  } catch {
    /* the bridge is optional: the panel shows its own offline state */
  }
}

/** A node binary that can run server.mjs without Electron's main process. */
function nodeBinary() {
  const candidates = [
    process.env.SIYUAN_BRIDGE_NODE,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe') : '',
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return { command: found, env: process.env }
  // Fall back to this process's binary in plain Node mode.
  return { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
}

/** Start the bridge when nothing is listening, detached from this process. */
async function ensureService() {
  if (await reachable()) return
  if (!existsSync(SERVER)) return
  try {
    const { command, env } = nodeBinary()
    const child = spawn(command, [SERVER], { cwd: SERVER_DIR, env, detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    console.log('[siyuan-bridge] started the bridge service: ' + SERVER)
  } catch (error) {
    console.warn('[siyuan-bridge] could not start the service:', error && error.message)
  }
}

export function apply(ctx) {
  void ensureService().then(hello)
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => {
        const timer = setInterval(hello, 60_000)
        if (typeof timer.unref === 'function') timer.unref()
        return () => clearInterval(timer)
      }, 'siyuan-bridge: heartbeat')
    } catch {
      /* effect is best-effort */
    }
  }
}
