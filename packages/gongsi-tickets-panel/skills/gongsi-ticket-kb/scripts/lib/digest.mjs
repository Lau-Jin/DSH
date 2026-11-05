/**
 * 知识库检索 → 去重 → 自动核对原文 → 引用块。
 *
 * SKILL.md Step 3~5 的核心逻辑。抽成库函数是为了让 `scripts/triage.mjs`
 * 能在一个进程里连着跑「取工单事实 + 检索知识库」。
 */
import { callTool, callToolsParallel, oneLine } from './mcp.mjs';

export async function kbDigest(query, opts = {}) {
  const {
    queries = [query],
    topK = 5,
    minScore = 0.6,
    maxHits = 5,
    ctxChunks = 2,
    surrounding = 1,
    kbIds = null,
    noContext = false,
    full = false,
  } = opts;

  const notes = [];

  // kb_search 的响应体大小取决于命中的分片内容（图片识别块可以很大），
  // 常撞 64KB 对外通道预算 → 服务端返回 -32006。服务端自己给的建议就是收敛 top_k，
  // 这里自动做：报错就折半重试，直到能返回为止。
  async function searchOne(q) {
    let k = topK;
    for (;;) {
      try {
        const args = { query: q, top_k: k };
        if (kbIds && kbIds.length) args.kb_ids = kbIds;
        return await callTool('kb_search', args);
      } catch (e) {
        const overBudget = /-32006|64KB|通道预算/.test(e.message);
        if (!overBudget || k <= 2) throw e;
        const next = Math.max(2, Math.floor(k / 2));
        notes.push(`「${q}」响应超 64KB 通道预算，top_k ${k} → ${next} 收敛重试（重试要再花一次检索的时间）`);
        k = next;
      }
    }
  }

  // ⚠️ 多个检索式**并发**跑：串行 3 次 ≈ 5.1s，并发 ≈ 2.0s。
  //    SKILL.md 让人抽 3~5 个检索式 —— 这就是最大的延迟来源。
  const results = await Promise.all(queries.map((q) => searchOne(q)));

  // 合并多个检索式的命中，按 (source_id, chunk_index) 去重，分最高的留一个
  const merged = new Map();
  for (const res of results) {
    for (const it of res.items || []) {
      const key = `${it.source_id}#${it.chunk_index}`;
      const cur = merged.get(key);
      if (!cur || (it.score ?? 0) > (cur.score ?? 0)) merged.set(key, it);
    }
  }
  const allKbIds = [...new Set(results.flatMap((r) => r.kb_ids || []))];
  const items = [...merged.values()];
  const kept = items.filter((it) => (it.score ?? 0) >= minScore);
  const dropped = items.length - kept.length;

  // 同一文档可能命中多个分片 → 按 source_id 归并，但**每个命中的分片都要拉原文**：
  // 去重只用于摘要表，代表分片未必是最相关的那段（实测：doc 54878 的代表是 chunk 747，
  // 真正的答案在 chunk 1195，只拉代表分片会把关键原文漏掉）。
  const byDoc = new Map();
  for (const it of kept) {
    const cur = byDoc.get(it.source_id);
    if (!cur) {
      byDoc.set(it.source_id, { ...it, chunks: [{ chunk_index: it.chunk_index, score: it.score ?? 0 }] });
    } else {
      cur.chunks.push({ chunk_index: it.chunk_index, score: it.score ?? 0 });
    }
  }
  const docs = [...byDoc.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const d of docs) d.chunks.sort((a, b) => b.score - a.score);

  const L = [];
  const p = (...xs) => L.push(xs.join(' '));
  p(`=== KB 检索${queries.length > 1 ? ` ${queries.length} 式并发` : ''}「${queries.join('」 「')}」 ===`);
  p(`库 ${allKbIds.join(',')}  top_k=${topK}  命中 ${items.length} → 保留 ${kept.length}${dropped ? `（丢弃 ${dropped} 条 <${minScore}）` : ''} → 去重后 ${docs.length} 篇`);
  for (const n of notes) p(`· ${n}`);
  p('');

  // 可直接粘进【知识库依据】表格的行
  p('| 知识点 | 出处文档 | 原文要点 |');
  p('|---|---|---|');
  for (const d of docs.slice(0, maxHits)) {
    const snippet = oneLine(d.metadata?._hit_child?.content || d.content, 90);
    p(`| ${oneLine(snippet, 40)} | ${d.doc_title}（kb${d.kb_id}） | ${snippet} |`);
  }
  p('');

  // 先把要拉的原文列出来，**并发**取（串行 70ms×10=700ms，并发 ~150ms）
  const want = [];
  for (const d of docs.slice(0, maxHits)) {
    for (const c of d.chunks.slice(0, ctxChunks)) {
      want.push({ doc: d, chunk: c });
    }
  }
  // strict=false：某个分片取不到（无权限/不存在）**不该让整份引用块作废**
  const fetched = noContext
    ? []
    : await callToolsParallel(
        want.map((w) => ({
          tool: 'kb_get_context',
          args: { doc_id: w.doc.source_id, chunk_index: w.chunk.chunk_index, surrounding_count: surrounding },
        })),
        { strict: false }
      );

  const qaHits = [];
  for (const [i, d] of docs.slice(0, maxHits).entries()) {
    const idx = i + 1;
    const chunkList = d.chunks.map((c) => c.chunk_index).join(',');
    p(`--- ${idx}. ${d.doc_title}`);
    p(`    kb${d.kb_id} · doc ${d.source_id} · 命中分片 ${chunkList} · score ${(d.score ?? 0).toFixed(3)} · ${d.is_qa ? 'is_qa=true ⚠️ 仅线索' : '原文已核对'}`);
    const snippet = d.metadata?._hit_child?.content || d.content;
    p(`    命中片段  ${oneLine(snippet, 300)}`);
    if (d.is_qa) qaHits.push(d.doc_title);

    if (!noContext) {
      for (const w of want.filter((x) => x.doc.source_id === d.source_id)) {
        const got = fetched[want.indexOf(w)];
        if (got.error) {
          p(`    ⚠️ 原文 chunk ${w.chunk.chunk_index} 取不到：${got.error.slice(0, 120)}（其余引用块不受影响）`);
          continue;
        }
        const ctx = got.data;
        const chunks = ctx?.context_chunks || [];
        p(`    原文 chunk ${w.chunk.chunk_index} (${chunks.length} 段):`);
        for (const cc of chunks) {
          // 图片识别块是 OCR 式描述、又长又少作证 —— 默认压成一行，需要时 --full 展开
          const isImg = /图片识别结果/.test(cc.content || '');
          const cap = isImg && !full ? 150 : 420;
          const txt = oneLine(cc.content, cap);
          p(`      [${cc.chunk_index}] ${txt}${isImg && !full ? ' …［图片识别块已折叠，加 --full 展开］' : ''}`);
        }
      }
    }
    p('');
  }

  if (qaHits.length) {
    p(`⚠️ is_qa=true 的片段是 AI 生成问答（${qaHits.join('、')}），只能当线索，不可直接引用；引用一律以上面核对到的原文为准。`);
  }
  if (!docs.length) {
    p('⚠️ 没有命中任何文档 —— 按铁律 4，直接写"KB 未检索到"，不要用常识补齐。');
  } else {
    p(`📌 本轮已覆盖 ${docs.length} 篇文档 / ${docs.slice(0, maxHits).length} 篇核过原文。`);
    p(`   **若你要回答的问题不在上面这些命中里，就按铁律 4 写"KB 未检索到"** —— 不要继续加检索式硬凑。`);
  }

  return { lines: L, notes };
}
