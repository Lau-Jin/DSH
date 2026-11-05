#!/usr/bin/env node
/**
 * 直连 gongsi MCP（streamable-http）的通用客户端 —— 任意调工具的逃生口。
 *
 * 什么时候用：可调用工具列表里没有那 45 个 gongsi 工具，但 mcp_health 显示服务端
 * ok:true / toolCount:45（本地工具注册层没注入，服务端是好的）。
 * 日常排查优先用专用脚本：ticket-facts / kb-digest / worklog-precheck。
 *
 * 用法：node scripts/mcp-http-call.mjs <calls.json> [--out <dir>]
 *   calls.json = { "calls": [ { "tool": "ticket_get_ticket_detail",
 *                               "args": { "ticketNo": "FB202610300001" } } ] }
 *
 * ⚠️ 写操作同样能调，但**必须先向用户展示拟写入内容并得到确认**（SKILL.md 铁律 6）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENDPOINT, init, callTool, guard } from './lib/mcp.mjs';

guard();

const argv = process.argv.slice(2);
const callsFile = argv[0];
if (!callsFile) {
  console.error('用法: node scripts/mcp-http-call.mjs <calls.json> [--out <dir>]');
  process.exit(2);
}
const outIdx = argv.indexOf('--out');
const OUT_DIR = outIdx > -1 ? argv[outIdx + 1] : 'mcp-out';
if (!fs.existsSync(callsFile)) {
  console.error(`找不到调用文件: ${callsFile}`);
  process.exit(2);
}
// PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，JSON.parse 会直接报错
const raw = fs.readFileSync(callsFile, 'utf8').replace(/^﻿/, '');
const calls = JSON.parse(raw).calls || [];

const initRes = await init();
fs.mkdirSync(OUT_DIR, { recursive: true });

const summary = { endpoint: ENDPOINT, initStatus: initRes.status, results: [] };
let i = 0;
for (const c of calls) {
  const tag = `${String(c.tool).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${i}`;
  try {
    const data = await callTool(c.tool, c.args);
    const file = path.join(OUT_DIR, `${tag}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    summary.results.push({ tool: c.tool, file });
  } catch (e) {
    summary.results.push({ tool: c.tool, error: e.message });
  }
  i++;
}
console.log(JSON.stringify(summary, null, 2));
