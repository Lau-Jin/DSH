/**
 * Host half of the gongsi ticket panel bundle.
 *
 * The plugin owns one read-only operation family over the gongsi MCP server:
 * list the tickets the signed-in account can see, either as a flat "all" window
 * or filtered to the tickets it owns ("mine"). Both views come from the single
 * server tool `ticket_list_my_tickets`, which the server already scopes to the
 * caller's visibility; there is no separate "all tickets" endpoint.
 *
 * The operation is exposed twice from one implementation:
 *
 *   - as the global slash command `/gongsi-tickets [all|mine|detail <no>|act <json>]`,
 *     which the Web Client reaches through the already-mounted `commands` Remote
 *     namespace (this is the path the left-sidebar panel uses), and
 *   - as the agent tools `gongsi_tickets` (read), `gongsi_ticket_action`
 *     (comment / worklog / assignment / status change), `gongsi_create_ticket`
 *     (file a new ticket), and `gongsi_tickets_meta` (the reference data a new
 *     ticket needs).
 *
 * The write side is deliberately narrow: a processing comment, a worklog on the
 * ticket's underlying task, a new owner, the ticket's status (开始处理 /
 * 确认完成), and filing a new ticket. Nothing else about a ticket can be
 * changed from here.
 *
 * All Config fields are marked volatile: the settings service only projects
 * fields whose nearest ancestor declares `volatile`, and a plugin with none is
 * excluded from the configuration surface entirely. Volatile values arrive as
 * `Volatile<T>` wrappers, so every read goes through `read()` and edits apply
 * without a host restart.
 */
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin's own directory, so the bundled skill can be located. */
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * The KB skill that ships inside this package.
 *
 * It is the team's own `gongsi-ticket-kb` skill, copied in so the quote feature
 * works on a machine that never had it. A copy the machine serves locally wins:
 * the bundled one is only a fallback.
 */
const BUNDLED_SKILL_DIR = join(PLUGIN_ROOT, 'skills', 'gongsi-ticket-kb')

/**
 * Where the KB skill actually lives on this machine.
 *
 * The quote flow has to hand the agent a **runnable command**, and a command
 * needs an absolute path. The machine's own copy wins (it is the one the user
 * keeps updated); the bundled copy is the fallback for a machine that never
 * had the skill.
 *
 * `--auto` is what makes the command worth handing over: it derives the search
 * terms from the ticket itself, so the agent does not have to read the ticket
 * first and then decide what to search for — that extra round trip is what
 * made the quote feel slow.
 */
function resolveKbSkillDir() {
  const candidates = [
    join(homedir(), '.dsh', 'skills', 'gongsi-ticket-kb'),
    BUNDLED_SKILL_DIR,
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'scripts', 'triage.mjs'))) return dir
  }
  return BUNDLED_SKILL_DIR
}

/** True when this KB copy understands `--auto` (older copies do not). */
function kbSupportsAuto(dir) {
  try {
    return readFileSync(join(dir, 'scripts', 'triage.mjs'), 'utf8').includes("'--auto'")
  } catch {
    return false
  }
}

/**
 * Split one SKILL.md into its frontmatter and its body.
 *
 * The registry wants the body; the frontmatter's `name` and `description` are
 * already carried by the registration fields.
 */
function splitFrontmatter(markdown) {
  const text = String(markdown ?? '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { meta, body: text.slice(match[0].length) }
}

/** Default MCP endpoint of the gongsi development platform. */
const DEFAULT_ENDPOINT = 'https://yanfa.scedu.tech/api/mcp'

/** The gongsi tool that lists the tickets visible to the caller. */
const LIST_TOOL = 'ticket_list_my_tickets'

/** The gongsi tool that returns one ticket's read-only detail. */
const DETAIL_TOOL = 'ticket_get_ticket_detail'

/** The gongsi tool that appends one processing comment to a ticket. */
const COMMENT_TOOL = 'ticket_add_ticket_comment'

/** The gongsi tool that records one worklog on a task. */
const WORKLOG_TOOL = 'task_add_worklog'

/** The gongsi tool that appends one typed log entry to a task. */
const TASK_LOG_TOOL = 'task_add_task_log'

/** The gongsi tool that lists a task's log entries, optionally by type. */
const LOG_LIST_TOOL = 'task_list_task_logs'

/** The gongsi tool that assigns a ticket's owner. */
const ASSIGN_TOOL = 'ticket_assign_ticket'

/** The gongsi tool that advances a ticket's status (start / complete / cancel). */
const STATUS_TOOL = 'ticket_update_ticket_status'

/** The gongsi tool that creates a ticket. */
const CREATE_TOOL = 'ticket_create_ticket'

/** The gongsi tool that uploads one attachment (a screenshot, say) to a ticket. */
const ATTACHMENT_TOOL = 'biz_upload_attachment'

/** The server accepts one file per call, up to this many bytes. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** The gongsi tool that lists the issue types a ticket can be filed under. */
const ISSUE_TYPES_TOOL = 'ticket_list_issue_types'

/** The gongsi tool that lists the schools (projects). */
const SCHOOLS_TOOL = 'meta_list_schools'

/** The gongsi tool that lists the products (involved systems). */
const PRODUCTS_TOOL = 'meta_list_products'

/** The gongsi tool that lists the versions of one product. */
const VERSIONS_TOOL = 'meta_list_product_versions'

/** The server caps one page at this many rows. */
const REF_PAGE_SIZE = 50

/** The gongsi tool that lists the (desensitized) user directory. */
const USERS_TOOL = 'meta_list_users'

/** The server caps one user-directory page at this many rows. */
const USER_PAGE_SIZE = 50

/** The gongsi tool that lists the caller's own tasks, used to learn who "I" am. */
const MY_TASKS_TOOL = 'task_list_my_tasks'

/** The server rejects larger page sizes; 40 is its documented ceiling. */
const MAX_PAGE = 40

/** How many tickets one page shows by default. */
const DEFAULT_PAGE_SIZE = 15

/** How many pages to scan when collecting the caller's own tickets. */
const MAX_SCAN_PAGES = 6

/**
 * Configuration for the ticket panel.
 *
 * `apiKey` is declared with `role('secret')`, so the Host settings service
 * redacts it from every read and the Web UI can only ever write it. Every field
 * is `volatile()` so the settings page can edit it live; a field that is not
 * volatile makes its whole form invisible.
 */
export const Config = z.object({
  endpoint: z.string()
    .default(DEFAULT_ENDPOINT)
    .description('gongsi MCP endpoint (streamable-HTTP)')
    .volatile(),
  apiKey: z.string()
    .role('secret')
    .default('')
    .description('gongsi API key, sent as the Authorization header')
    .volatile(),
  pageSize: z.number()
    .min(1)
    .max(MAX_PAGE)
    .step(1)
    .default(DEFAULT_PAGE_SIZE)
    .description('How many tickets one page shows')
    .volatile(),
  requestTimeoutMs: z.number()
    .min(1000)
    .max(120000)
    .default(20000)
    .description('Per-request timeout for the MCP round trip')
    .volatile(),
})

/** Read one config value, unwrapping the volatile reference when present. */
function read(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/** Clamp one requested row count into the range the server accepts. */
function clampLimit(value, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(MAX_PAGE, n))
}

/** Build the Authorization header value for one configured key. */
function authorizationOf(apiKey) {
  const key = String(apiKey ?? '').trim()
  if (!key) return ''
  return /^bearer\s/i.test(key) ? key : `Bearer ${key}`
}

/**
 * Parse one MCP response body. The server answers either with plain JSON or with
 * an SSE stream; both shapes carry the same JSON-RPC frame.
 */
function parseBody(text, contentType) {
  if (contentType && contentType.includes('text/event-stream')) {
    const frames = []
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n')
      if (!data) continue
      try {
        frames.push(JSON.parse(data))
      } catch {
        // A frame that is not JSON carries no JSON-RPC message; skip it.
      }
    }
    return frames
  }
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 2000) }
  }
}

/** Pick the first JSON-RPC result (or error) out of one parsed body. */
function unwrap(body) {
  const frames = Array.isArray(body) ? body : [body]
  for (const frame of frames) {
    if (frame && frame.result) return frame.result
    if (frame && frame.error) return { error: frame.error }
  }
  return undefined
}

/** Parse one content block's JSON text, or pass the value through. */
function parseContent(text) {
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * A minimal streamable-HTTP MCP client.
 *
 * Endpoint and key are re-read on every round trip, so a live config edit takes
 * effect on the next refresh; a change to either discards the cached session and
 * forces a fresh handshake.
 */
class GongsiMcpClient {
  /** @param readConfig - returns the current `{ endpoint, apiKey, timeoutMs }`. */
  constructor(readConfig) {
    this.readConfig = readConfig
    this.sessionId = null
    this.initialized = false
    this.pending = null
    this.identity = null
  }

  /** Current transport settings, and a discriminator for cache invalidation. */
  settings() {
    const current = this.readConfig()
    const authorization = authorizationOf(current.apiKey)
    return {
      endpoint: String(current.endpoint || DEFAULT_ENDPOINT),
      authorization,
      timeoutMs: Number(current.timeoutMs) > 0 ? Number(current.timeoutMs) : 20000,
      identity: `${current.endpoint}\u0000${authorization}`,
    }
  }

  /** Drop the cached session when the endpoint or key changed. */
  sync() {
    const settings = this.settings()
    if (this.identity !== null && this.identity !== settings.identity) {
      this.sessionId = null
      this.initialized = false
      this.pending = null
    }
    this.identity = settings.identity
    return settings
  }

  /** POST one JSON-RPC message and return the parsed body. */
  async post(message) {
    const settings = this.sync()
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    }
    if (settings.authorization) headers.Authorization = settings.authorization
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
    try {
      const response = await fetch(settings.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      const session = response.headers.get('mcp-session-id')
      if (session) this.sessionId = session
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`gongsi MCP HTTP ${response.status}: ${text.slice(0, 300)}`)
      }
      return parseBody(text, response.headers.get('content-type'))
    } finally {
      clearTimeout(timer)
    }
  }

  /** Run the initialize handshake once per client identity. */
  async ensureInitialized() {
    this.sync()
    if (this.initialized) return
    if (this.pending) return this.pending
    this.pending = (async () => {
      await this.post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-gongsi-tickets-panel', version: '1.0.5' },
        },
      })
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
      this.initialized = true
    })()
    try {
      await this.pending
    } finally {
      this.pending = null
    }
  }

  /**
   * Call one gongsi tool and return its structured result.
   *
   * @param tool - exact gongsi tool name.
   * @param args - the tool's arguments object.
   * @returns the tool's structured content.
   */
  async callTool(tool, args) {
    await this.ensureInitialized()
    const body = await this.post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: tool, arguments: args ?? {} },
    })
    const result = unwrap(body)
    if (!result) throw new Error(`gongsi MCP returned no result for ${tool}`)
    if (result.error) {
      throw new Error(`${tool} failed: ${JSON.stringify(result.error)}`)
    }
    // A tool-level failure arrives as `isError: true` with the message in the
    // content, not as a JSON-RPC error. Both must be rejected, otherwise an
    // error envelope would be mistaken for an empty ticket list.
    if (result.isError === true) {
      const text = typeof result.content?.[0]?.text === 'string'
        ? result.content[0].text
        : JSON.stringify(result)
      throw new Error(`${tool} failed: ${text}`)
    }
    const data = result.structuredContent ?? parseContent(result.content?.[0]?.text)
    if (data && typeof data === 'object' && data.code !== undefined && data.message !== undefined) {
      throw new Error(`${tool} failed: ${JSON.stringify(data)}`)
    }
    return data
  }
}

/**
 * Reduce one raw ticket to the fields the panel renders.
 *
 * Only plain, already-public fields are copied, so the Client never receives a
 * field the panel does not draw.
 */
function summarize(ticket) {
  return {
    ticketNo: ticket.ticketNo ?? '',
    /** Numeric ticket id: the write tools key on it, not the ticket number. */
    ticketId: typeof ticket.id === 'number' && Number.isInteger(ticket.id) ? ticket.id : 0,
    /** The underlying task's id: worklogs attach to it. */
    taskId: typeof ticket.taskId === 'number' && Number.isInteger(ticket.taskId) ? ticket.taskId : 0,
    title: ticket.title ?? '',
    status: ticket.ticketStatus ?? '',
    priority: ticket.priority ?? '',
    schoolName: ticket.schoolName ?? '',
    productName: ticket.productName ?? '',
    ownerName: ticket.ownerName ?? '',
    ownerUserId: typeof ticket.ownerUserId === 'number' ? ticket.ownerUserId : 0,
    /** Who raised the ticket; shown next to the owner on every row. */
    initiatorName: ticket.initiatorName ?? '',
    issueType: ticket.issueType ?? '',
    createdAt: ticket.createdAt ?? '',
    updatedAt: ticket.updatedAt ?? '',
    dueTime: ticket.dueTime ?? '',
  }
}

/**
 * The images embedded in one rich-text body.
 *
 * The gongsi form keeps a ticket's description and every activity log as HTML
 * with `<img>` tags inside; the server's `contentText` projection is the same
 * body with the images stripped. Rather than ship markup to the browser, the
 * URLs are lifted out here and the Client draws plain `<img>` tags: nothing the
 * server sends can inject script into the panel.
 *
 * Only absolute http(s) URLs are kept, so a `javascript:` or `data:` source in
 * the body can never reach an `src`.
 *
 * @param html - one rich-text body; anything that is not a string is ignored.
 * @returns `[{ src, alt }]`, in document order, without duplicates.
 */
function imagesIn(html) {
  if (typeof html !== 'string' || html === '') return []
  const out = []
  const seen = new Set()
  // `<img …>`: pull `src` and `alt` out of each tag, in any attribute order.
  // The leading `[\s]` keeps `data-src` from passing as `src`.
  const tagPattern = /<img\b[^>]*>/gi
  const srcPattern = /[\s]src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
  const altPattern = /[\s]alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
  for (const tag of html.match(tagPattern) ?? []) {
    const src = srcPattern.exec(tag)
    const raw = (src?.[1] ?? src?.[2] ?? src?.[3] ?? '').trim()
    if (raw === '') continue
    let url
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    const src_ = url.href
    if (seen.has(src_)) continue
    seen.add(src_)
    const alt = altPattern.exec(tag)
    const label = (alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? '').trim()
    out.push(label === '' ? { src: src_ } : { src: src_, alt: label })
  }
  return out
}

/**
 * Reduce one raw detail to the fields the panel renders.
 *
 * The text fields stay plain: the server already ships a `contentText`
 * projection of every rich body. The images inside those bodies are lifted out
 * separately (see `imagesIn`), so the Client renders them without ever having
 * to trust markup.
 *
 * @param detail - the raw `ticket_get_ticket_detail` payload.
 * @returns the summarized, render-ready detail.
 */
function summarizeDetail(detail) {
  const attachments = (Array.isArray(detail.attachments) ? detail.attachments : []).map(file => {
    const entry = {
      name: String(file?.name ?? file?.fileName ?? ''),
      createdAt: String(file?.createdAt ?? ''),
    }
    if (typeof file?.size === 'number') entry.size = file.size
    if (file?.uploaderName) entry.uploaderName = String(file.uploaderName)
    return entry
  })
  const logs = (Array.isArray(detail.logs) ? detail.logs : []).map(log => ({
    id: typeof log?.id === 'number' ? log.id : 0,
    logType: String(log?.logType ?? ''),
    authorName: String(log?.authorName ?? ''),
    createdAt: String(log?.createdAt ?? ''),
    contentText: String(log?.contentText ?? ''),
    /** The screenshots the author pasted into this entry. */
    images: imagesIn(log?.content),
  }))
  const summary = {
    ticketNo: String(detail.ticketNo ?? ''),
    /** Numeric ticket id: the write tools key on it, not the ticket number. */
    ticketId: typeof detail.id === 'number' && Number.isInteger(detail.id) ? detail.id : 0,
    /** The underlying task's id: worklogs attach to it. */
    taskId: typeof detail.taskId === 'number' && Number.isInteger(detail.taskId) ? detail.taskId : 0,
    title: String(detail.title ?? ''),
    status: String(detail.ticketStatus ?? ''),
    issueTypeName: String(detail.issueTypeName ?? ''),
    initiatorName: String(detail.initiatorName ?? ''),
    ownerName: String(detail.ownerName ?? ''),
    assignees: (Array.isArray(detail.assignees) ? detail.assignees : [])
      .map(person => (typeof person?.name === 'string' ? person.name : ''))
      .filter(Boolean),
    descriptionText: String(detail.descriptionText ?? ''),
    /** The screenshots the reporter pasted into the description. */
    descriptionImages: imagesIn(detail.description),
    feedback: typeof detail.feedback === 'string' ? detail.feedback : '',
    /** The screenshots in the conclusion, when it is rich text. */
    feedbackImages: imagesIn(detail.feedback),
    worklogTotalHours: numberOrZero(detail.worklogSummary?.totalHours),
    worklogPersonDays: numberOrZero(detail.worklogSummary?.personDays),
    processCostPersonDays: numberOrZero(detail.processCostPersonDays),
    aiAnalysisStatus: String(detail.aiAnalysisStatus ?? ''),
    aiAnalyzedAt: String(detail.aiAnalyzedAt ?? ''),
    attachments,
    logs,
  }
  // A score is only present once the ticket was rated; the output schema keeps
  // it optional so `null` never has to masquerade as a number.
  if (typeof detail.score === 'number') summary.score = detail.score
  return summary
}

/**
 * Render one ticket list as the text the model reads.
 *
 * @param tickets - the ticket summaries.
 * @param heading - one line naming the view.
 * @returns a compact, human-readable listing.
 */
function renderTickets(tickets, heading) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return `${heading}\nNo gongsi tickets were returned.`
  }
  const rows = tickets.map(ticket => {
    const school = ticket.schoolName ? ` · ${ticket.schoolName}` : ''
    const product = ticket.productName ? ` · ${ticket.productName}` : ''
    const owner = ticket.ownerName ? ` · ${ticket.ownerName}` : ''
    return `${ticket.ticketNo} [${ticket.status}/${ticket.priority}] ${ticket.title}${school}${product}${owner} · ${ticket.createdAt}`
  })
  return `${heading}\n${rows.join('\n')}`
}

/**
 * Render one ticket detail as the text the model reads.
 *
 * @param detail - the summarized detail.
 * @returns a compact, human-readable block.
 */
function renderDetail(detail) {
  const meta = [
    `状态: ${detail.status}`,
    `类型: ${detail.issueTypeName}`,
    `发起人: ${detail.initiatorName}`,
    `处理人: ${detail.ownerName}`,
    detail.assignees.length ? `协办: ${detail.assignees.join(', ')}` : '',
    `工时: ${detail.worklogTotalHours}h (${detail.worklogPersonDays}人天)`,
    typeof detail.score === 'number' ? `评分: ${detail.score}` : '',
  ].filter(Boolean).join(' · ')
  // Images are invisible to a text reader, so their addresses are named here:
  // the panel draws them, and the model can still cite them.
  const images = list => (Array.isArray(list) && list.length
    ? `\n[${list.length} image${list.length === 1 ? '' : 's'}: ${list.map(image => image.src).join(', ')}]`
    : '')
  const description = detail.descriptionText ? `\n描述:\n${detail.descriptionText}${images(detail.descriptionImages)}` : ''
  const feedback = detail.feedback ? `\n处理结论:\n${detail.feedback}${images(detail.feedbackImages)}` : ''
  const attachments = detail.attachments.length
    ? `\n附件: ${detail.attachments.map(file => file.name).join(', ')}`
    : ''
  const logs = detail.logs.length
    ? `\n处理记录:\n${detail.logs
        .map(log => `[${log.createdAt}] ${log.authorName} (${log.logType}): ${log.contentText}${images(log.images)}`)
        .join('\n')}`
    : ''
  return `gongsi ticket ${detail.ticketNo}: ${detail.title}\n${meta}${description}${feedback}${attachments}${logs}`
}

/**
 * Create the shared ticket operations for one plugin instance.
 *
 * Exported so the self-checks can drive the operations with a stub client:
 * the write paths (what gets written, in which order) are worth asserting
 * without a live server.
 *
 * @param client - the MCP client owned by this instance.
 * @param readConfig - returns the current `{ pageSize }`.
 * @returns the ticket operations used by the command and the tools.
 */
export function createTicketsApi(client, readConfig) {
  /** Cached identity: `undefined` = not resolved, `null` = not detectable. */
  let myUserId
  /** Display name learned from any ticket already fetched. */
  let myName = ''
  /** The key the cached identity was detected with. */
  let myIdentityKey = ''

  /**
   * Learn the caller's own user id.
   *
   * The server exposes no "who am I" tool, but `task_list_my_tasks` returns the
   * caller's own tasks and marks ownership: the `owner_user_id` of a row whose
   * `is_owner` is 1 is the caller. The id always follows the API key in use, so
   * it is detected rather than configured, and re-detected when the key changes.
   *
   * @returns the caller's user id, or null when it cannot be determined.
   */
  async function resolveMyUserId() {
    // One key can only ever be one person: a different key forgets the answer.
    const key = String(read(readConfig().apiKey) ?? '')
    if (key !== myIdentityKey) {
      forgetIdentity()
      myIdentityKey = key
    }
    if (myUserId !== undefined) return myUserId

    for (let page = 1; page <= 3; page += 1) {
      const data = await client.callTool(MY_TASKS_TOOL, { limit: 20, page })
      const items = Array.isArray(data?.items) ? data.items : []
      if (items.length === 0) break
      const owned = items.find(item => item.is_owner === 1 || item.is_owner === true)
      if (owned && typeof owned.owner_user_id === 'number') {
        myUserId = owned.owner_user_id
        return myUserId
      }
      if (items.length < 20) break
    }

    myUserId = null
    return myUserId
  }

  /** Forget the detected identity, so the next read re-detects it. */
  function forgetIdentity() {
    myUserId = undefined
    myName = ''
  }

  /** Remember the caller's display name from one fetched batch, once. */
  function rememberName(tickets, myId) {
    if (myName || myId === null) return myName
    const own = tickets.find(ticket => ticket.ownerUserId === myId && ticket.ownerName)
    if (own) myName = own.ownerName
    return myName
  }

  /**
   * One page of the tickets the panel shows.
   *
   * `tab: 'all'` pages on the server. `tab: 'mine'` cannot: ownership is not a
   * server-side filter, so the whole set is scanned and then sliced.
   *
   * The server filters by keyword, status, and issue type; the school, the
   * creator, and the priority are not server-side, so the panel narrows those
   * itself on the rows it holds.
   *
   * @param request - `{ tab, page, pageSize, keyword, ticketStatus, issueType }`.
   * @returns `{ me, total, tickets, page, pageSize, pages }`.
   */
  async function listTickets(request) {
    const config = readConfig()
    const pageSize = clampLimit(request?.pageSize ?? read(config.pageSize), DEFAULT_PAGE_SIZE)
    const page = Math.max(1, Math.floor(Number(request?.page)) || 1)
    const tab = request?.tab === 'mine' ? 'mine' : 'all'
    const myId = await resolveMyUserId()
    // The server-side filters, passed through untouched.
    const filters = {}
    const keyword = String(request?.keyword ?? '').trim()
    if (keyword) filters.keyword = keyword
    const ticketStatus = String(request?.ticketStatus ?? '').trim()
    if (ticketStatus) filters.ticketStatus = ticketStatus
    const issueType = String(request?.issueType ?? '').trim()
    if (issueType) filters.issueType = issueType

    if (tab === 'all') {
      const data = await client.callTool(LIST_TOOL, { limit: pageSize, page, ...filters })
      const items = Array.isArray(data?.items) ? data.items : []
      const tickets = items.slice(0, pageSize).map(ticket => {
        const summary = summarize(ticket)
        return { ...summary, mine: myId !== null && summary.ownerUserId === myId }
      })
      const total = numberOrZero(data?.total)
      return {
        me: meSummary(tickets, myId, rememberName(tickets, myId)),
        total,
        tickets,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(total / pageSize)),
      }
    }

    // Ownership is not server-side, so the whole set is scanned once and the
    // caller's own rows are paged here.
    const all = await listAllTickets(filters)
    const own = myId === null
      ? []
      : all.tickets
        .filter(ticket => ticket.ownerUserId === myId)
        .map(ticket => ({ ...ticket, mine: true }))
    const total = own.length
    return {
      me: meSummary(own, myId, rememberName(own, myId)),
      total,
      tickets: own.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    }
  }

  /**
   * One ticket's read-only detail: description, conclusion, worklog totals,
   * attachments, and the activity log.
   *
   * @param ticketNo - exact ticket number, e.g. FB202610270002.
   * @returns the summarized detail.
   */
  async function getTicketDetail(ticketNo) {
    const no = String(ticketNo ?? '').trim()
    if (!no) throw new Error('ticketNo is required')
    const data = await client.callTool(DETAIL_TOOL, { ticketNo: no })
    return summarizeDetail(data ?? {})
  }

  /** Read one request's ticket number, rejecting empties. */
  function requireTicketNo(request) {
    const no = String(request?.ticketNo ?? '').trim()
    if (!no) throw new Error('ticketNo is required')
    return no
  }

  /**
   * One ticket's numeric id. The write tools key on it, so a client that
   * already holds the detail passes it along; otherwise it is resolved with
   * one extra detail read.
   */
  async function resolveTicketId(request) {
    const given = Number(request?.ticketId)
    if (Number.isInteger(given) && given > 0) return given
    const data = await client.callTool(DETAIL_TOOL, { ticketNo: requireTicketNo(request) })
    const id = Number(data?.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error(`ticket ${request.ticketNo} has no numeric id`)
    return id
  }

  /** One ticket's underlying task id, resolved the same way. */
  async function resolveTaskId(request) {
    const given = Number(request?.taskId)
    if (Number.isInteger(given) && given > 0) return given
    const data = await client.callTool(DETAIL_TOOL, { ticketNo: requireTicketNo(request) })
    const taskId = Number(data?.taskId)
    if (!Number.isInteger(taskId) || taskId <= 0) throw new Error(`ticket ${request.ticketNo} has no underlying task`)
    return taskId
  }

  /** Append one processing comment (处理说明) to a ticket. */
  async function addComment(request) {
    const content = String(request?.content ?? '').trim()
    if (!content) throw new Error('content is required')
    const ticketId = await resolveTicketId(request)
    const args = { ticketId, content }
    const idempotencyKey = String(request?.idempotencyKey ?? '').trim()
    if (idempotencyKey) args.idempotencyKey = idempotencyKey
    return summarizeAction(await client.callTool(COMMENT_TOOL, args))
  }

  /** Record one worklog on the ticket's underlying task. */
  async function addWorklog(request) {
    const hours = Number(request?.hours)
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('hours must be a positive number')
    const taskId = await resolveTaskId(request)
    const args = {
      taskId,
      workDate: normalizeWorkDate(request?.workDate ?? request?.date),
      hours,
    }
    const remark = String(request?.remark ?? '').trim()
    if (remark) args.remark = remark
    if (request?.isOvertime === true) args.isOvertime = true
    const progress = Number(request?.progress)
    if (Number.isFinite(progress) && progress >= 0 && progress <= 100) args.progress = progress
    return summarizeAction(await client.callTool(WORKLOG_TOOL, args))
  }

  /** Assign (or reassign) a ticket's owner; the previous owner becomes an associate. */
  async function assignTicket(request) {
    const ownerUserId = Number(request?.ownerUserId)
    if (!Number.isInteger(ownerUserId) || ownerUserId <= 0) {
      throw new Error('ownerUserId must be a positive integer')
    }
    const ticketId = await resolveTicketId(request)
    return summarizeAction(await client.callTool(ASSIGN_TOOL, { ticketId, ownerUserId }))
  }

  /**
   * Record the root-cause analysis as its own entry on the ticket's task.
   *
   * The server asks for the analysis before it lets a ticket close: the
   * complete action refuses a ticket whose task carries no `root_cause` entry
   * ("请先填写原因分析"). The platform keeps a `root_cause` log type for
   * exactly this, and the panel prints the type next to every entry — so the
   * analysis stays readable next to the conclusion. A server that does not
   * know the type gets the same text as a processing comment: the analysis is
   * never dropped on the floor.
   *
   * @param request - the caller's request; it carries the ticket and task ids.
   * @param text - the root-cause analysis.
   * @returns how it was recorded: `root_cause` or `comment`.
   */
  async function writeRootCause(request, text) {
    const ticketId = await resolveTicketId(request)
    const taskId = await resolveTaskId(request)
    const subject = String(request?.ticketNo ?? '').trim() || String(request?.ticketId ?? '')
    // The key carries the content: the same analysis retried does not write a
    // second entry, but an edited analysis is a new entry.
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 8)
    const idempotencyKey = `gongsi-rootcause-${subject}-${digest}`
    try {
      await client.callTool(TASK_LOG_TOOL, { taskId, content: text, logType: 'root_cause', idempotencyKey })
      return 'root_cause'
    } catch (error) {
      const first = error instanceof Error ? error.message : String(error)
      try {
        await client.callTool(COMMENT_TOOL, { ticketId, content: text, idempotencyKey })
        return 'comment'
      } catch (fallbackError) {
        const second = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        throw new Error(`the root-cause analysis was not recorded (${first}; fallback: ${second}), so the ticket was not completed`)
      }
    }
  }

  /**
   * Which of these tickets already carry a root-cause entry.
   *
   * The panel only shows 确认完成 on a ticket that has one, so it asks once per
   * list: the rows of mine that are being worked on. A ticket whose task
   * cannot be read is left out, and the panel then keeps the link — the
   * server stays the judge rather than a failed read hiding a way to close.
   *
   * @param request - `{ items: [{ ticketNo, taskId }] }`, at most 20 of them.
   * @returns `{ flags: { [ticketNo]: true } }` for the tickets that have one.
   */
  async function readRootCauseFlags(request) {
    const items = Array.isArray(request?.items) ? request.items.slice(0, 20) : []
    const flags = {}
    for (const item of items) {
      const ticketNo = String(item?.ticketNo ?? '').trim()
      if (!ticketNo) continue
      try {
        const text = await readRecordedRootCause({ ticketNo, taskId: item?.taskId })
        flags[ticketNo] = text !== ''
      } catch {
        // Nothing to say about this one: leave it out.
      }
    }
    return { flags }
  }

  /**
   * The root-cause analysis already recorded on the ticket's task.
   *
   * The server refuses to close a ticket without one, so this is both the
   * gate the panel sees and the text the completion sends back as the
   * conclusion. The newest entry wins: a ticket worked on twice keeps the
   * analysis of the round that closed it.
   *
   * @param request - the caller's request; it carries the ticket and task ids.
   * @returns the analysis text, or '' when none is recorded yet.
   */
  async function readRecordedRootCause(request) {
    const taskId = await resolveTaskId(request)
    let data
    try {
      data = await client.callTool(LOG_LIST_TOOL, { taskId, logType: 'root_cause', limit: 1 })
    } catch {
      // An older server without the log listing cannot answer; the write path
      // below still records the analysis when one is handed over.
      return ''
    }
    const items = Array.isArray(data?.items) ? data.items : []
    const entry = items.find(item => String(item?.logType ?? '') === 'root_cause')
    return String(entry?.contentText ?? entry?.content ?? '').trim()
  }

  /**
   * Record one root-cause analysis on the ticket's task.
   *
   * This is the 原因分析 step the panel offers between 开始处理 and 确认完成.
   * The entry is what the server asks for before it lets a ticket close.
   */
  async function addRootCause(request) {
    const content = String(request?.content ?? request?.rootCause ?? '').trim()
    if (!content) throw new Error('the root-cause analysis is required')
    const how = await writeRootCause(request, content)
    if (how !== 'root_cause') {
      return { ok: true, message: 'the analysis was saved as a ticket comment instead of a root_cause task log' }
    }
    return { ok: true, message: 'the root-cause analysis is recorded' }
  }

  /**
   * Advance a ticket's status.
   *
   * `start` moves an assigned ticket into processing. `complete` closes it,
   * and the server only lets a ticket close when its task already carries a
   * root-cause entry — so the analysis is the step before the completion, not
   * part of it. When the caller hands one over it is written first; otherwise
   * the one already recorded is read back and sent as the conclusion.
   */
  async function changeTicketStatus(request) {
    const action = String(request?.action ?? '').trim()
    if (action !== 'start' && action !== 'complete' && action !== 'cancel') {
      throw new Error('action must be one of start, complete, cancel')
    }
    const conclusion = String(request?.comment ?? '').trim()
    const given = String(request?.rootCause ?? '').trim()
    const reason = String(request?.reason ?? '').trim()
    if (action === 'cancel' && !reason) {
      throw new Error('a reason is required to cancel a ticket')
    }
    if (action === 'complete') {
      // The analysis goes in first: if it cannot be written, the ticket stays
      // open rather than closing without the reason it was closed for.
      let analysis = given
      if (analysis) {
        await writeRootCause(request, analysis)
      } else {
        analysis = await readRecordedRootCause(request)
        if (!analysis) {
          // Nothing to close with: the panel opens the 原因分析 step on this.
          return {
            ok: false,
            needRootCause: true,
            message: '先填原因分析，再确认完成：这张工单的任务上还没有「原因分析」日志。',
          }
        }
      }
      const ticketId = await resolveTicketId(request)
      const args = { ticketId, action, comment: conclusion || analysis }
      return summarizeAction(await client.callTool(STATUS_TOOL, args))
    }
    const ticketId = await resolveTicketId(request)
    const args = { ticketId, action }
    if (conclusion) args.comment = conclusion
    if (reason) args.reason = reason
    return summarizeAction(await client.callTool(STATUS_TOOL, args))
  }

  /**
   * Create one ticket.
   *
   * The server validates exactly what the PC form validates: title, the
   * problem description, the school, the involved system, and the issue type
   * are all mandatory.
   */
  async function createTicket(request) {
    const title = String(request?.title ?? '').trim()
    if (!title) throw new Error('title is required')
    const description = String(request?.description ?? '').trim()
    if (!description) throw new Error('description is required')
    const issueType = String(request?.issueType ?? '').trim()
    if (!issueType) throw new Error('issueType is required')
    const schoolId = Number(request?.schoolId)
    if (!Number.isInteger(schoolId) || schoolId <= 0) throw new Error('schoolId must be a positive integer')
    const productId = Number(request?.productId)
    if (!Number.isInteger(productId) || productId <= 0) throw new Error('productId must be a positive integer')
    const priority = String(request?.priority ?? 'normal').trim() || 'normal'
    if (!['high', 'medium', 'normal'].includes(priority)) {
      throw new Error('priority must be one of high, medium, normal')
    }
    const args = { title, description, issueType, schoolId, productId, priority }
    const productVersionId = Number(request?.productVersionId)
    if (Number.isInteger(productVersionId) && productVersionId > 0) args.productVersionId = productVersionId
    const created = await client.callTool(CREATE_TOOL, args)
    const ticket = created?.ticket ?? created?.data ?? created
    const ticketNo = String(ticket?.ticketNo ?? ticket?.ticket_no ?? '')
    const ticketId = Number(ticket?.id ?? ticket?.ticketId)
    return {
      ok: true,
      message: ticketNo ? `created ticket ${ticketNo}` : 'ticket created',
      ticketNo,
      ticketId: Number.isInteger(ticketId) ? ticketId : 0,
    }
  }

  /**
   * Attach one file to a ticket.
   *
   * The server mounts a ticket's attachments on its underlying task, so the
   * ticket id is all the caller has to pass. Only small files are accepted.
   */
  async function uploadAttachment(request) {
    const fileName = String(request?.fileName ?? '').trim()
    if (!fileName) throw new Error('fileName is required')
    const fileBase64 = String(request?.fileBase64 ?? '').trim()
    if (!fileBase64) throw new Error('fileBase64 is required')
    const ticketId = await resolveTicketId(request)
    const args = { ticketId, fileName, fileBase64 }
    const mimeType = String(request?.mimeType ?? '').trim()
    if (mimeType) args.mimeType = mimeType
    const description = String(request?.description ?? '').trim()
    if (description) args.description = description
    return summarizeAction(await client.callTool(ATTACHMENT_TOOL, args))
  }

  /**
   * Every ticket the caller can see, scanned page by page.
   *
   * The server caps one page at 40 rows but does honour the page number, so
   * walking the pages reaches the whole set. The filter bar needs that: the
   * school and the creator lists must cover every ticket, not only the page
   * that happens to be on screen.
   *
   * @returns `{ tickets, total }`.
   */
  async function listAllTickets(request) {
    const filters = {}
    const keyword = String(request?.keyword ?? '').trim()
    if (keyword) filters.keyword = keyword
    const ticketStatus = String(request?.ticketStatus ?? '').trim()
    if (ticketStatus) filters.ticketStatus = ticketStatus
    const issueType = String(request?.issueType ?? '').trim()
    if (issueType) filters.issueType = issueType

    const tickets = []
    const seen = new Set()
    let total = 0
    for (let page = 1; page <= MAX_SCAN_PAGES; page += 1) {
      const data = await client.callTool(LIST_TOOL, { limit: MAX_PAGE, page, ...filters })
      total = numberOrZero(data?.total) || total
      const items = Array.isArray(data?.items) ? data.items : []
      if (items.length === 0) break
      for (const ticket of items) {
        const summary = summarize(ticket)
        if (seen.has(summary.ticketNo)) continue
        seen.add(summary.ticketNo)
        tickets.push(summary)
      }
      if (items.length < MAX_PAGE) break
    }
    return { tickets, total }
  }

  /**
   * The reference data the create form offers.
   *
   * Every list upstream caps one page at 50 rows, so the pickers narrow them
   * with `keyword` instead of walking pages that would always repeat.
   */
  async function listIssueTypes() {
    const data = await client.callTool(ISSUE_TYPES_TOOL, {})
    const items = Array.isArray(data?.items) ? data.items : []
    return {
      types: items
        .filter(type => type?.enabled !== false)
        .map(type => ({ code: String(type?.code ?? ''), name: String(type?.name ?? '') }))
        .filter(type => type.code !== ''),
    }
  }

  /**
   * The schools (projects) the form offers.
   *
   * The server caps one page at 50 rows and ignores the page number, so the
   * dropdown shows that first page and a keyword reaches the rest.
   */
  async function listSchools(request) {
    const keyword = String(request?.keyword ?? '').trim()
    const args = { limit: REF_PAGE_SIZE }
    if (keyword) args.keyword = keyword
    const data = await client.callTool(SCHOOLS_TOOL, args)
    const items = Array.isArray(data?.items) ? data.items : []
    return {
      schools: items
        .map(school => ({ id: Number(school?.id) || 0, name: String(school?.name ?? '') }))
        .filter(school => school.id > 0 && school.name !== ''),
      total: typeof data?.total === 'number' ? data.total : items.length,
    }
  }

  /**
   * The products (involved systems) the form offers.
   *
   * Capped at one page upstream, so the dropdown shows that page and a keyword
   * reaches the rest.
   */
  async function listProducts(request) {
    const keyword = String(request?.keyword ?? '').trim()
    const args = { limit: REF_PAGE_SIZE }
    if (keyword) args.keyword = keyword
    const data = await client.callTool(PRODUCTS_TOOL, args)
    const items = Array.isArray(data?.items) ? data.items : []
    return {
      products: items
        .map(product => ({ id: Number(product?.id) || 0, name: String(product?.name ?? '') }))
        .filter(product => product.id > 0 && product.name !== ''),
      total: typeof data?.total === 'number' ? data.total : items.length,
    }
  }

  /** The versions of one product; empty when the product has none. */
  async function listProductVersions(request) {
    const productId = Number(request?.productId)
    if (!Number.isInteger(productId) || productId <= 0) throw new Error('productId must be a positive integer')
    const data = await client.callTool(VERSIONS_TOOL, { productId, limit: REF_PAGE_SIZE })
    const items = Array.isArray(data?.items) ? data.items : []
    return {
      versions: items
        .map(version => ({
          id: Number(version?.id) || 0,
          version: String(version?.version ?? version?.name ?? ''),
        }))
        .filter(version => version.id > 0),
    }
  }

  /**
   * The desensitized user directory the assign picker offers.
   *
   * The server caps one page at 50 rows and ignores the page number, so the
   * picker narrows the directory with `keyword` (name or username) instead of
   * walking pages that would always repeat.
   */
  async function listUsers(request) {
    const keyword = String(request?.keyword ?? '').trim()
    const args = { limit: USER_PAGE_SIZE }
    if (keyword) args.keyword = keyword
    const data = await client.callTool(USERS_TOOL, args)
    const items = Array.isArray(data?.items) ? data.items : []
    const users = items
      .map(user => {
        const userId = Number(user?.id ?? user?.userId) || 0
        if (userId <= 0) return null
        const name = String(user?.displayName ?? user?.name ?? user?.realName ?? '').trim()
        if (!name) return null
        return { userId, name, username: String(user?.username ?? '') }
      })
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
    return { users, total: typeof data?.total === 'number' ? data.total : users.length }
  }

  return {
    listTickets, getTicketDetail, addComment, addWorklog, assignTicket, changeTicketStatus,
    addRootCause, readRecordedRootCause, readRootCauseFlags,
    createTicket, uploadAttachment, listIssueTypes, listSchools, listProducts, listProductVersions,
    listAllTickets, listUsers, resolveMyUserId, forgetIdentity,
  }
}

/** Read one ticket count as a number, or 0 when the server omitted it. */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Normalize one worklog date.
 *
 * @param value - 'YYYY-MM-DD', or empty for today (local calendar day).
 * @returns the normalized date string.
 */
function normalizeWorkDate(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    const now = new Date()
    const pad = part => String(part).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error('workDate must be YYYY-MM-DD')
  }
  return raw
}

/**
 * Summarize one write result for the panel.
 *
 * `callTool` already rejects tool-level errors, so reaching here means the
 * server accepted the write; whatever message it sent is passed through as-is.
 *
 * @param result - the tool's structured content.
 * @returns `{ ok, message }`.
 */
function summarizeAction(result) {
  let message = ''
  if (typeof result === 'string') message = result
  else if (result && typeof result === 'object') {
    message = typeof result.message === 'string' ? result.message
      : typeof result.content === 'string' ? result.content
      : ''
  } else if (result !== null && result !== undefined) {
    message = String(result)
  }
  return { ok: true, message: message.slice(0, 500) }
}

/**
 * Describe the caller for the panel header.
 *
 * @param tickets - any tickets already fetched, used to learn the display name.
 * @param meUserId - the resolved caller id, or null.
 * @param knownName - a display name already learned by an earlier call.
 * @returns `{ userId, name }`; `userId` is 0 when it could not be resolved.
 */
function meSummary(tickets, meUserId, knownName) {
  if (meUserId === null) return { userId: 0, name: knownName ?? '' }
  const own = tickets.find(ticket => ticket.ownerUserId === meUserId && ticket.ownerName)
  return { userId: meUserId, name: own?.ownerName ?? knownName ?? '' }
}

/**
 * The services this plugin needs.
 *
 * Declaring them as injected dependencies is what makes the plugin survive a
 * **cold start**. The framework then applies the plugin only once these
 * services exist.
 *
 * Why it matters: sampling them with `ctx.get(...)` instead reads whatever
 * happens to be up at that instant. A profile bundle is applied early in the
 * boot sequence, and at that moment `commands`, `tools` and `skills` are all
 * still missing — a probe against a cold profile confirms it. The plugin then
 * silently skipped its command registration, and the panel reported "the Host
 * half did not load" after every restart, while a warm install (applied into
 * a running Host) worked fine. Injecting makes the framework wait instead.
 */
export const inject = ['commands', 'tools', 'skills']

/**
 * Host half.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration (volatile fields wrapped).
 */
export function apply(ctx, config) {
  const readConfig = () => ({
    endpoint: read(config.endpoint),
    apiKey: read(config.apiKey),
    pageSize: read(config.pageSize),
    timeoutMs: read(config.requestTimeoutMs),
  })

  const client = new GongsiMcpClient(readConfig)
  const {
    listTickets, getTicketDetail, addComment, addWorklog, assignTicket, changeTicketStatus,
    addRootCause, readRootCauseFlags,
    createTicket, uploadAttachment, listIssueTypes, listSchools, listProducts, listProductVersions,
    listAllTickets, listUsers, forgetIdentity,
  } = createTicketsApi(client, readConfig)

  ctx.provide('gongsiTickets', { listTickets })

  // The quote feature names a module in the composer rather than pasting the
  // ticket, so the panel registers one: a skill that teaches a fresh Session to
  // read the ticket through the tools and keep the conversation anchored to it.
  // Skills are runtime-registerable, so nothing has to be installed on disk.
  const skills = ctx.skills ?? ctx.get('skills')
  if (skills && typeof skills.register === 'function') {
    // The KB skill's own directory, resolved on this machine. It has to be an
    // absolute path: stage 1 hands the agent a command to run, not a concept.
    const kbDir = resolveKbSkillDir()
    const kbAuto = kbSupportsAuto(kbDir)
    const kbFastCommand = kbAuto
      ? `node "${join(kbDir, 'scripts', 'triage.mjs')}" <工单号> --auto`
      : `node "${join(kbDir, 'scripts', 'triage.mjs')}" <工单号> --query "<检索式>"`
    const kbFastNote = kbAuto
      ? [
        '`--auto` = 脚本自己从工单正文提炼检索词并检索知识库。',
        '**为什么用它**：检索式必须来自工单，所以"读工单 → 想检索词 → 检索"本来要占两个模型回合；',
        '`--auto` 把它压成一条命令，省掉中间那次推理 —— 这就是引用工单后响应慢的主因。',
        '',
        '脚本会打印：**工单事实表** + 状态判读 + **它用过的检索式** + 带出处的知识库引用块。',
        '检索式是自动提炼的初稿；看到工单事实表后觉得词不对，可以**再补一轮**（一次调用就够）：',
        '',
        '```',
        `node "${join(kbDir, 'scripts', 'kb-digest.mjs')}" --query "<检索式1>" --query "<检索式2>"`,
        '```',
        '',
        '**补轮不需要重新读工单** —— 工单事实表就在上一条命令的输出里。',
        '',
        '**预算：第 1 段最多 2 条命令、最多 1 轮检索。不要读 `references/`**',
        '（case / kb-map / tool-map / write-ops 是写操作和深挖时才用的，这里用不上）。',
      ].join('\n')
      : [
        '这条命令要你自己给检索式：从工单里的报错原文、表名、产品+动作里提炼 1~3 条，',
        '不要拿整句描述去检索。',
        '',
        '**预算：第 1 段最多 2 条命令、最多 1 轮检索。不要读 `references/`**',
        '（case / kb-map / tool-map / write-ops 是写操作和深挖时才用的，这里用不上）。',
      ].join('\n')

    ctx.effect(() => skills.register({
      name: 'gongsi-ticket',
      description: '以某张 gongsi 工单为锚点做分析，分三段走：① 结合工单和知识库给出「下一步怎么查 + 需要你提供什么证据」，不复述工单详情；② 等你的证据再定位根因；③ 定论。回写工单是用户发起的动作，未获明确要求不提议、不执行。',
      whenToUse: '当用户给出一张工单号（如 FB202610270002）并希望围绕它排查、分析或答复时使用。',
      source: 'runtime',
      provider: 'gongsi-tickets-panel',
      invocation: { modelInvocable: true, userInvocable: true },
      content: [
        '# 以工单为锚点分析',
        '',
        '用户消息里的工单号（形如 `FB202610270002`）就是这次分析的锚点。**不要凭记忆描述这张工单 —— 先读它。**',
        '',
        '读它是为了**给出方向和取证清单**，不是为了复述它。用户自己看得到工单详情。',
        '',
        '## 铁律：三段式，每段做完就停',
        '',
        '这张工单的分析分三段。**每一段结束时都要停下来等用户**，不要一口气跑到底。',
        '',
        '### 第 1 段 —— 一条命令拿到「工单事实 + 知识库依据」，然后给方向和取证清单',
        '',
        '**先跑这一条命令**，它一次给你工单事实表、状态判读、带出处的知识库引用块：',
        '',
        '```',
        kbFastCommand,
        '```',
        '',
        kbFastNote,
        '',
        '**命令跑不通时的退路**（脚本不存在 / 没有 node / 凭据缺失）：',
        '',
        '```',
        'gongsi_tickets({ ticketNo: "FB202610270002" })',
        '```',
        '',
        '用工具层读工单，然后**手工**提炼检索词去检索知识库（检索式要从工单里的报错原文、',
        '表名、产品+动作里取，不要拿整句描述去检索）。',
        '',
        '**不要把工单详情复述出来。** 用户自己能看工单，把标题、状态、处理人、描述原文再抄一遍只是噪音。',
        '只在必要时引用极短的一句原文（比如报错文案），且标好出处。',
        '',
        '这一段要回答三件事，按顺序：',
        '',
        '1. **这个工单在说什么问题** —— 一句话，不超过两行',
        '2. **建议我怎么查** —— 按可能性排序的排查方向，每条都要指向具体的表 / 接口 / 界面 / 命令',
        '3. **需要我提供什么证据** —— 清单式，越具体越好（哪个日志文件、哪张表的哪几列、什么时间段的批次、',
        '   管理端哪个页面的截图）。**这是本段最重要的产出**：用户拿这份清单去取证，下一段才有得分析。',
        '',
        '知识库查到了相关结论时，把依据和出处一并给出；查不到就明说"知识库未检索到该场景"，不要编。',
        '',
        '**这一段结束就停。** 不要下根因结论（证据还没到），**不要提回写**，也不要问"要不要我写回"。',
        '',
        '### 第 2 段 —— 等证据，再分析',
        '',
        '用户把日志、报错、导出数据、现象发过来之后，才做分析：',
        '',
        '报错原文含义 → 校验发生在哪一步 → 涉及哪些表/接口 → 所以断点在哪。',
        '需要公司产品知识时走 `gongsi-ticket-kb`（见下一节），不要猜。',
        '',
        '把「工单事实」「知识库依据」「用户补充的证据」**分开陈述**，不要让读者分不清哪句是查到的、哪句是推断的。',
        '',
        '**这一段结束也停。** 仍然不要提回写。',
        '',
        '### 第 3 段 —— 定论，回写由用户发起',
        '',
        '用户说"原因就是这个 / 可以总结了 / 定了"之后，才输出最终结论。',
        '',
        '**回写是用户的动作，不是你的下一步。**',
        '',
        '- 用户没说"写回去 / 记个工时 / 完成工单"，就**不要**调 `gongsi_ticket_action`',
        '- 也不要主动追问"需要我回传到工单吗" —— 等用户自己决定',
        '- 用户明确要求回写时，先展示**拟写入的完整内容**，等用户确认后再调工具',
        '',
        '## 需要公司产品知识时',
        '',
        '工单问题涉及公司产品的表名、报错含义、同步链路、运维流程时，**不要猜**。',
        '第 1 段那条命令已经带上知识库依据了 —— **先看它的输出**。',
        '',
        '需要补查时，加载 `gongsi-ticket-kb` 技能，按它的流程用 `kb_search` / `kb_get_document` 检索并核对原文，',
        '引用时必须带文档标题。知识库查不到就明说查不到。',
        '',
        '⚠️ **别一上来就通读 `gongsi-ticket-kb` 的 SKILL.md 和 references/**：',
        '那几百行是给"深挖 / 写操作"准备的，第 1 段只需要一次检索。',
        '先把第 1 段那条命令跑完，**确实不够**再回去读资料。',
        '',
        '## 回写工单（只在用户明确要求时）',
        '',
        '`gongsi_ticket_action` 会落到共享业务系统：',
        '',
        '- `comment` 追加处理说明（内容作为 HTML 富文本，@某人用 biz-mention 标记）',
        '- `worklog` 记工时（挂在工单的**关联任务** `taskId` 上，不是工单 id）',
        '- `assign` 转派处理人',
        '- `start` / `complete` 开始处理 / 确认完成（完成需填处理结论，**不可撤回**）',
        '',
        '## 输出',
        '',
        '按当前处在第几段来选格式，**不要提前输出下一段的内容**。',
        '',
        '第 1 段（给方向和取证清单）：',
        '',
        '```',
        '## 问题是什么',
        '（一两句，说清这张工单在抱怨什么；不复述工单详情）',
        '',
        '## 建议怎么查',
        '1. （可能性最高的排查方向 —— 指到具体的表 / 接口 / 界面 / 命令）',
        '2. （次可能方向）',
        '…',
        '',
        '## 需要你提供的证据',
        '- [ ] （哪个日志文件、哪个时间段）',
        '- [ ] （哪张表的哪几列 / 哪个管理端页面截图）',
        '',
        '## 知识库依据',
        '| 结论 | 出处文档 | 原文要点 |',
        '（查不到就写：知识库未检索到该场景）',
        '',
        '（停在这里，等用户取证）',
        '```',
        '第 2 段（拿到证据后定位）：',
        '',
        '```',
        '## 分析',
        '证据 + 工单事实 + 知识库依据 → 断点在哪',
        '',
        '## 知识库依据',
        '| 知识点 | 出处文档 | 原文要点 |',
        '',
        '## 不确定项',
        '（需现场验证的）',
        '```',
        '',
        '第 3 段（用户确认之后）：',
        '',
        '```',
        '## 结论',
        '一句话定性 + 根因',
        '',
        '## 建议动作',
        '可执行、指向具体表/界面/命令',
        '```',
      ].join('\n'),
    }), 'gongsi-tickets-panel: gongsi-ticket skill')

    // The deep KB workflow travels with the plugin, so a machine that never had
    // the skill still gets it. A locally served copy wins: registering this one
    // into the same layer would shadow it, so it is only offered as a fallback.
    ctx.effect(() => {
      let disposed = false
      void (async () => {
        try {
          if (!existsSync(join(BUNDLED_SKILL_DIR, 'SKILL.md'))) return
          // Wait for discovery, then stand down if the name is already served.
          const served = await skills.get?.('gongsi-ticket-kb', {})
          if (disposed || served) return
          const parsed = splitFrontmatter(readFileSync(join(BUNDLED_SKILL_DIR, 'SKILL.md'), 'utf8'))
          skills.register({
            name: parsed.meta.name || 'gongsi-ticket-kb',
            description: parsed.meta.description || '工单 + 公司知识库联合答复。',
            whenToUse: parsed.meta.whenToUse,
            source: 'bundled',
            provider: 'gongsi-tickets-panel',
            invocation: { modelInvocable: true, userInvocable: true },
            resourceBase: { kind: 'directory', path: BUNDLED_SKILL_DIR },
            content: parsed.body,
          })
        } catch {
          // A missing or unreadable copy simply leaves the skill absent.
        }
      })()
      return () => { disposed = true }
    }, 'gongsi-tickets-panel: bundled gongsi-ticket-kb skill')
  }

  // The Client panel calls this command through the mounted `commands` Remote
  // namespace. The command's `rawInput` selects the tab; the result text is the
  // JSON payload the panel parses.
  const commands = ctx.commands ?? ctx.get('commands')
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'gongsi-tickets',
      description: 'gongsi tickets: list, read one ticket\'s detail, or run one write action (comment / worklog / assign / status / users). The list takes optional filters: all|mine [{"keyword":"...","ticketStatus":"assigned,processing","issueType":"issue_resolve"}].',
      input: { hint: 'all | mine | detail <工单号> | act <json>' },
      recordInput: false,
      handler: async (invocation) => {
        try {
          const raw = String(invocation.rawInput ?? '').trim()
          if (raw.startsWith('detail')) {
            // `detail FB202610270002` — the panel drills into one ticket.
            const detail = await getTicketDetail(raw.slice('detail'.length))
            return { kind: 'success', text: JSON.stringify({ detail }) }
          }
          if (raw.startsWith('act')) {
            // `act {"op":"comment",...}` — the panel's write channel. JSON keeps
            // free-text content and the idempotency key intact on one line.
            let request
            try {
              request = JSON.parse(raw.slice(3))
            } catch {
              throw new Error('act payload must be JSON')
            }
            if (request?.op === 'users') {
              const directory = await listUsers(request)
              return { kind: 'success', text: JSON.stringify(directory) }
            }
            if (request?.op === 'allTickets') {
              // Every ticket, so the filter bar can offer every school and
              // every creator — not only the page that is on screen.
              const all = await listAllTickets(request)
              return { kind: 'success', text: JSON.stringify(all) }
            }
            if (request?.op === 'issueTypes') {
              const types = await listIssueTypes()
              return { kind: 'success', text: JSON.stringify(types) }
            }
            if (request?.op === 'rootCauseStates') {
              // The rows of mine being worked on, so the panel knows which of
              // them already earned their 确认完成 link.
              const flags = await readRootCauseFlags(request)
              return { kind: 'success', text: JSON.stringify(flags) }
            }
            if (request?.op === 'schools') {
              const schools = await listSchools(request)
              return { kind: 'success', text: JSON.stringify(schools) }
            }
            if (request?.op === 'products') {
              const products = await listProducts(request)
              return { kind: 'success', text: JSON.stringify(products) }
            }
            if (request?.op === 'versions') {
              const versions = await listProductVersions(request)
              return { kind: 'success', text: JSON.stringify(versions) }
            }
            if (request?.op === 'create') {
              const created = await createTicket(request)
              return { kind: 'success', text: JSON.stringify({ action: created }) }
            }
            if (request?.op === 'attachment') {
              const action = await uploadAttachment(request)
              return { kind: 'success', text: JSON.stringify({ action }) }
            }
            let action
            if (request?.op === 'comment') action = await addComment(request)
            else if (request?.op === 'worklog') action = await addWorklog(request)
            else if (request?.op === 'assign') action = await assignTicket(request)
            else if (request?.op === 'rootCause') action = await addRootCause(request)
            else if (request?.op === 'status') action = await changeTicketStatus(request)
            else throw new Error(`unknown action: ${request?.op}`)
            return { kind: 'success', text: JSON.stringify({ action }) }
          }
          // `all` / `mine` on their own, or `all <json>` with the filters:
          // `{ keyword, ticketStatus, issueType }`.
          const space = raw.indexOf(' ')
          const head = space >= 0 ? raw.slice(0, space) : raw
          const tab = head === 'mine' ? 'mine' : 'all'
          let filters = {}
          if (space >= 0) {
            const tail = raw.slice(space + 1).trim()
            if (tail !== '') {
              try {
                filters = JSON.parse(tail)
              } catch {
                throw new Error('the filter payload must be JSON')
              }
            }
          }
          const data = await listTickets({ tab, ...filters })
          return { kind: 'success', text: JSON.stringify(data) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: message }
        }
      },
    }), 'gongsi-tickets-panel: /gongsi-tickets command')
  }

  // The model reaches the same operation through a tool of its own.
  const tools = ctx.tools ?? ctx.get('tools')
  if (tools) {
    const ticketSchema = {
      type: 'object',
      additionalProperties: false,
      required: [
        'ticketNo', 'ticketId', 'taskId', 'title', 'status', 'priority', 'schoolName',
        'productName', 'ownerName', 'ownerUserId', 'initiatorName', 'issueType', 'createdAt',
        'updatedAt', 'dueTime', 'mine',
      ],
      properties: {
        ticketNo: { type: 'string' },
        ticketId: { type: 'number' },
        taskId: { type: 'number' },
        title: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'string' },
        schoolName: { type: 'string' },
        productName: { type: 'string' },
        ownerName: { type: 'string' },
        ownerUserId: { type: 'number' },
        initiatorName: { type: 'string' },
        issueType: { type: 'string' },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        dueTime: { type: 'string' },
        mine: { type: 'boolean' },
      },
    }
    /** One image lifted out of a rich-text body. */
    const imageSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['src'],
      properties: {
        src: { type: 'string' },
        alt: { type: 'string' },
      },
    }
    const detailSchema = {
      type: 'object',
      additionalProperties: false,
      required: [
        'ticketNo', 'ticketId', 'taskId', 'title', 'status', 'issueTypeName',
        'initiatorName', 'ownerName', 'assignees', 'descriptionText', 'descriptionImages',
        'feedback', 'feedbackImages',
        'worklogTotalHours', 'worklogPersonDays', 'processCostPersonDays',
        'aiAnalysisStatus', 'aiAnalyzedAt', 'attachments', 'logs',
      ],
      properties: {
        ticketNo: { type: 'string' },
        ticketId: { type: 'number' },
        taskId: { type: 'number' },
        title: { type: 'string' },
        status: { type: 'string' },
        issueTypeName: { type: 'string' },
        initiatorName: { type: 'string' },
        ownerName: { type: 'string' },
        assignees: { type: 'array', items: { type: 'string' } },
        descriptionText: { type: 'string' },
        descriptionImages: { type: 'array', items: imageSchema },
        feedback: { type: 'string' },
        feedbackImages: { type: 'array', items: imageSchema },
        score: { type: 'number' },
        worklogTotalHours: { type: 'number' },
        worklogPersonDays: { type: 'number' },
        processCostPersonDays: { type: 'number' },
        aiAnalysisStatus: { type: 'string' },
        aiAnalyzedAt: { type: 'string' },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'createdAt'],
            properties: {
              name: { type: 'string' },
              size: { type: 'number' },
              uploaderName: { type: 'string' },
              createdAt: { type: 'string' },
            },
          },
        },
        logs: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'logType', 'authorName', 'createdAt', 'contentText', 'images'],
            properties: {
              id: { type: 'number' },
              logType: { type: 'string' },
              authorName: { type: 'string' },
              createdAt: { type: 'string' },
              contentText: { type: 'string' },
              images: { type: 'array', items: imageSchema },
            },
          },
        },
      },
    }
    ctx.effect(() => tools.register({
      name: 'gongsi_tickets',
      description: 'Read gongsi tickets (service tickets). scope "all" pages the tickets visible to me; scope "mine" pages only the tickets I own (处理人是我). Filter with keyword (title, ticket number, description), ticketStatus (comma separated), and issueType. Or pass ticketNo to read one ticket\'s full read-only detail (description, conclusion, worklogs, attachments, activity log).',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['all', 'mine'],
            description: 'Which list to return; defaults to "all". Ignored when ticketNo is set.',
          },
          page: {
            type: 'number',
            description: 'Which page to return, 1-based; defaults to 1. Ignored when ticketNo is set.',
            minimum: 1,
          },
          pageSize: {
            type: 'number',
            description: 'How many tickets one page holds (1-40; defaults to the configured page size). Ignored when ticketNo is set.',
            minimum: 1,
            maximum: MAX_PAGE,
          },
          ticketNo: {
            type: 'string',
            description: 'Exact ticket number, e.g. FB202610270002; when set, returns that ticket\'s detail instead of a list.',
          },
          keyword: {
            type: 'string',
            description: 'Filter by a word in the title, the ticket number, or the description.',
          },
          ticketStatus: {
            type: 'string',
            description: 'Filter by status, comma separated: created / assigned / processing / pending_review / completed / cancelled.',
          },
          issueType: {
            type: 'string',
            description: 'Filter by the issue type code, e.g. issue_resolve.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            me: {
              type: 'object',
              additionalProperties: false,
              required: ['userId', 'name'],
              properties: {
                userId: { type: 'number' },
                name: { type: 'string' },
              },
            },
            total: { type: 'number' },
            page: { type: 'number' },
            pageSize: { type: 'number' },
            pages: { type: 'number' },
            tickets: {
              type: 'array',
              items: ticketSchema,
            },
            detail: detailSchema,
          },
        },
        render: (_args, value) => {
          if (value?.detail) return [{ type: 'text', text: renderDetail(value.detail) }]
          const scope = _args?.scope === 'mine' ? 'mine' : 'all'
          const pageNote = value?.pages
            ? ` [page ${value.page}/${value.pages}, ${value.pageSize} per page]`
            : ''
          const heading = scope === 'mine'
            ? `My gongsi tickets${value?.me?.name ? ` (${value.me.name})` : ''}${value?.total ? `, ${value.total} owned` : ''}${pageNote}:`
            : `Gongsi tickets visible to me${value?.total ? ` (${value.total} total)` : ''}${pageNote}:`
          return [{ type: 'text', text: renderTickets(value?.tickets ?? [], heading) }]
        },
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const ticketNo = typeof args?.ticketNo === 'string' ? args.ticketNo.trim() : ''
        if (ticketNo) return { detail: await getTicketDetail(ticketNo) }
        const scope = args?.scope === 'mine' ? 'mine' : 'all'
        return await listTickets({
          tab: scope,
          page: args?.page,
          pageSize: args?.pageSize,
          keyword: args?.keyword,
          ticketStatus: args?.ticketStatus,
          issueType: args?.issueType,
        })
      },
    }), 'gongsi-tickets-panel: gongsi_tickets tool')

    // The write side of a ticket: comment, worklog, assignment, status change.
    ctx.effect(() => tools.register({
      name: 'gongsi_ticket_action',
      description: 'Write to one gongsi ticket: append a processing comment (处理说明), record a worklog (工时, on the ticket\'s underlying task), assign the owner (指派/转派; the previous owner automatically becomes an associate), or advance the status (start 开始处理 / complete 确认完成). The ticket is addressed by its ticket number.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'ticketNo'],
        properties: {
          action: {
            type: 'string',
            enum: ['comment', 'worklog', 'assign', 'start', 'complete'],
            description: 'Which write to perform.',
          },
          ticketNo: {
            type: 'string',
            description: 'Exact ticket number, e.g. FB202610270002.',
          },
          content: {
            type: 'string',
            description: 'comment: the processing note text (required for comment).',
          },
          workDate: {
            type: 'string',
            description: 'worklog: work date as YYYY-MM-DD; defaults to today.',
          },
          hours: {
            type: 'number',
            description: 'worklog: hours worked, fractions allowed (required for worklog).',
            minimum: 0,
          },
          remark: {
            type: 'string',
            description: 'worklog: what the work was, max 500 characters.',
          },
          isOvertime: {
            type: 'boolean',
            description: 'worklog: overtime flag; defaults to false.',
          },
          progress: {
            type: 'number',
            description: 'worklog: also set the task progress, 0-100.',
            minimum: 0,
            maximum: 100,
          },
          ownerUserId: {
            type: 'number',
            description: 'assign: the new owner\'s user id (required for assign).',
          },
          comment: {
            type: 'string',
            description: 'complete: the processing conclusion (optional; when it is left out the root-cause analysis is used as the conclusion).',
          },
          rootCause: {
            type: 'string',
            description: 'complete: the root-cause analysis (required for complete). The server refuses to close a ticket whose task carries no root-cause entry, so it is written as its own root_cause log on the ticket\'s underlying task first; if that write fails, the ticket stays open.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            needRootCause: {
              type: 'boolean',
              description: 'complete: the ticket\'s task carries no root-cause entry yet, so 原因分析 (rootCause) has to be recorded first.',
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value?.ok
            ? `gongsi ticket action ok${value?.message ? `: ${value.message}` : ''}`
            : `gongsi ticket action failed: ${value?.message ?? 'unknown error'}`,
        }],
      },
      timeoutMs: 60000,
      // A write must not be replayed on its own; the idempotency key protects
      // comments, but worklogs and assignment are not replay-safe.
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          let action
          if (args?.action === 'comment') {
            action = await addComment({ ticketNo: args.ticketNo, content: args.content })
          } else if (args?.action === 'worklog') {
            action = await addWorklog({
              ticketNo: args.ticketNo,
              workDate: args.workDate,
              hours: args.hours,
              remark: args.remark,
              isOvertime: args.isOvertime,
              progress: args.progress,
            })
          } else if (args?.action === 'assign') {
            action = await assignTicket({ ticketNo: args.ticketNo, ownerUserId: args.ownerUserId })
          } else if (args?.action === 'start' || args?.action === 'complete') {
            action = await changeTicketStatus({
              ticketNo: args.ticketNo,
              action: args.action,
              comment: args.comment,
              rootCause: args.rootCause,
            })
          } else {
            throw new Error(`unknown action: ${args?.action}`)
          }
          return { ok: true, message: action.message }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }), 'gongsi-tickets-panel: gongsi_ticket_action tool')

    // Creating a ticket is a write of its own: it needs the reference data
    // (issue type, school, product) that the panel's form also uses.
    ctx.effect(() => tools.register({
      name: 'gongsi_create_ticket',
      description: 'Create a gongsi ticket (新建工单). Needs a title, a problem description, the school (schoolId), the involved system (productId), and the issue type (issueType). Look the ids up first with the gongsi_tickets_meta tool.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'issueType', 'schoolId', 'productId'],
        properties: {
          title: {
            type: 'string',
            description: 'Ticket title, max 200 characters.',
          },
          description: {
            type: 'string',
            description: 'The problem description (required): what happened, how to reproduce it, the expected result.',
          },
          issueType: {
            type: 'string',
            description: 'Issue type code, e.g. issue_resolve (问题解决), service_support (服务支持), bug_fix (BUG修复).',
          },
          schoolId: {
            type: 'number',
            description: 'The school / project id (required).',
          },
          productId: {
            type: 'number',
            description: 'The involved system (product) id (required).',
          },
          productVersionId: {
            type: 'number',
            description: 'The product version id, when the ticket is about one version.',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'normal'],
            description: 'Urgency; defaults to normal.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            ticketNo: { type: 'string' },
            ticketId: { type: 'number' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value?.ok
            ? `gongsi ticket created${value?.ticketNo ? `: ${value.ticketNo}` : ''}${value?.message ? ` (${value.message})` : ''}`
            : `gongsi ticket creation failed: ${value?.message ?? 'unknown error'}`,
        }],
      },
      timeoutMs: 60000,
      // Creating a ticket is not replay-safe.
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          const created = await createTicket({
            title: args.title,
            description: args.description,
            issueType: args.issueType,
            schoolId: args.schoolId,
            productId: args.productId,
            productVersionId: args.productVersionId,
            priority: args.priority,
          })
          return {
            ok: true,
            message: created.message,
            ticketNo: created.ticketNo,
            ticketId: created.ticketId,
          }
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }), 'gongsi-tickets-panel: gongsi_create_ticket tool')

    // The reference data the create form needs: issue types, schools, products,
    // and the versions of one product.
    ctx.effect(() => tools.register({
      name: 'gongsi_tickets_meta',
      description: 'Look up the reference data a gongsi ticket needs: the issue types, the schools (projects), the products (involved systems), and the versions of one product. Every list is narrowed by keyword because the server caps one page.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: ['issueTypes', 'schools', 'products', 'versions'],
            description: 'Which list to read; defaults to issueTypes.',
          },
          keyword: {
            type: 'string',
            description: 'schools / products: narrow the list by name.',
          },
          productId: {
            type: 'number',
            description: 'versions: the product whose versions to list.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            types: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'name'],
                properties: { code: { type: 'string' }, name: { type: 'string' } },
              },
            },
            schools: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name'],
                properties: { id: { type: 'number' }, name: { type: 'string' } },
              },
            },
            products: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name'],
                properties: { id: { type: 'number' }, name: { type: 'string' } },
              },
            },
            versions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'version'],
                properties: { id: { type: 'number' }, version: { type: 'string' } },
              },
            },
            total: { type: 'number' },
          },
        },
        render: (_args, value) => {
          if (Array.isArray(value?.types)) {
            return [{ type: 'text', text: value.types.map(t => `${t.code} (${t.name})`).join('\n') }]
          }
          if (Array.isArray(value?.schools)) {
            return [{ type: 'text', text: value.schools.map(s => `${s.id} ${s.name}`).join('\n') }]
          }
          if (Array.isArray(value?.products)) {
            return [{ type: 'text', text: value.products.map(p => `${p.id} ${p.name}`).join('\n') }]
          }
          if (Array.isArray(value?.versions)) {
            return [{ type: 'text', text: value.versions.map(v => `${v.id} ${v.version}`).join('\n') }]
          }
          return [{ type: 'text', text: 'no reference data' }]
        },
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const kind = args?.kind ?? 'issueTypes'
        if (kind === 'schools') return await listSchools(args)
        if (kind === 'products') return await listProducts(args)
        if (kind === 'versions') return await listProductVersions(args)
        return await listIssueTypes()
      },
    }), 'gongsi-tickets-panel: gongsi_tickets_meta tool')
  }
}
