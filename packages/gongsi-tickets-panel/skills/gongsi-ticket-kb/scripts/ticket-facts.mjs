#!/usr/bin/env node
/**
 * 取工单事实表 —— 替代 SKILL.md §2 Step 1~2 的散文。
 *
 * 用法：node scripts/ticket-facts.mjs <ticketNo|ticketId> [--raw]
 *   --raw   额外把完整工单 JSON 写到 ./ticket-<no>.json
 *
 * 输出：压缩过的「工单事实」表 + 状态判读提示（关键：这些提示是脚本算的，不是模型想出来的）。
 * 只读，不写任何东西。
 *
 * 想要「事实 + 知识库」一次跑完（省一次进程冷启动），用 scripts/triage.mjs。
 */
import { guard, elapsed } from './lib/mcp.mjs';
import { ticketFacts } from './lib/facts.mjs';

guard();

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const wantRaw = args.includes('--raw');
if (!id) {
  console.error('用法: node scripts/ticket-facts.mjs <ticketNo|ticketId> [--raw]');
  process.exit(2);
}

const { table, warns } = await ticketFacts(id, { raw: wantRaw });

console.log(table.join('\n'));
if (warns.length) {
  console.log('');
  console.log('--- 状态判读 ---');
  console.log(warns.join('\n'));
}
console.log(`—— 用时 ${elapsed()}`);
