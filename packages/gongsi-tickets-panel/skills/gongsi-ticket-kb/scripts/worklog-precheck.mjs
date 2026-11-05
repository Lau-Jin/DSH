#!/usr/bin/env node
/**
 * 记工时三条预检 —— 替代 SKILL.md §2 Step 8 的散文。
 *
 * 三条预检缺一不可（见 write-ops.md Step 8）：
 *   ① calendar_is_workday(date)               非工作日必须 isOvertime=true
 *   ② task_list_my_worklogs(当天)              工作日跨任务正常工时合计 ≤ 8h
 *   ③ task_list_task_worklogs(taskId)          同任务同日期已有记录 → 改用 task_update_worklog
 *
 * 用法：node scripts/worklog-precheck.mjs <taskId> <workDate> [hours] [--remark "..."]
 *
 * 只读，不写任何东西。输出里直接给出可用的 task_add_worklog 参数，
 * 但**是否执行仍然由人决定**（写操作走工具层，先确认再写）。
 */
import { callTool, guard } from './lib/mcp.mjs';

guard();

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const taskId = Number(pos[0]);
const workDate = pos[1];
const hours = pos[2] !== undefined ? Number(pos[2]) : 1;
const rIdx = argv.indexOf('--remark');
const remark = rIdx > -1 ? argv[rIdx + 1] : '';

if (!taskId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate || '')) {
  console.error('用法: node scripts/worklog-precheck.mjs <taskId> <YYYY-MM-DD> [hours] [--remark "..."]');
  process.exit(2);
}

const L = [];
const p = (...xs) => L.push(xs.join(' '));
const problems = [];
const notes = [];

p(`=== 工时预检  task=${taskId}  date=${workDate}  hours=${hours} ===`);

// ① 工作日
const cal = await callTool('calendar_is_workday', { date: workDate });
const isWorkday = cal.is_workday !== false;
let isOvertime = !isWorkday;
p(`${isWorkday ? '✓' : '✗'} ${workDate} ${isWorkday ? '是工作日' : '不是工作日'}${isWorkday ? ' → isOvertime=false' : ' → 必须 isOvertime=true'}`);

// ② 当天我的工时合计
const mine = await callTool('task_list_my_worklogs', { startDate: workDate, endDate: workDate, page: 1 });
const myItems = mine.items || [];
const myHours = myItems.reduce((s, w) => s + (Number(w.hours) || 0), 0);
const over8 = isWorkday && myHours + hours > 8;
p(`${over8 ? '✗' : '✓'} 当天我的工时合计 ${myHours.toFixed(1)}h / 工作日上限 8h${isWorkday ? `（本次再记 ${hours}h → ${(myHours + hours).toFixed(1)}h）` : '（非工作日不计入 8h 上限）'}`);
if (over8) problems.push(`当天工时会超 8h（${myHours}+${hours}），先合并或改记其它日期`);
if (myItems.length) {
  for (const w of myItems) p(`        已有: ${w.workDate} ${w.hours}h task=${w.taskId} ${w.remark || ''}`.trimEnd());
}

// ③ 同任务同日期是否已有记录
const taskLogs = await callTool('task_list_task_worklogs', { taskId, limit: 50, offset: 0 });
const sameDay = (taskLogs.items || []).find((w) => String(w.workDate).slice(0, 10) === workDate);
p(`${sameDay ? '✗' : '✓'} 任务 ${taskId} ${sameDay ? `当天已有工时记录（worklogId=${sameDay.id} ${sameDay.hours}h${sameDay.isOvertime ? ' 加班' : ''}）` : '当天无工时记录'}`);
if (sameDay) problems.push(`同任务同日期已有记录 → 用 task_update_worklog(taskId=${taskId}, worklogId=${sameDay.id}, workDate="${workDate}", hours=...) 改那条，不要再 add`);

// 任务当前状态（记工时的副作用）
let taskStatus = null;
try {
  const t = await callTool('task_get_task_detail', { taskId, logLimit: 1, worklogLimit: 1 });
  taskStatus = t.status;
  p(`· 任务当前状态=${taskStatus} 进度=${t.progress}`);
} catch (e) {
  p(`· 任务当前状态=${'未知(取任务详情失败)'}`);
  notes.push(`取任务详情失败(${e.message.slice(0, 80)}) → 副作用提示可能不全，写之前自己再确认一次任务状态`);
}

p('');
if (problems.length) {
  p('--- 结论：不能直接 add ---');
  for (const x of problems) p(`✗ ${x}`);
} else {
  p('--- 结论：可以 add（写操作仍需人工确认后再执行）---');
  const args = [`taskId=${taskId}`, `workDate="${workDate}"`, `hours=${hours}`];
  if (remark) args.push(`remark="${remark.replace(/"/g, '\\"')}"`);
  args.push(`isOvertime=${isOvertime}`);
  p(`task_add_worklog(${args.join(', ')})`);
  if (taskStatus === '新建') {
    p('⚠️ 副作用：记完工时会把任务从「新建」自动推到「进行中」');
  }
  if (!isWorkday) {
    p('⚠️ 副作用：非工作日记的正常工时会被拒（已按 isOvertime=true 处理）');
  }
  notes.push('同任务+同日期+同类型唯一，重复 add 会报冲突 → 改用 task_update_worklog');
  notes.push('非管理员只能改本人工时，且须创建后 3 天内');
}
if (notes.length) {
  p('');
  p('--- 提醒 ---');
  for (const n of notes) p(`· ${n}`);
}

console.log(L.join('\n'));
process.exit(problems.length ? 1 : 0);
