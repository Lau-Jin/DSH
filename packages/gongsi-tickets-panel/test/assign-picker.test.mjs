/**
 * The 分派 (assign) picker of a ticket row.
 *
 * The picker must be one control: typing in it searches the user directory,
 * picking from it chooses the owner. Two separate boxes made the flow longer
 * than it needs to be.
 *
 * The row sits at the bottom of a panel that clips its overflow, so the list
 * of people has to open upward there — a list that opens downward is cut off
 * by the panel. And the directory is fetched over the command bridge, so the
 * keyword is debounced: one request per pause in typing, not one per
 * keystroke.
 *
 * The client half is loaded the way the browser loads it, through
 * `window.__ModuleLoader__.load`, and the React stub really holds state, so
 * the test can focus the box and watch where the list opens.
 *
 * Run it with `node test/assign-picker.test.mjs`.
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

/** The height of the window the panel is rendered in. */
const VIEWPORT_HEIGHT = 800

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
      innerHeight: VIEWPORT_HEIGHT,
      __ModuleLoader__: {
        load(def) {
          definition = def
        },
      },
    },
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    // The debounce of the directory request is a timer, and a context of its
    // own has none.
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
 * A setter re-renders the scope it belongs to, which is what lets the test
 * watch the list change the side it opens on.
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

  /**
   * Mount a root into a scope of its own.
   *
   * `initial` fills the state slots the root asks for, so a component can be
   * rendered with the state it would have in the running panel.
   */
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

/** The absolutely positioned box of a dropdown list. */
function dropdownOf(element) {
  return findAll(element, node => node.props?.style?.position === 'absolute')[0]
}

/** Wait for the given number of milliseconds. */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
  rowModes: 4,
}

/** The keywords the panel asked the user directory for. */
const requested = []

/** The props the shell hands to the panel. */
const panelProps = {
  t: key => key,
  loadTickets: async () => ({ tickets: [], total: 0, pages: 1, pageSize: 15 }),
  loadDetail: async () => ({}),
  act: async () => ({}),
  listUsers: async (_sessionId, keyword) => {
    requested.push(keyword)
    return []
  },
  meta: async () => ({ types: [] }),
  quote: () => {},
  useSessions: () => 'session-1',
  configForms: undefined,
}

/* ------------------------------------------------------------------ */
/* The panel, with the ticket list loaded and the row in assign mode.  */
/* ------------------------------------------------------------------ */

const definition = loadDefinition()
const live = createLiveReact()
const Panel = loadPanel(definition, live.React)

/** The state the panel is rendered with: one ticket, its row in assign mode. */
const panelState = new Map([
  [SLOT.cache, {
    all: { tickets: [ticket], total: 1, page: 1, pages: 1, pageSize: 15, me: { userId: 7, name: '李四' } },
    mine: null,
  }],
  [SLOT.rowModes, { [ticket.ticketNo]: 'assign' }],
])

/** Mount the panel with its list and the row in assign mode. */
function mountPanel() {
  return live.mount('panel', () => Panel(panelProps), panelState)
}

/** The assign form of the row, as the row renders it. */
function renderAssignForm() {
  const scope = mountPanel()
  const row = byComponent(scope.tree, 'TicketRow')[0]
  assert.ok(row, 'the panel must render a ticket row')
  const rendered = row.type(row.props)
  const actions = byComponent(rendered, 'RowActions')[0]
  assert.ok(actions, 'the row in assign mode must render the assign form')
  return actions
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

check('the assign form offers one box that searches and picks', () => {
  const actions = renderAssignForm()
  const rendered = actions.type(actions.props)
  const pickers = byComponent(rendered, 'RefSelect')
  assert.equal(pickers.length, 1, 'the assign form must hold exactly one picker')
  assert.ok(pickers[0].props.onSearch, 'the picker must search the directory while it is typed in')
  assert.ok(pickers[0].props.onPick, 'the picker must choose the owner while it is picked from')

  const box = pickers[0].type(pickers[0].props)
  assert.equal(byTag(box, 'input').length, 1, 'the picker must be one box')
  assert.equal(byTag(rendered, 'input').length, 0, 'the assign form must not add a second box next to the picker')
  assert.equal(byTag(rendered, 'select').length, 0, 'the people must not be chosen from a separate list box')
})

check('the picker offers the people of the directory', () => {
  const actions = renderAssignForm()
  const rendered = actions.type(actions.props)
  const picker = byComponent(rendered, 'RefSelect')[0]
  assert.ok(Array.isArray(picker.props.options), 'the picker must offer the people of the directory')
  assert.ok(picker.props.onSearch, 'the picker must search the directory while it is typed in')
})

check('the label shares the row with the box and the buttons', () => {
  const actions = renderAssignForm()
  const rendered = actions.type(actions.props)
  const picker = byComponent(rendered, 'RefSelect')[0]
  assert.equal(picker.props.inline, true, 'the assign field must put its label in the same row')

  // The field itself: the label stands beside the box, not above it.
  const field = picker.type(picker.props)
  assert.equal(field.props.style.flexDirection, 'row', 'the label and the box must be one row')
  assert.equal(field.props.style.alignItems, 'center', 'the label and the box must line up')
  const label = byTag(field, 'label')[0]
  assert.ok(label, 'the field must keep its label')
  assert.equal(label.props.style.whiteSpace, 'nowrap', 'the label must not wrap')

  // The box the list hangs from is the input, not the whole field, so the
  // list lines up with the input.
  const box = childrenOf(field).find(child => child?.props?.style?.position === 'relative')
  assert.ok(box, 'the input must have a box of its own for the list to hang from')
  assert.equal(byTag(box, 'input').length, 1, 'the box holds the input')

  // The bar: the buttons stand next to the field, on the same line.
  const bar = childrenOf(rendered)[0]
  assert.equal(bar.props.style.alignItems, 'center', 'the buttons must line up with the field')
})

check('the list opens downward when there is room below the box', () => {
  const actions = renderAssignForm()
  const picker = byComponent(actions.type(actions.props), 'RefSelect')[0]
  const scope = live.mount('picker:down', () => picker.type(picker.props))
  const input = byTag(scope.tree, 'input')[0]
  input.props.ref.current = { getBoundingClientRect: () => ({ top: 120, bottom: 150 }) }
  input.props.onFocus()
  const list = dropdownOf(scope.tree)
  assert.ok(list, 'the focused box must open its list')
  assert.equal(list.props.style.top, '100%', 'the list must hang below the box')
  assert.equal(list.props.style.bottom, undefined, 'the list must not also hang above the box')
})

check('the list opens upward when the box sits near the bottom edge', () => {
  const actions = renderAssignForm()
  const picker = byComponent(actions.type(actions.props), 'RefSelect')[0]
  const scope = live.mount('picker:up', () => picker.type(picker.props))
  const input = byTag(scope.tree, 'input')[0]
  input.props.ref.current = { getBoundingClientRect: () => ({ top: 700, bottom: 730 }) }
  input.props.onFocus()
  const list = dropdownOf(scope.tree)
  assert.ok(list, 'the focused box must open its list')
  assert.equal(list.props.style.bottom, '100%', 'the list must open upward, away from the bottom edge')
  assert.equal(list.props.style.top, undefined, 'the list must not also hang below the box')
})

check('the directory is asked once the typing pauses', async () => {
  requested.length = 0
  const actions = renderAssignForm()
  const scope = live.mount('row', () => actions.type(actions.props))
  // The first state of the form is the keyword of the picker.
  scope.states[0] = '张'
  scope.render()
  const effect = scope.effects[0]
  assert.ok(effect, 'the assign form must load the directory')
  const cleanup = effect.effect()
  assert.deepEqual(requested, [], 'the request must not go out while the keyword is still being typed')
  await delay(80)
  assert.deepEqual(requested, [], 'the request must wait for a pause in the typing')
  await delay(300)
  assert.deepEqual(requested, ['张'], 'the request must carry the keyword that was typed')
  cleanup?.()
})

check('a keyword that is replaced cancels the request before it', async () => {
  requested.length = 0
  const actions = renderAssignForm()
  const scope = live.mount('row:race', () => actions.type(actions.props))
  scope.states[0] = '张'
  scope.render()
  const first = scope.effects[0].effect()
  scope.states[0] = '张三'
  scope.render()
  const second = scope.effects[0].effect()
  first?.()
  await delay(300)
  assert.deepEqual(requested, ['张三'], 'only the keyword that was left alone may reach the server')
  second?.()
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
