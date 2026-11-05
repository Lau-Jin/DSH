/**
 * 工单事实抽取 —— SKILL.md Step 1~2 的核心逻辑。
 *
 * 抽成库函数是为了让 `scripts/triage.mjs` 能在**一个进程**里
 * 「取事实 + 检索知识库」一次跑完：每次脚本进程都要重付 TLS + initialize
 * （实测 ~224ms），多跑一个脚本就是多付一次。
 */
import fs from 'node:fs';
import { callTool, callToolsParallel, oneLine } from './mcp.mjs';

export async function ticketFacts(id, { raw = false } = {}) {
  const ticket = await callTool(
    'ticket_get_ticket_detail',
    /^\d+$/.test(String(id)) ? { ticketId: Number(id) } : { ticketNo: id }
  );

  if (raw) {
    const f = `ticket-${id}.json`;
    fs.writeFileSync(f, JSON.stringify(ticket, null, 2));
    console.error(`完整 JSON → ${f}`);
  }

  const logs = ticket.logs || [];
  const human = logs.filter((l) => l.logType !== 'ai');
  const ai = logs.filter((l) => l.logType === 'ai');
  const desc = ticket.descriptionText || '';
  const assignees = (ticket.assignees || []).map((a) => a.name);

  const L = [];
  const p = (...xs) => L.push(xs.join(' '));

  p(`=== 工单 ${ticket.ticketNo} ===`);
  p(`id=${ticket.id}  taskId=${ticket.taskId}`);
  p(`标题   ${ticket.title}`);
  p(`状态   ${ticket.ticketStatus}   类型 ${ticket.issueType}/${ticket.issueTypeName || ''}`);
  p(`发起人 ${ticket.initiatorName || '-'}    处理人 ${ticket.ownerName || '-'}`);
  if (assignees.length) p(`协办   ${assignees.join('、')}（${assignees.length}）`);
  p(`描述   ${oneLine(desc, 400)}`);
  p(`附件   ${(ticket.attachments || []).length} 个`);
  p(`处理记录 ${logs.length} 条 = 人工×${human.length} / ai×${ai.length}`);
  for (const l of logs.slice(0, 6)) {
    p(`        [${l.id}] ${l.logType} ${l.createdAt || ''} ${l.authorName || l.userDisplayName || ''}`);
    // ⚠️ 处理记录正文必须一起给出来：否则 agent 会自己写 calls.json 去 dump 原文，
    //    绕一大圈（实测：为此多花了 4 次工具调用 + 4 次文件读取）
    const body = l.contentText || l.content || '';
    if (body) {
      const cap = l.logType === 'ai' ? 600 : 400;
      p(`          ${oneLine(body, cap)}${body.length > cap ? ' …' : ''}`);
    }
  }
  p(`工时   ${JSON.stringify(ticket.worklogSummary || {})}`);

  // 描述内嵌的截图 URL（附件数为 0 时截图往往内嵌在描述里）
  const img = (ticket.description || '').match(/https?:\/\/[^"')\s]+\.(?:png|jpe?g|gif|webp)/i);
  if (img) p(`内嵌截图 ${img[0]}`);

  // 学校名工单字段没返回 → 从描述/日志抓候选，再用 meta_list_schools 核验
  const pool = [desc, ...logs.map((l) => l.contentText || '')].join(' ');
  const rawCand = [
    ...new Set(pool.match(/[\u4e00-\u9fa5]{2,14}?(?:职业技术学院|职业学院|技术学院|学院|学校|大学)/g) || []),
  ];

  // 校名核验与任务详情**并发**（两者都只依赖已取到的工单）
  const [schools, task] = await Promise.all([
    rawCand.length ? verifySchools(rawCand) : Promise.resolve([]),
    ticket.taskId
      ? callTool('task_get_task_detail', { taskId: ticket.taskId, logLimit: 50, worklogLimit: 50 })
      : Promise.resolve(null),
  ]);

  if (rawCand.length) {
    if (schools.length) {
      p(`学校 ${schools.map((s) => `${s.name}(id=${s.id} code=${s.code} 状态=${s.status})`).join(' / ')}  ✓已在校库核验`);
    } else {
      p(`学校候选 ${rawCand.slice(0, 4).join(' / ')}（⚠️ 未在校库核验到，需人工确认）`);
    }
  }

  if (task) {
    p(`关联任务 ${task.taskId}  状态=${task.status}  进度=${task.progress}  截止=${task.dueTime || '-'}  工时=${task.worklogsTotal ?? 0}条`);
    p(`        负责人=${task.ownerUserId ?? '-'}  产品=${task.productId ?? '-'}  描述长度=${task.descriptionLength ?? 0}`);
  }

  // ---- 判读提示：脚本算出来的状态矛盾 ----
  const W = [];
  const warn = (s) => W.push(`⚠️ ${s}`);
  if (/已处理|已解决|已修复|搞定|处理了/.test(desc) && human.length === 0) {
    warn('描述里出现"已处理"类措辞，但人工处理记录为 0 —— 描述不是处理记录，闭环前必须向发起人核实"已处理"具体做了什么');
  }
  if (ticket.ticketStatus === 'created') {
    warn('工单状态是 created，完成前需先 action="start"（或 ticket_start_ticket）');
  }
  if (ticket.ticketStatus && !['assigned', 'processing'].includes(ticket.ticketStatus)) {
    warn(`工单状态 ${ticket.ticketStatus} 不是 assigned/processing，先确认状态机允许的流转`);
  }
  if ((ticket.attachments || []).length === 0 && !img) {
    warn('既无附件也无内嵌截图 —— 现象信息可能只存在于描述里，检索词会很窄');
  }
  if (ticket.aiAnalysisStatus === 'success') {
    warn('平台 AI 分析已生成（logs 里的 ai 记录）—— 那是 AI 生成内容，只能当线索，不能当原文引用');
  }

  return { table: L, warns: W, ticket };
}

async function verifySchools(rawCand) {
  const verified = [];
  // 先 keyword 精确查（实测 48ms/89 字节），比拉全量列表（145ms/3.3KB）便宜
  try {
    const cands = rawCand.slice(0, 3);
    const rs = await callToolsParallel(
      cands.map((c) => ({ tool: 'meta_list_schools', args: { keyword: c.slice(0, 4), limit: 20 } }))
    );
    for (let i = 0; i < rs.length; i++) {
      const items = rs[i].data?.items || [];
      const hit = items.find((s) => s.name === cands[i] || (cands[i].length >= 4 && cands[i].includes(s.name)));
      if (hit && !verified.some((v) => v.id === hit.id)) verified.push(hit);
    }
  } catch { /* 校库查不到就退回候选 */ }
  // keyword 没命中 → 拉全量列表再核一遍（列表接口有 50 条上限，可能漏）
  if (!verified.length) {
    try {
      const all = (await callTool('meta_list_schools', { limit: 200 })).items || [];
      for (const c of rawCand) {
        const hit = all.find((s) => s.name === c || (c.length >= 4 && c.includes(s.name)));
        if (hit && !verified.some((v) => v.id === hit.id)) verified.push(hit);
      }
    } catch { /* 忽略 */ }
  }
  return verified;
}
