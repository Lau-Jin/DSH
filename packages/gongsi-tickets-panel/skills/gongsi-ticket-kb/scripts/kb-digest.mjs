#!/usr/bin/env node
/**
 * 知识库检索 → 去重 → 自动核对原文 → 输出带出处的引用块。
 *
 * 替代 SKILL.md §2 Step 3~5 的散文：把「铁律 2（每个知识点都要能指回原文）」
 * 和「铁律 3（is_qa=true 不是原文）」从模型的自觉变成脚本的强制。
 *
 * 用法：node scripts/kb-digest.mjs --query "<检索式>" [选项]
 *   --query "<检索式>"   可**重复**；多个检索式会**并发**跑（串行 3 次 ≈5.1s，并发 ≈2.0s）
 *   --queries "A" "B"    一次给多个检索式
 *   --top-k N        向量召回条数（默认 5；8 容易撞 64KB 预算触发重试）
 *   --min-score X    低于此分丢弃（默认 0.6）
 *   --max-hits N     最多核对几篇文档的原文（默认 5）
 *   --ctx-chunks N   每篇文档核几个命中分片（默认 2）
 *   --surrounding N  取原文时前后各带几段（默认 1）
 *   --kb 6,9         只搜指定库（默认搜全部可见库）。
 *                    ⚠️ 搜全库 ≈1.76s，搜单个库 ≈0.74s —— 已知库就指定，能省近 1 秒
 *   --no-context     只出检索结果，不拉原文
 *   --full           展开折叠的图片识别块（默认压成一行）
 *
 * 只读，不写任何东西。
 */
import { guard, elapsed, collectQueries } from './lib/mcp.mjs';
import { kbDigest } from './lib/digest.mjs';

guard();

const argv = process.argv.slice(2);
const queries = collectQueries(argv);
if (!queries.length) {
  console.error('用法: node scripts/kb-digest.mjs --query "<检索式>" [--query "<检索式2>" ...] [--top-k 5] [--min-score 0.6] [--max-hits 5] [--ctx-chunks 2] [--surrounding 1] [--kb 6,9] [--no-context] [--full]');
  process.exit(2);
}
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const kbArg = flag('kb', null);

const { lines } = await kbDigest(queries, {
  topK: Number(flag('top-k', 5)),
  minScore: Number(flag('min-score', 0.6)),
  maxHits: Number(flag('max-hits', 5)),
  ctxChunks: Number(flag('ctx-chunks', 2)),
  surrounding: Number(flag('surrounding', 1)),
  kbIds: kbArg && typeof kbArg === 'string' ? kbArg.split(',').map((s) => Number(s.trim())) : null,
  noContext: argv.includes('--no-context'),
  full: argv.includes('--full'),
});

console.log(lines.join('\n'));
console.log(`—— 用时 ${elapsed()}（${queries.length} 个检索式并发；取原文为并发）`);
