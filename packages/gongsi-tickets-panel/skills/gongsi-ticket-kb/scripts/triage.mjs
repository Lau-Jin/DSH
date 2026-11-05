#!/usr/bin/env node
/**
 * 一次跑完「工单事实 + 知识库检索」——**默认首选**。
 *
 * 为什么有它：每个脚本进程都要重付 TLS 握手 + MCP initialize（实测 ~224ms），
 * 分开跑两个脚本就是两倍固定开销 + 两次 shell 往返。
 * 这里一个进程、一条命令出全部材料。
 *
 * 用法：node scripts/triage.mjs <工单号> --query "<检索式>" [选项]
 *   --query "<检索式>"   可**重复**；多个检索式会**并发**跑（串行 3 次 ≈5.1s，并发 ≈1.9s）
 *   --queries "A" "B"    一次给多个检索式
 *   --auto               **不写检索式，让脚本自己从工单正文里提炼**（见下）
 *   --top-k N            向量召回条数（默认 5）
 *                        ⚠️ 别调大：响应体大小取决于**命中的分片内容**（图片识别块可以很大），
 *                        同一查询 top_k=5 → 12KB ✅，top_k=8/10 → 69KB ❌ 撞 64KB 预算要重试。
 *   --max-hits N         最多核对几篇文档（默认 4）
 *   --ctx-chunks N       每篇核几个分片（默认 2）
 *   --surrounding N      前后各带几段（默认 1）
 *   --kb 6,9             只搜指定库（搜全库 ≈1.76s，搜单库 ≈1.2s）
 *   --no-context         不拉原文，只出检索命中
 *
 * --auto 的意义：
 *   检索式必须来自工单正文，所以"读工单 → 想检索式 → 检索"要占**两个模型回合**，
 *   中间夹一次推理。--auto 让脚本自己提炼，于是整条流程塌缩成一条命令 ——
 *   模型不用在两次工具调用之间做判断，也就不用多跑一个回合。
 *   自动提炼只是初稿：本脚本会把**用过的检索式**和**工单事实表**打印在同一份输出里，
 *   模型若觉得词不对，补一轮 --query 时不需要重新读工单。
 *
 * 只读，不写任何东西。
 */
import { guard, elapsed, collectQueries } from './lib/mcp.mjs';
import { ticketFacts } from './lib/facts.mjs';
import { kbDigest } from './lib/digest.mjs';
import { deriveQueries } from './lib/queries.mjs';

guard();

const argv = process.argv.slice(2);
const id = argv.find((a) => !a.startsWith('--') && !/^\d+(,\d+)*$/.test(a));
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const queries = collectQueries(argv);

if (!id) {
  console.error('用法: node scripts/triage.mjs <工单号> --query "<检索式>" [--query "<检索式2>" ...] [--top-k 5] [--max-hits 4] [--ctx-chunks 2] [--surrounding 1] [--no-context]');
  process.exit(2);
}

// ① 工单事实
const { table, warns, ticket } = await ticketFacts(id);
console.log(table.join('\n'));
if (warns.length) {
  console.log('');
  console.log('--- 状态判读 ---');
  console.log(warns.join('\n'));
}

// ② 知识库检索
let usedQueries = queries;
if (!usedQueries.length && argv.includes('--auto')) {
  usedQueries = deriveQueries(ticket || {});
  console.log('');
  console.log(
    usedQueries.length
      ? `--- 自动提炼的检索式（${usedQueries.length} 条，并发跑）---\n${usedQueries.map((q) => '  · ' + q).join('\n')}`
      : '--- 自动提炼：工单正文里没抽出可用检索式，跳过知识库检索 ---'
  );
}
if (usedQueries.length) {
  console.log('');
  const kbArg = flag('kb', null);
  const { lines } = await kbDigest(usedQueries, {
    topK: Number(flag('top-k', 5)),
    maxHits: Number(flag('max-hits', 4)),
    ctxChunks: Number(flag('ctx-chunks', 2)),
    surrounding: Number(flag('surrounding', 1)),
    kbIds: kbArg && typeof kbArg === 'string' ? kbArg.split(',').map((s) => Number(s.trim())) : null,
    noContext: argv.includes('--no-context'),
    full: argv.includes('--full'),
  });
  console.log(lines.join('\n'));
} else {
  console.log('');
  console.log('（没给 --query，跳过知识库检索；把检索式写进命令再跑，或用 scripts/kb-digest.mjs）');
}

console.log(`—— 总用时 ${elapsed()}`);
