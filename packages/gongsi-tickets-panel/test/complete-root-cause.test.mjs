/**
 * 确认完成 (complete) and the 原因分析 step in a ticket row.
 *
 * The server refuses to close a ticket whose underlying task carries no
 * root-cause entry ("请先填写原因分析"), so the row offers two closing steps in
 * order: 原因分析 records the analysis, and 确认完成 closes the ticket with no
 * box of its own. The analysis is the only text the completion needs.
 *
 * The client half is loaded the way the browser loads it, through
 * `window.__ModuleLoader__.load`, and the React stub really holds state, so
 * the test can type into the box and watch what the row sends.
 *
 * Run it with `node test/complete-root-cause.test.mjs`.
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
  const sandbox = {
    window: {
      innerHeight: 800,
      __ModuleLoader__: {
        load(def) {
          definition = def
        },
      },
    },
    navigator: { clipboard: { async writeText() {} } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(clientPath, 'utf8'), sandbox, { filename: clientPath })
  assert.ok(definition, 'the client module must call window.__ModuleLoader__.load()')
  return definition
}

/**
 * A React stub that really holds state.
 *
 * Each root is mounted in its own scope, so the state of a component that is
 * rendered on its own does not land on the state of the panel it came from.
 */
function createLiveReact() {
  let current = null
  let slot = 0

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
      const index = slot++
      const scope = current
      if (!(index in scope.states)) {
        scope.states[index] = scope.initial.has(index)
          ? scope.initial.get(index)
          : (typeof initial === 'function' ? initial() : initial)
      }
      const set = value => {
        const next = typeof value === 'function' ? value(scope.states[index]) : value
        if (Object.is(next, scope.states[index])) return
        scope.states[index] = next
        scope.render()
      }
      return [scope.states[index], set]
    },
    useEffect(effect, deps) {
      current.effects.push({ effect, deps })
    },
    useMemo(factory) {
      return factory()
    },
    useRef(initial) {
      const index = slot++
      const scope = current
      if (!(index in scope.refs)) scope.refs[index] = { current: initial }
      return scope.refs[index]
    },
    useCallback(fn) {
      return fn
    },
  }

  function mount(name, root, initial = new Map()) {
    const scope = { name, states: [], refs: [], effects: [], initial, tree: null }
    scope.render = () => {
      current = scope
      slot = 0
      scope.effects = []
      scope.tree = root(React)
    }
    scope.render()
    return scope
  }

  return { React, mount }
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
    locale: { register: () => {}, bind: () => key => key },
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

/** One ticket, as the server hands it over. */
const ticket = {
  ticketNo: 'FB202611020001',
  ticketId: 137,
  taskId: 42,
  title: '班级缺失',
  status: 'processing',
  priority: 'high',
  schoolName: '测试学校',
  initiatorName: '张三',
  ownerUserId: 7,
  mine: true,
}

/** The state slots of the panel body, in the order it declares them. */
const SLOT = {
  tab: 0,
  detail: 1,
  cache: 2,
  state: 3,
  rowModes: 4,
  rootCauseStates: 5,
}

/** The state slots of the row form, in the order it declares them. */
const ROW_SLOT = {
  keyword: 0,
  users: 1,
  owner: 2,
  picked: 3,
  comment: 4,
  rootCause: 5,
}

const definition = loadDefinition()
const live = createLiveReact()
const Panel = loadPanel(definition, live.React)

/** The requests the panel sent to the Host half. */
const sent = []

/** The props the shell hands to the panel. */
const panelProps = {
  t: key => key,
  loadTickets: async () => ({ tickets: [], total: 0, pages: 1, pageSize: 15 }),
  loadDetail: async () => ({}),
  act: async (_sessionId, request) => {
    sent.push(request)
    return { action: { ok: true, message: 'done' } }
  },
  listUsers: async () => [],
  meta: async () => ({ types: [] }),
  quote: () => {},
  useSessions: () => 'session-1',
  configForms: undefined,
}

/** The state the panel is rendered with: one ticket of mine, being worked on. */
const panelState = new Map([
  [SLOT.cache, {
    all: { tickets: [ticket], total: 1, page: 1, pages: 1, pageSize: 15, me: { userId: 7, name: '李四' } },
    mine: null,
  }],
])

/** Mount the panel and hand back the ticket row's element. */
function mountRow(extra = {}) {
  const scope = live.mount('panel', () => Panel(panelProps), panelState)
  const row = byComponent(scope.tree, 'TicketRow')[0]
  assert.ok(row, 'the panel must render a ticket row')
  return row.type({ ...row.props, ...extra })
}

/**
 * The row form, mounted on its own with the given mode.
 *
 * @param mode - which form the row shows: `rootCause` or `complete`.
 * @param initial - the state the form starts with.
 * @param extra - row props to override, e.g. `rootCauseReady`.
 */
function mountActions(mode, initial = new Map(), extra = {}) {
  const rendered = mountRow({ rowMode: mode, ...extra })
  const actions = byComponent(rendered, 'RowActions')[0]
  assert.ok(actions, `the row in ${mode} mode must render its form`)
  return live.mount('row', () => actions.type(actions.props), initial)
}

/** The textarea with the given placeholder. */
function textareaWith(scope, placeholder) {
  const found = byTag(scope.tree, 'textarea').filter(node => node.props.placeholder === placeholder)
  assert.equal(found.length, 1, `the form must hold exactly one box for ${placeholder}`)
  return found[0]
}

/** One button of the form, by its label. */
function button(scope, label) {
  return byTag(scope.tree, 'button').find(node => node.props.children === label)
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('the 原因分析 step offers one box', () => {
  const scope = mountActions('rootCause')
  const boxes = byTag(scope.tree, 'textarea')
  assert.equal(boxes.length, 1, 'the step holds exactly one box')
  assert.equal(boxes[0].props.placeholder, 'row.rootCausePlaceholder', 'the box asks for the analysis')
  assert.ok(button(scope, 'row.rootCauseSave'), 'the step saves the analysis')
})

check('the analysis is saved on its own', async () => {
  sent.length = 0
  const scope = mountActions('rootCause', new Map([
    [ROW_SLOT.rootCause, '原因分析：学校侧班级数据缺失。'],
  ]))
  const save = button(scope, 'row.rootCauseSave')
  assert.ok(save, 'the step must offer a save button')
  await save.props.onClick({})
  assert.equal(sent.length, 1, 'the step must send one request')
  const request = sent[0]
  assert.equal(request.op, 'rootCause', 'the analysis is its own write')
  assert.equal(request.content, '原因分析：学校侧班级数据缺失。', 'the analysis must travel')
  assert.equal(request.ticketId, ticket.ticketId)
  assert.equal(request.taskId, ticket.taskId, 'the task id must travel, so the Host needs no extra read')
})

check('an empty analysis cannot be saved', () => {
  const scope = mountActions('rootCause', new Map([[ROW_SLOT.rootCause, '']]))
  const save = button(scope, 'row.rootCauseSave')
  assert.equal(save.props.disabled, true, 'the server needs an analysis, so the box cannot be empty')
})

check('确认完成 asks for no input', () => {
  const scope = mountActions('complete')
  assert.equal(byTag(scope.tree, 'textarea').length, 0, 'the completion holds no box')
  assert.ok(button(scope, 'row.completeConfirm'), 'the completion offers its confirm button')
})

check('确认完成 sends the completion without an analysis', async () => {
  sent.length = 0
  const scope = mountActions('complete')
  await button(scope, 'row.completeConfirm').props.onClick({})
  assert.equal(sent.length, 1, 'the completion must send one request')
  const request = sent[0]
  assert.equal(request.op, 'status')
  assert.equal(request.action, 'complete')
  assert.equal(request.rootCause, undefined, 'the analysis was recorded by its own step')
  assert.equal(request.comment, undefined, 'there is no separate conclusion to send')
  assert.equal(request.ticketId, ticket.ticketId)
})

check('a ticket without an analysis offers the analysis step only', () => {
  const labels = byTag(mountRow({ rootCauseReady: 'missing' }), 'button').map(node => node.props.children)
  assert.ok(labels.includes('row.rootCause'), 'the analysis step is the one on offer')
  assert.ok(!labels.includes('row.complete'), 'without an analysis there is nothing to close')
})

check('a ticket with an analysis offers the completion only', () => {
  const labels = byTag(mountRow({ rootCauseReady: 'ready' }), 'button').map(node => node.props.children)
  assert.ok(labels.includes('row.complete'), 'a recorded analysis brings the completion')
  assert.ok(!labels.includes('row.rootCause'), 'and the analysis step gives way to it')
})

check('the two closing steps never share a row', () => {
  for (const state of ['ready', 'missing', 'unknown', undefined]) {
    const labels = byTag(mountRow({ rootCauseReady: state }), 'button').map(node => node.props.children)
    const both = labels.includes('row.complete') && labels.includes('row.rootCause')
    assert.equal(both, false, `both links appeared at once for ${String(state)}`)
    assert.ok(
      labels.includes('row.complete') || labels.includes('row.rootCause'),
      `neither closing step was offered for ${String(state)}`,
    )
  }
})

check('an unreadable ticket keeps the analysis step', () => {
  // The panel could not read the task: it does not claim the analysis exists,
  // so the row keeps offering the step that writes it.
  const labels = byTag(mountRow({ rootCauseReady: 'unknown' }), 'button').map(node => node.props.children)
  assert.ok(labels.includes('row.rootCause'), 'the analysis step stays')
  assert.ok(!labels.includes('row.complete'), 'the completion waits for it')
})

check('a refused completion sends the user to the analysis step', async () => {
  sent.length = 0
  // Build the form once: the row element is stable, so the form keeps its own
  // state across the re-renders the outcome triggers.
  const rendered = mountRow({ rowMode: 'complete' })
  const actions = byComponent(rendered, 'RowActions')[0]
  const scope = live.mount('row', () => actions.type(actions.props))
  // The Host answers "no analysis yet" instead of closing the ticket.
  const original = panelProps.act
  panelProps.act = async (_sessionId, request) => {
    sent.push(request)
    return { action: { ok: false, needRootCause: true, message: '先填原因分析，再确认完成' } }
  }
  try {
    await button(scope, 'row.completeConfirm').props.onClick({})
    // The form reports the outcome from a promise callback.
    await new Promise(resolve => setTimeout(resolve, 0))
  } finally {
    panelProps.act = original
  }
  assert.equal(sent.length, 1, 'the completion was attempted')
  const said = []
  walk(scope.tree, node => {
    if (node && typeof node === 'object' && node.props && typeof node.props.children === 'string') said.push(node.props.children)
  })
  if (!said.some(text => String(text).includes('先填原因分析'))) {
    process.stdout.write(`        DEBUG texts: ${JSON.stringify(said).slice(0, 600)}\n`)
  }
  assert.ok(
    said.some(text => String(text).includes('先填原因分析')),
    'the refusal must be shown to the user',
  )
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
