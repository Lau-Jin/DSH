/**
 * 原因分析 (root-cause analysis) on the 确认完成 (complete) path.
 *
 * The server refuses to close a ticket whose underlying task carries no
 * root-cause entry ("请先填写原因分析"), so the analysis is the required half
 * of a completion. The platform keeps a `root_cause` log type on the ticket's
 * task, and that is where the analysis belongs on its own: it stays readable
 * next to the conclusion instead of being mixed into it.
 *
 * The order matters. The analysis is written first: if it cannot be recorded,
 * the ticket stays open rather than closing without the reason it was closed
 * for. A server that does not know the `root_cause` type still gets the text —
 * as a processing comment — so the analysis is never dropped.
 *
 * The Host half is driven with a stub client, so the checks are about what
 * gets written, and in which order, without a live server.
 *
 * Run it with `node test/root-cause.test.mjs`.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTicketsApi } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** One ticket, as the panel holds it. */
const ticket = {
  ticketNo: 'FB202611020001',
  ticketId: 137,
  taskId: 42,
  action: 'complete',
  comment: '处理结论：同步任务已重跑。',
  rootCause: '原因分析：学校侧班级数据缺失导致同步失败。',
}

/**
 * A client that records every call.
 *
 * @param handler - optional; decides what a call answers, or throws.
 */
function stubClient(handler) {
  const calls = []
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args })
      if (handler) return handler(name, args)
      return { message: 'ok' }
    },
  }
}

/** The api operations, with a client that records its calls. */
function apiWith(handler) {
  const client = stubClient(handler)
  const api = createTicketsApi(client, () => ({ pageSize: 15 }))
  return { api, client }
}

/** The names of the calls, in the order they were made. */
function namesOf(client) {
  return client.calls.map(call => call.name)
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('the analysis is recorded as its own root-cause entry', async () => {
  const { api, client } = apiWith()
  await api.changeTicketStatus(ticket)
  const log = client.calls.find(call => call.name === 'task_add_task_log')
  assert.ok(log, 'the root-cause analysis must be recorded on the underlying task')
  assert.equal(log.args.logType, 'root_cause', 'the entry must carry the root_cause type')
  assert.equal(log.args.content, ticket.rootCause, 'the entry must hold the analysis')
  assert.equal(log.args.taskId, ticket.taskId, 'the entry must land on the ticket\'s task')
  assert.ok(log.args.idempotencyKey, 'the entry must carry an idempotency key, so a retry does not duplicate it')
})

check('the analysis is written before the ticket closes', async () => {
  const { api, client } = apiWith()
  await api.changeTicketStatus(ticket)
  const names = namesOf(client)
  assert.equal(names[0], 'task_add_task_log', 'the analysis comes first')
  assert.equal(names[1], 'ticket_update_ticket_status', 'the ticket closes after it')
})

check('the analysis doubles as the conclusion when none is given', async () => {
  const { api, client } = apiWith()
  await api.changeTicketStatus({ ...ticket, comment: '' })
  const status = client.calls.find(call => call.name === 'ticket_update_ticket_status')
  assert.ok(status, 'the ticket must be completed')
  assert.equal(status.args.action, 'complete')
  assert.equal(status.args.comment, ticket.rootCause, 'the analysis must reach the server as the conclusion')
  assert.equal(status.args.ticketId, ticket.ticketId)
})

check('a conclusion of its own still wins', async () => {
  const { api, client } = apiWith()
  await api.changeTicketStatus(ticket)
  const status = client.calls.find(call => call.name === 'ticket_update_ticket_status')
  assert.equal(status.args.comment, ticket.comment, 'the conclusion must reach the server')
})

check('the same analysis retried does not write a second entry', async () => {
  const { api, client } = apiWith()
  await api.changeTicketStatus(ticket)
  const first = client.calls.find(call => call.name === 'task_add_task_log').args.idempotencyKey
  const { api: api2, client: client2 } = apiWith()
  await api2.changeTicketStatus(ticket)
  const second = client2.calls.find(call => call.name === 'task_add_task_log').args.idempotencyKey
  assert.equal(first, second, 'the same analysis must carry the same key')
  const { api: api3, client: client3 } = apiWith()
  await api3.changeTicketStatus({ ...ticket, rootCause: '原因分析：改过的内容。' })
  const third = client3.calls.find(call => call.name === 'task_add_task_log').args.idempotencyKey
  assert.notEqual(first, third, 'an edited analysis is a new entry')
})

check('a server that does not know the root_cause type still records the analysis', async () => {
  const { api, client } = apiWith((name) => {
    if (name === 'task_add_task_log') throw new Error('logType root_cause is not accepted')
    return { message: 'ok' }
  })
  await api.changeTicketStatus(ticket)
  const fallback = client.calls.find(call => call.name === 'ticket_add_ticket_comment')
  assert.ok(fallback, 'the analysis must not be dropped')
  assert.equal(fallback.args.content, ticket.rootCause, 'the fallback must hold the analysis')
  assert.ok(namesOf(client).includes('ticket_update_ticket_status'), 'the ticket must still close')
})

check('an analysis that cannot be recorded leaves the ticket open', async () => {
  const { api, client } = apiWith((name) => {
    if (name === 'task_add_task_log' || name === 'ticket_add_ticket_comment') {
      throw new Error('the server said no')
    }
    return { message: 'ok' }
  })
  await assert.rejects(
    () => api.changeTicketStatus(ticket),
    /root-cause analysis was not recorded/,
    'the failure must say the analysis was lost',
  )
  assert.equal(
    namesOf(client).includes('ticket_update_ticket_status'),
    false,
    'the ticket must not close without its analysis',
  )
})

check('completing without an analysis points at the analysis step', async () => {
  const { api, client } = apiWith((name) => {
    if (name === 'task_list_task_logs') return { items: [] }
    return { message: 'ok' }
  })
  const result = await api.changeTicketStatus({ ...ticket, rootCause: '' })
  assert.equal(result?.ok, false, 'the completion is refused')
  assert.equal(result?.needRootCause, true, 'the panel is told which step comes first')
  assert.equal(
    namesOf(client).includes('ticket_update_ticket_status'),
    false,
    'nothing is closed without an analysis',
  )
})

check('the recorded analysis closes the ticket, with no box of its own', async () => {
  const recorded = '【原因分析】根因：数据源账号密码有误。'
  const { api, client } = apiWith((name) => {
    if (name === 'task_list_task_logs') {
      return { items: [{ logType: 'root_cause', contentText: recorded }] }
    }
    return { message: 'ok' }
  })
  const result = await api.changeTicketStatus({ ...ticket, rootCause: '', comment: '' })
  assert.equal(result?.ok, true, 'the completion goes through')
  const status = client.calls.find(call => call.name === 'ticket_update_ticket_status')
  assert.ok(status, 'the ticket must be completed')
  assert.equal(status.args.comment, recorded, 'the recorded analysis goes back as the conclusion')
  assert.equal(
    namesOf(client).includes('task_add_task_log'),
    false,
    'the analysis is already on the task',
  )
})

check('the analysis read asks for the root-cause entries', async () => {
  const { api, client } = apiWith((name, args) => {
    if (name === 'task_list_task_logs') {
      assert.equal(args.logType, 'root_cause', 'the read asks for the root-cause entries')
      return { items: [{ logType: 'root_cause', content: '【原因分析】根因：缓存未刷新。' }] }
    }
    return { message: 'ok' }
  })
  await api.changeTicketStatus({ ...ticket, rootCause: '', comment: '' })
  const status = client.calls.find(call => call.name === 'ticket_update_ticket_status')
  assert.equal(status.args.comment, '【原因分析】根因：缓存未刷新。')
})

check('the analysis is required, the conclusion is not', async () => {
  const { api, client } = apiWith()
  await api.changeTicketStatus({ ...ticket, comment: '' })
  assert.ok(
    namesOf(client).includes('task_add_task_log'),
    'the analysis must still be recorded without a conclusion',
  )
})

check('the ticket number is enough to find the task', async () => {
  const { api, client } = apiWith((name, args) => {
    if (name === 'ticket_get_ticket_detail') return { id: 137, taskId: 42 }
    return { message: 'ok' }
  })
  await api.changeTicketStatus({
    ticketNo: ticket.ticketNo,
    action: 'complete',
    comment: ticket.comment,
    rootCause: ticket.rootCause,
  })
  const log = client.calls.find(call => call.name === 'task_add_task_log')
  assert.ok(log, 'the analysis must be recorded even without ids in the request')
  assert.equal(log.args.taskId, 42, 'the task id comes from the ticket detail')
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`  FAIL  ${name}\n`)
    process.stdout.write(`        ${error instanceof Error ? error.message.split('\n').join('\n        ') : String(error)}\n`)
  }
}

process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`)
process.exit(failed === 0 ? 0 : 1)
