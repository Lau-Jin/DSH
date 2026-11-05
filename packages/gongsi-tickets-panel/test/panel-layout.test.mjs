/**
 * Layout contract of the gongsi ticket panel.
 *
 * The panel is a column inside the shell's main area: the header, the tab
 * strip and the filter bar must stay on screen while the ticket list scrolls
 * under them. That contract lives in inline styles, so it is asserted on the
 * rendered element tree rather than on pixels.
 *
 * The client half is loaded exactly as the browser loads it — through
 * `window.__ModuleLoader__.load` — but with a stub React. The stub keeps the
 * hook order of the component, so the state the tree is rendered with can be
 * chosen: the list view and the drilled-in ticket detail are both checked.
 *
 * Run it with `node test/panel-layout.test.mjs`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

/** The key the panel registers itself under in the `main` slot. */
const PANEL_KEY = 'gongsi-tickets'

/**
 * Load the client module the way the browser does.
 *
 * The module calls `window.__ModuleLoader__.load()` with its definition; the
 * definition carries the factory that builds the plugin.
 */
function loadDefinition() {
  let definition
  /** Everything the panel copied to the clipboard during a test. */
  const clipboard = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(def) {
          definition = def
        },
      },
    },
    // The share button copies through the clipboard of the page.
    navigator: {
      clipboard: {
        async writeText(text) {
          clipboard.push(text)
        },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(clientPath, 'utf8'), sandbox, { filename: clientPath })
  assert.ok(definition, 'the client module must call window.__ModuleLoader__.load()')
  return { definition, clipboard }
}

/**
 * A React stub that records the hooks a component used.
 *
 * The hooks keep their order, so `overrides` picks a state by the slot it
 * occupies in the component body. `calls.states` records what each slot
 * started from, which lets a test notice a reordered component instead of
 * silently asserting against the wrong state.
 */
function createReactStub(overrides = new Map()) {
  const calls = { states: [], effects: [] }
  let stateSlot = 0

  const React = {
    createElement(type, props, ...children) {
      const rest = { ...(props ?? {}) }
      const key = rest.key ?? null
      delete rest.key
      if (children.length === 1) rest.children = children[0]
      else if (children.length > 1) rest.children = children
      return { type, props: rest, key }
    },
    useState(initial) {
      const slot = stateSlot++
      calls.states.push({ slot, initial })
      const value = overrides.has(slot) ? overrides.get(slot) : initial
      return [value, () => {}]
    },
    useEffect(effect, deps) {
      calls.effects.push({ effect, deps })
    },
    useMemo(factory) {
      return factory()
    },
    useRef(initial) {
      return { current: initial }
    },
    useCallback(fn) {
      return fn
    },
  }

  return { React, calls }
}

/**
 * Build the panel component out of a client module.
 *
 * The component is not exported; it is registered into the `main` slot when
 * the module applies, so the slot registration is the way in.
 */
function loadPanel(definition, React) {
  const module = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`the client module requires an unexpected dependency: ${name}`)
  })

  const registered = []
  const ctx = {
    effect: fn => fn(),
    locale: {
      register: () => {},
      bind: () => key => key,
    },
    slots: {
      inject: (_slot, fn) => fn(),
      register: (config, Component) => {
        registered.push({ config, Component })
        return { config, Component }
      },
    },
    get: () => undefined,
    remote: { commands: { execute: async () => ({}) } },
  }
  module.apply(ctx)

  const entry = registered.find(item => item.config.key === PANEL_KEY)
  assert.ok(entry, `the plugin must register a panel under the key ${PANEL_KEY}`)
  return entry.Component
}

/** The props the shell hands to the panel. */
function panelProps(extra = {}) {
  return {
    t: key => key,
    loadTickets: async () => ({ tickets: [] }),
    loadDetail: async () => ({}),
    act: async () => ({}),
    listUsers: async () => [],
    meta: async () => ({ types: [] }),
    quote: () => {},
    useSessions: () => 'session-1',
    configForms: undefined,
    ...extra,
  }
}

/**
 * A settings form that reports one endpoint.
 *
 * The panel reads the endpoint from the form to work out the console a share
 * link points at.
 */
function configFormsWith(endpoint) {
  return {
    describe: () => ({
      getSnapshot: () => ({ view: { namespaces: [{ ns: 'include:gongsi-tickets-panel' }] } }),
      ensure: () => {},
      subscribe: () => {},
    }),
    get: () => ({
      getSnapshot: () => ({ value: { endpoint }, secrets: [] }),
      set: async () => {},
    }),
  }
}

/** Render the panel with the given state overrides. */
function renderPanel(definition, overrides, props) {
  const { React, calls } = createReactStub(overrides)
  const Panel = loadPanel(definition, React)
  const tree = Panel(panelProps(props))
  return { tree, calls }
}

/** The child elements of one element, with the empty ones dropped. */
function childrenOf(element) {
  const children = element?.props?.children
  if (children === undefined || children === null) return []
  const list = Array.isArray(children) ? children : [children]
  return list.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
}

/** Walk the tree of elements; components are not expanded. */
function walk(element, visit) {
  visit(element)
  for (const child of childrenOf(element)) {
    if (child && typeof child === 'object' && 'type' in child) walk(child, visit)
  }
}

/** Every element of the tree that matches the predicate. */
function findAll(element, predicate) {
  const found = []
  walk(element, node => {
    if (predicate(node)) found.push(node)
  })
  return found
}

/** The elements of the tree with the given tag name. */
function byTag(element, tag) {
  return findAll(element, node => node.type === tag)
}

/** The elements of the tree that are the given component. */
function byComponent(element, name) {
  return findAll(element, node => typeof node.type === 'function' && node.type.name === name)
}

/** The text of an element, with the nested elements flattened out. */
function textOf(element) {
  const parts = []
  const visit = node => {
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node))
      return
    }
    if (!node || typeof node !== 'object') return
    for (const child of childrenOf(node)) visit(child)
  }
  visit(element)
  return parts.join('')
}

/* ------------------------------------------------------------------ */
/* The state the two views are rendered with.                           */
/* ------------------------------------------------------------------ */

/** One ticket, as the server hands it over. */
const ticket = {
  ticketNo: 'FB202610270001',
  ticketId: 137,
  title: '班级缺失',
  status: 'created',
  priority: 'high',
  schoolName: '测试学校',
  initiatorName: '张三',
  ownerUserId: 7,
}

/** The state slots of the panel body, in the order it declares them. */
const SLOT = {
  tab: 0,
  detail: 1,
  cache: 2,
  state: 3,
}

/** The list view: the `all` tab, one ticket, nothing drilled into. */
const listOverrides = new Map([
  [SLOT.cache, {
    all: { tickets: [ticket], total: 1, page: 1, pages: 1, pageSize: 15, me: { userId: 7, name: '李四' } },
    mine: null,
  }],
])

/** The detail view: one ticket opened and loaded. */
const detailOverrides = new Map([
  [SLOT.detail, {
    ticketNo: ticket.ticketNo,
    status: 'ready',
    row: ticket,
    data: { ticketNo: ticket.ticketNo, description: '工单详情', conclusion: '' },
    error: null,
  }],
])

/** The list view: one ticket nobody owns yet. */
const unassignedOverrides = new Map([
  [SLOT.cache, {
    all: {
      tickets: [{ ...ticket, ownerName: '', ownerUserId: 0 }],
      total: 1,
      page: 1,
      pages: 1,
      pageSize: 15,
      me: { userId: 7, name: '李四' },
    },
    mine: null,
  }],
])

/* ------------------------------------------------------------------ */
/* The checks.                                                          */
/* ------------------------------------------------------------------ */

const { definition, clipboard } = loadDefinition()

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('the panel keeps its state hooks in a known order', () => {
  const { calls } = renderPanel(definition, listOverrides)
  const slots = calls.states
  assert.ok(slots.length > SLOT.state, 'the panel must declare more state hooks than the test knows')
  assert.equal(slots[SLOT.tab].initial, 'all', 'the first state slot is the active tab')
  assert.equal(slots[SLOT.detail].initial, null, 'the second state slot is the drilled-in ticket')
  const cache = slots[SLOT.cache].initial
  assert.ok(cache && cache.all === null && cache.mine === null, 'the third state slot is the list cache')
  assert.equal(slots[SLOT.state].initial.status, 'loading', 'the fourth state slot is the load state')
})

check('the panel itself does not scroll', () => {
  const { tree } = renderPanel(definition, listOverrides)
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.style.display, 'flex')
  assert.equal(tree.props.style.flexDirection, 'column')
  assert.equal(tree.props.style.height, '100%')
  assert.equal(tree.props.style.overflow, 'hidden', 'the panel must not scroll; only its body may')
})

check('the panel is split into a fixed block and a scrolling body', () => {
  const { tree } = renderPanel(definition, listOverrides)
  const blocks = childrenOf(tree)
  assert.equal(blocks.length, 2, 'the panel holds the fixed block and the scrolling body')
  const [fixed, scroll] = blocks
  assert.equal(fixed.props.style.flex, '0 0 auto', 'the fixed block must not shrink')
  assert.equal(scroll.props.style.flex, '1 1 auto', 'the scrolling body takes the rest of the panel')
  assert.equal(scroll.props.style.minHeight, 0, 'the scrolling body must be able to shrink below its content')
  assert.equal(scroll.props.style.overflowY, 'auto')
  assert.equal(scroll.props.style.overflowX, 'hidden')
})

check('the header, the tabs and the filter bar stay in the fixed block', () => {
  const { tree } = renderPanel(definition, listOverrides)
  const [fixed] = childrenOf(tree)
  assert.equal(byTag(fixed, 'header').length, 1, 'the header stays put')
  assert.equal(byTag(fixed, 'h1').length, 1, 'the title stays put')
  assert.equal(findAll(fixed, node => node.props?.role === 'tablist').length, 1, 'the tab strip stays put')
  assert.equal(byComponent(fixed, 'FilterBar').length, 1, 'the filter bar stays put')
})

check('nothing that must stay visible scrolls away', () => {
  const { tree } = renderPanel(definition, listOverrides)
  const [, scroll] = childrenOf(tree)
  assert.equal(byTag(scroll, 'header').length, 0, 'the header must not be inside the scrolling body')
  assert.equal(byTag(scroll, 'h1').length, 0, 'the title must not be inside the scrolling body')
  assert.equal(findAll(scroll, node => node.props?.role === 'tablist').length, 0, 'the tab strip must not scroll away')
  assert.equal(byComponent(scroll, 'FilterBar').length, 0, 'the filter bar must not scroll away')
})

check('the ticket list scrolls in the scrolling body', () => {
  const { tree } = renderPanel(definition, listOverrides)
  const [fixed, scroll] = childrenOf(tree)
  assert.equal(byTag(scroll, 'ul').length, 1, 'the ticket list lives in the scrolling body')
  assert.equal(byComponent(scroll, 'TicketRow').length, 1, 'the rows live in the scrolling body')
  assert.equal(byTag(fixed, 'ul').length, 0, 'the ticket list must not be in the fixed block')
})

check('the ticket detail keeps its back button out of the scrolling body', () => {
  const { tree } = renderPanel(definition, detailOverrides)
  const blocks = childrenOf(tree)
  assert.equal(blocks.length, 2, 'the detail view holds the header and the scrolling body')
  const [header, scroll] = blocks
  assert.equal(header.type, 'header', 'the back button sits in its own header')
  assert.ok(textOf(header).includes('detail.back'), 'the header carries the back button')
  assert.equal(scroll.props.style.flex, '1 1 auto')
  assert.equal(scroll.props.style.minHeight, 0)
  assert.equal(scroll.props.style.overflowY, 'auto')
  assert.equal(byComponent(scroll, 'TicketDetailView').length, 1, 'the detail body lives in the scrolling body')
  assert.equal(byTag(scroll, 'header').length, 0, 'the detail header must not scroll away')
})

check('the detail view does not scroll as a whole', () => {
  const { tree } = renderPanel(definition, detailOverrides)
  assert.equal(tree.props.style.overflow, 'hidden')
  assert.equal(tree.props.style.flexDirection, 'column')
})

check('the row carries a share button with the console link of the ticket', () => {
  const { tree } = renderPanel(definition, listOverrides)
  const row = byComponent(tree, 'TicketRow')[0]
  assert.ok(row, 'the panel must render a ticket row')
  const rendered = row.type(row.props)
  const share = byComponent(rendered, 'ShareButton')
  assert.equal(share.length, 1, 'the row must carry one share button')
  assert.equal(
    share[0].props.url,
    'https://yanfa.scedu.tech/?tab=ticket-detail&ticketId=137',
    'the share link must be the console deep link of this ticket',
  )
})

check('the share link follows the configured endpoint', () => {
  const { tree } = renderPanel(definition, listOverrides, {
    configForms: configFormsWith('https://console.example.test/api/mcp'),
  })
  const row = byComponent(tree, 'TicketRow')[0]
  const rendered = row.type(row.props)
  const share = byComponent(rendered, 'ShareButton')[0]
  assert.equal(share.props.url, 'https://console.example.test/?tab=ticket-detail&ticketId=137')
})

check('the detail view offers the share link of the open ticket', () => {
  const { tree } = renderPanel(definition, detailOverrides)
  const [header] = childrenOf(tree)
  const share = byComponent(header, 'ShareButton')
  assert.equal(share.length, 1, 'the detail header must carry a share button')
  assert.equal(share[0].props.url, 'https://yanfa.scedu.tech/?tab=ticket-detail&ticketId=137')
})

check('a ticket nobody owns says so in red', () => {
  const { tree } = renderPanel(definition, unassignedOverrides)
  const row = byComponent(tree, 'TicketRow')[0]
  const rendered = row.type(row.props)
  const badges = byComponent(rendered, 'Badge')
  const mark = badges.find(badge => badge.props.children === 'badge.unassigned')
  assert.ok(mark, 'a ticket without an owner must carry the unassigned badge')
  assert.equal(
    mark.props.color,
    'var(--dsw-alias-state-error-primary)',
    'the unassigned badge must be red',
  )
})

check('a ticket with an owner carries no unassigned badge', () => {
  const { tree } = renderPanel(definition, listOverrides)
  const row = byComponent(tree, 'TicketRow')[0]
  const rendered = row.type(row.props)
  const badges = byComponent(rendered, 'Badge')
  assert.equal(
    badges.filter(badge => badge.props.children === 'badge.unassigned').length,
    0,
    'an assigned ticket must not carry the unassigned badge',
  )
})

check('the share button copies the link and leaves the row alone', async () => {
  const { tree } = renderPanel(definition, listOverrides)
  const row = byComponent(tree, 'TicketRow')[0]
  const rendered = row.type(row.props)
  const share = byComponent(rendered, 'ShareButton')[0]
  const button = share.type(share.props)
  const click = byTag(button, 'button')[0]
  assert.ok(click, 'the share button must render a button')

  let stopped = false
  clipboard.length = 0
  await click.props.onClick({ preventDefault() {}, stopPropagation() { stopped = true } })
  assert.equal(stopped, true, 'the share button must not open the ticket detail')
  assert.deepEqual(
    clipboard,
    ['https://yanfa.scedu.tech/?tab=ticket-detail&ticketId=137'],
    'the console link must reach the clipboard',
  )
})

/* ------------------------------------------------------------------ */
/* The run.                                                             */
/* ------------------------------------------------------------------ */

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
