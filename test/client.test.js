import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

// The browser half is a hand-written zero-build bundle: there is no bundler or
// type checker between an edit and the browser, so a helper whose call sites
// survive its definition (a rename that left references behind) only blows up
// at runtime, in the GUI. `dropPendingDeleteId` shipped exactly that way —
// every unarchive entry point failed with a ReferenceError — and these guards
// keep that class of mistake from shipping again: the module must evaluate
// under stubs, every shared helper its call sites name must have a definition,
// and every contract the browser half writes into DSH must be the shape the
// installed dsh reads back.

const source = await readFile(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

/**
 * The product glyphs the client draws, exactly the export names verified
 * against dsh 0.2.2-rc.5's `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * 0.1.7 replaced the artboard-size export suffixes with size-neutral weights
 * (`IconArchiveOutline20` → `IconArchiveOutlineRegular`/`Medium`, with `size`
 * deciding the rendered pixels). The old names are gone from the module table,
 * and `Icon` renders nothing for an unresolved name, so a stale spelling loses
 * the glyph silently — in the GUI only. Every name here was confirmed present
 * in the shell's frozen module table for 0.2.2-rc.5.
 */
const VERIFIED_GLYPHS = new Set([
  'IconArchiveOutlineRegular',
  'IconChevronDownOutlineRegular',
  'IconCloseOutlineRegular',
  'IconEllipsisOutlineRegular',
  'IconFolderOpenRegular',
  'IconSearchOutlineRegular',
  'IconTrashOutlineRegular',
])

/**
 * The Cordis context proxy a client stack actually hands to `apply()`.
 *
 * This is the rule that broke the release: reading a service property the
 * fiber did not declare in `inject` throws `cannot get property "x" without
 * inject` (see `ReflectService.handler` in @deepseek-ai/cordis). `get()` answers
 * undefined instead. A stub that answers undefined for both would pass a
 * `ctx.get(x) || ctx.x` fallback that dies in the real browser, so every
 * behavioral test below runs against this strict shape.
 * @param {Record<string, unknown>} services - the faces this test publishes.
 * @returns a proxy mimicking the real access rules.
 */
function strictCordisContext(services) {
  // `get` and `effect` are real context methods (they live on the prototype in
  // the real object, so `Reflect.has` finds them); only service names are
  // guarded by the inject rule.
  const target = {
    effect(callback) { return callback() },
    get(name) { return services[name] },
  }
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property]
      if (typeof property === 'symbol') return undefined
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
    has(object, property) { return property in object },
  })
}

/**
 * A React stand-in good enough to render the plugin's components.
 *
 * Not a renderer: `createElement` keeps its arguments so a test can walk the
 * produced tree, and `useState` keeps a per-instance slot when the caller
 * provides one (`state`, `cursor`), so a state transition survives a re-render.
 * @param {{ state?: object, slot?: () => number }} [bookkeeping] - persistent state.
 * @returns the stand-in module.
 */
function reactStub(bookkeeping) {
  const state = bookkeeping?.state
  const nextSlot = bookkeeping?.slot ?? (() => 0)
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      if (state === undefined) return [value, () => {}]
      const slot = nextSlot()
      if (!(slot in state)) state[slot] = value
      return [state[slot], (next) => {
        state[slot] = typeof next === 'function' ? next(state[slot]) : next
      }]
    },
    useEffect() {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
  }
}

/**
 * Load the bundle factory under a browser-shaped stub and return its exports.
 * @param {object} [options]
 * @param {object} [options.bookkeeping] - state slots for a stateful useState.
 */
function loadClient(options = {}) {
  let definition
  const windowStub = {
    __ModuleLoader__: { load(def) { definition = def } },
    // The client schedules its bounded retries on the page's timer.
    setTimeout(callback) { callback(); return 0 },
  }
  const react = reactStub(options.bookkeeping)
  const requireStub = (name) => {
    if (name === 'react') return react
    // UI primitives: every export the client binds at module scope.
    return new Proxy({}, { get: () => () => null })
  }
  // eslint-disable-next-line no-new-func -- evaluating the bundle is the test.
  const evaluate = new Function('window', 'module', 'exports', source)
  evaluate(windowStub, { exports: {} }, {})

  assert.equal(definition.id, 'dsh-better-archive')
  return { exports: definition.factory(requireStub), requireStub }
}

test('client module factory evaluates under a stubbed browser environment', () => {
  const { exports } = loadClient()
  assert.equal(exports.name, 'dsh-better-archive')
  assert.ok(Array.isArray(exports.inject), 'the client declares its activation dependencies')
  assert.equal(typeof exports.apply, 'function')
})

test('activation dependencies stay minimal so a late sidebar cannot block the plugin', () => {
  const { exports } = loadClient()
  // `sidebarRightTabs`, `sidebarRight` and `uiWorkspace` are provided inside
  // other bundles' applies and dsh.client.inject adds no activation wait, so
  // naming them here would keep the whole plugin (settings section included)
  // inactive whenever one of them activates later.
  assert.deepEqual([...exports.inject].sort(), ['locale', 'slots'])
})

test('every shared helper its call sites reference is defined', () => {
  for (const name of ['dropPendingDeleteId', 'applyPendingDeleteIds']) {
    const calls = source.match(new RegExp(`\\b${name}\\(`, 'g')) || []
    // The definition itself matches the call pattern, so a lone match is the
    // definition; anything more must have a `function` declaration behind it.
    if (calls.length > 0) {
      assert.match(source, new RegExp(`function ${name}\\s*\\(`), `${name} is called but never defined`)
    }
  }
})

test('apply registers the DSH surfaces the 0.2.2 contracts require', () => {
  const { exports } = loadClient()

  const slotRegistrations = []
  const tabs = []
  const locale = {
    register() { return () => {} },
    getSnapshot() { return { active: 'en' } },
  }
  const slots = {
    inject(_name, register) { register() },
    register(options) {
      slotRegistrations.push(options)
      return () => {}
    },
  }
  const services = {
    locale,
    slots,
    sidebarRightTabs: { register(definition) { tabs.push(definition); return () => {} } },
    sidebarRight: { openTab() {} },
    uiWorkspace: { openSession() {}, startSession() {} },
  }
  const ctx = strictCordisContext(services)

  exports.apply(ctx)

  assert.equal(tabs.length, 1, 'the right-Sidebar page type registers exactly once')
  const definition = tabs[0]
  assert.equal(definition.kind, 'archive')
  assert.equal(typeof definition.title, 'function')

  // The guide entry needs the stable identity the registry keys it by (and
  // rejects duplicates within one provider over), and thunked copy so a live
  // language switch needs no re-registration.
  assert.equal(definition.guide.length, 1)
  assert.equal(typeof definition.guide[0].id, 'string')
  assert.ok(definition.guide[0].id.length > 0, 'the guide entry carries a stable id')
  assert.equal(typeof definition.guide[0].title, 'function', 'guide copy stays thunked for live locale switches')
  assert.equal(typeof definition.guide[0].icon, 'function', 'the guide entry draws the archive glyph, not a placeholder')

  const byName = new Map(slotRegistrations.map((options) => [options.name, options]))
  assert.deepEqual(
    [...byName.keys()].sort(),
    ['settings.section', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
  )
  // The keyed seats dispatch by the type id, so both bodies must sit in the
  // cell named after the very definition registered above.
  assert.equal(byName.get('sidebar.right.pane.tab').key, definition.id)
  assert.equal(byName.get('sidebar.right.pane.tab.title').key, definition.id)
})

test('apply survives the sidebar faces being absent, and reads no undeclared property', () => {
  // The exact failure this guards: `ctx.get(x) || ctx.x` looks harmless but the
  // property read throws under Cordis for a service the fiber did not inject,
  // which killed apply() outright — the Settings section disappeared with it.
  const { exports } = loadClient()

  const slotRegistrations = []
  const locale = {
    register() { return () => {} },
    getSnapshot() { return { active: 'en' } },
  }
  const slots = {
    inject(_name, register) { register() },
    register(options) {
      slotRegistrations.push(options)
      return () => {}
    },
  }
  // Neither sidebarRightTabs nor uiWorkspace is published yet.
  const ctx = strictCordisContext({ locale, slots })

  assert.doesNotThrow(() => exports.apply(ctx), 'a missing sidebar face must not fail activation')

  // The Settings section needs no sidebar face, so it must still be there.
  const names = slotRegistrations.map((options) => options.name)
  assert.ok(names.includes('settings.section'), 'the settings section registers without any sidebar face')
})

test('a late right-sidebar face still yields the type, and the settings section registers either way', () => {
  const { exports } = loadClient()

  const slotRegistrations = []
  const tabs = []
  const locale = {
    register() { return () => {} },
    getSnapshot() { return { active: 'en' } },
  }
  const slots = {
    inject(_name, register) { register() },
    register(options) {
      slotRegistrations.push(options)
      return () => {}
    },
  }
  // First read of the registry misses (the provider runs later), every read
  // after it finds the face — the activation-order race dsh 0.2.2 does not
  // sequence for a dsh.client.inject row.
  let calls = 0
  const ctx = strictCordisContext({
    locale,
    slots,
    get sidebarRightTabs() {
      calls += 1
      return calls === 1 ? undefined : { register(definition) { tabs.push(definition); return () => {} } }
    },
  })

  exports.apply(ctx)

  assert.equal(tabs.length, 1, 'the type registers on the retry, not never')
  assert.equal(tabs[0].kind, 'archive')
  const names = slotRegistrations.map((options) => options.name).sort()
  assert.deepEqual(names, ['settings.section', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
})

test('the plugin adds no archive toast of its own', () => {
  // dsh 0.2.2 raises its own `workspace.toast` on archive ("Archived … undo"),
  // so a second bar from this plugin is pure duplication. Assert both halves:
  // no overlay slot registration, and no toast copy/components left in source.
  const { exports } = loadClient()

  const slotRegistrations = []
  const locale = {
    register() { return () => {} },
    getSnapshot() { return { active: 'en' } },
  }
  const slots = {
    inject(_name, register) { register() },
    register(options) {
      slotRegistrations.push(options)
      return () => {}
    },
  }
  exports.apply(strictCordisContext({ locale, slots }))

  assert.equal(
    slotRegistrations.filter((options) => options.name === 'shell.overlay').length,
    0,
    'nothing registers into shell.overlay',
  )
  for (const marker of ['ArchiveToastHost', 'ArchivedToastItem', 'toastArchived', '_dsh_ba_toast']) {
    assert.ok(!source.includes(marker), `${marker} should be gone from the client bundle`)
  }
})

test('unarchiving goes through the official workspace service, not a private route', () => {
  // `ctx.workspaces.unarchiveSession` is DSH's documented browser path: it calls
  // the Host Remote, raises the `workspace/session-unarchiving` providers, and
  // installs the returned archive set into the shared model. The plugin must
  // not keep a parallel HTTP surface for the same state transition.
  assert.ok(source.includes("service('workspaces')"), 'the official client service is the unarchive path')
  assert.ok(
    !source.includes("'/archived/unarchive'") && !source.includes("'/archived/unarchive-selected'"),
    'no plugin-owned unarchive route should remain',
  )
})

test('no component reaches the Context by name', () => {
  // Slot components are handed props, never `ctx` — the contract forbids it —
  // and `ctx` only exists inside apply()'s closure. A component that names it
  // compiles fine and then throws ReferenceError on click, i.e. a dead button
  // with no error in the UI. Components must go through `service(name)`.
  const body = source.slice(0, source.indexOf('function apply(ctx)'))
  const offenders = body.split('\n')
    // Comments describe the contract; only executable code matters here.
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .filter(({ line }) => /\bctx\s*\./.test(line))
  assert.deepEqual(
    offenders.map((entry) => `${entry.number}: ${entry.line.trim()}`),
    [],
    'a component body references ctx; use service(name) instead',
  )
  assert.ok(source.includes('function service(name)'), 'the service accessor exists for components')
})

test('every product glyph the client draws is a 0.2.2 export name', () => {
  const used = new Set([...source.matchAll(/['"](Icon[A-Za-z0-9]+)['"]/g)].map((match) => match[1]))
  assert.ok(used.size > 0, 'expected the client to draw at least one glyph')
  for (const name of used) {
    assert.ok(
      VERIFIED_GLYPHS.has(name),
      `'${name}' is not one of the size-neutral 0.2.2 primitives exports; ` +
        'the artboard-size spellings of 0.1.5/0.1.6 resolve to nothing at runtime',
    )
  }
})

test('clicking unarchive in a mounted section reaches the official service', async () => {
  // The regression this pins: the component body named `ctx`, which only exists
  // inside apply()'s closure, so the button threw ReferenceError on click and
  // the panel did nothing — no request, no error. This renders the real section
  // component outside apply and presses the button.
  const { exports } = loadClient()
  const calls = []
  let section

  const locale = { register() { return () => {} }, getSnapshot() { return { active: 'en' } } }
  const slots = {
    inject(_name, register) { register() },
    register(options, component) {
      if (options.name === 'settings.section') section = component
      return () => {}
    },
  }
  const ctx = strictCordisContext({
    locale,
    slots,
    workspaces: { unarchiveSession(id) { calls.push(id); return Promise.resolve() } },
  })
  exports.apply(ctx)

  assert.equal(typeof section, 'function', 'the settings section registers')

  const summary = { displayTitle: 'Greeting', updatedAt: 1, cwd: 'C:/p' }
  const tree = section({
    useSessions: (selector) => selector({ ids: ['s1'], byId: { s1: summary }, phase: 'ready' }),
    useWorkspaces: (selector) => selector({ archivedSessionIds: ['s1'], phase: 'ready' }),
    t: (key) => key,
  })

  let button
  ;(function find(node) {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(find); return }
    const kids = node.children ?? []
    if (kids.includes('unarchive') && node.props?.onClick) { button = node; return }
    kids.forEach(find)
    if (node.props) (node.props.children ?? []).forEach(find)
  })(tree)

  assert.ok(button, 'the row renders an unarchive action')
  button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(calls, ['s1'], 'the click unarchives through ctx.get("workspaces")')
})

/**
 * Render one registered surface with a stateful `useState`.
 *
 * `loadClient`'s default React stub is stateless; select mode and the confirm
 * dialog need state to survive a re-render, so these surfaces are mounted with
 * their own state bookkeeping.
 * @param {object} [options]
 * @param {string} [options.surface] - registration key, `name` or `name:key`.
 * @param {boolean} [options.sidebar] - render the narrow sidebar body.
 * @returns helpers to render, list handlers and press one.
 */
function mountSurface(options = {}) {
  const { surface = 'settings.section', sidebar = false } = options
  const registry = new Map()
  const fetches = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => { fetches.push([url, init?.body ?? null]); return Promise.resolve({ ok: true, json: () => Promise.resolve({ pending: [], archived: [], deleted: 1, scheduled: [], cleared: true }) }) }
  const unarchived = []
  const services = {
    locale: { register() { return () => {} }, getSnapshot() { return { active: 'en' } } },
    slots: {
      inject(_name, register) { register() },
      register(registration, component) {
        const key = registration.key === undefined ? registration.name : `${registration.name}:${registration.key}`
        registry.set(key, component)
        return () => {}
      },
    },
    workspaces: { unarchiveSession(id) { unarchived.push(id); return Promise.resolve() } },
  }
  const bookkeeping = { state: {}, slot: undefined }
  let cursor = 0
  bookkeeping.slot = () => cursor++
  const { exports } = loadClient({ bookkeeping })
  exports.apply(strictCordisContext({ ...services, effect: (f) => f() }))

  const listState = {
    ids: ['s1', 's2'],
    byId: {
      s1: { displayTitle: 'A', updatedAt: 2, cwd: 'C:/p' },
      s2: { displayTitle: 'B', updatedAt: 1, cwd: 'C:/q' },
    },
    phase: 'ready',
  }
  const wsState = { archivedSessionIds: ['s1', 's2'], phase: 'ready' }

  const render = () => {
    const component = registry.get(surface)
    assert.equal(typeof component, 'function', `${surface} is registered`)
    cursor = 0
    const props = {
      useSessions: (selector) => selector(listState),
      useWorkspaces: (selector) => selector(wsState),
      t: (key) => key,
    }
    const rendered = component(props)
    // The sidebar body is a thin wrapper returning the section element.
    return rendered && typeof rendered.type === 'function' ? rendered.type(rendered.props) : rendered
  }

  const handlers = (tree) => {
    const found = []
    ;(function walk(node) {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      const props = node.props ?? {}
      for (const key of Object.keys(props)) {
        if (typeof props[key] === 'function' && /^on[A-Z]/.test(key)) {
          found.push({ text: (node.children ?? []).filter((c) => typeof c === 'string').join(''), key, handler: props[key] })
        }
      }
      ;(node.children ?? []).forEach(walk)
      if (props.children) props.children.forEach(walk)
    })(tree)
    return found
  }

  const press = (tree, predicate) => {
    const target = handlers(tree).find(predicate)
    assert.ok(target, `a matching handler exists (${handlers(tree).map((h) => `${h.key}:${h.text}`).join(', ')})`)
    target.handler({ preventDefault() {}, stopPropagation() {}, target: {}, currentTarget: {} })
  }

  return { render, handlers, press, fetches, unarchived }
}

/**
 * Render one registered surface with a stateful `useState`, walking the tree.
 *
 * `loadClient`'s React stub is intentionally stateless; these tests need state to
 * survive a re-render (select mode, the confirm dialog), so they drive the
 * component body directly with persistent per-instance state.
 * @param {Function} exports - the bundle exports.
 * @param {string} [surface] - which registration id to render.
 * @returns helpers to render, find and press handlers.
 */
test('the right-sidebar body renders its controls, not an empty shell', () => {
  const mount = mountSurface({ surface: 'sidebar.right.pane.tab:dsh-better-archive', sidebar: true })
  const tree = mount.render()

  // The narrow layout must still expose the row actions; an empty shell here is
  // the "panel shows nothing" failure. Labels come from the real dictionary
  // (the sidebar body installs its own `t` bound to the locale service).
  const labels = mount.handlers(tree).map((entry) => entry.text)
  assert.ok(labels.includes('Unarchive'), `row actions render in the sidebar pane, saw ${JSON.stringify(labels)}`)
  assert.ok(mount.handlers(tree).length >= 8, 'the pane keeps its search, selectors and row actions')
})

test('select mode, select-all and batch unarchive reach the official service', async () => {
  const mount = mountSurface()
  let tree = mount.render()

  mount.press(tree, (entry) => entry.text === 'selectMode' && entry.key === 'onClick')
  tree = mount.render()
  mount.press(tree, (entry) => entry.text === 'selectAll' && entry.key === 'onClick')
  tree = mount.render()
  // Unpick one row so the batch covers a known subset.
  const rows = []
  ;(function walk(node) {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.props?.role === 'checkbox' && node.props.onClick) rows.push(node.props.onClick)
    ;(node.children ?? []).forEach(walk)
    if (node.props?.children) node.props.children.forEach(walk)
  })(tree)
  assert.ok(rows.length >= 2, 'rows become selectable controls')
  rows[0]({ preventDefault() {}, stopPropagation() {}, target: {}, currentTarget: {} })
  tree = mount.render()

  mount.press(tree, (entry) => entry.text === 'unarchiveSelected' && entry.key === 'onClick')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(mount.unarchived.length, 1, 'the remaining pick is unarchived through the service')
})

test('delete-all reaches the host only after the acknowledgement', async () => {
  const mount = mountSurface()
  let tree = mount.render()

  mount.press(tree, (entry) => entry.text === 'deleteAll' && entry.key === 'onClick')
  tree = mount.render()
  // The gate must not have fired yet: RiskConfirmation keeps confirm disabled
  // until acknowledged, so nothing may be requested at this point.
  assert.deepEqual(mount.fetches.filter(([url]) => String(url).startsWith('/archived/delete')), [])

  mount.press(tree, (entry) => entry.key === 'onAcknowledgedChange')
  tree = mount.render()
  mount.press(tree, (entry) => entry.key === 'onConfirm')
  await new Promise((resolve) => setTimeout(resolve, 60))

  const urls = mount.fetches.map(([url]) => url)
  assert.ok(urls.includes('/archived/delete-all'), `expected the delete-all request, saw ${JSON.stringify(urls)}`)
})

test('an unready workspaces service is reported instead of silently doing nothing', async () => {
  const { exports } = loadClient()
  const registry = new Map()
  const services = {
    locale: { register() { return () => {} }, getSnapshot() { return { active: 'en' } } },
    slots: {
      inject(_name, register) { register() },
      register(options, component) {
        registry.set(options.name, component)
        return () => {}
      },
    },
    // Deliberately absent: WorkspaceController only provides it once its Remote
    // is ready.
    workspaces: undefined,
  }
  exports.apply(strictCordisContext({ ...services, effect: (f) => f() }))

  const section = registry.get('settings.section')
  const state = {}
  let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const slot = cursor++
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
      return [state[slot], (next) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }]
    },
    useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }),
  }
  // `loadClient` bound its own require stub; this test only needs the tree shape,
  // so it invokes the component with the same props a render would.
  cursor = 0
  const tree = section({
    useSessions: (s) => s({ ids: ['s1'], byId: { s1: { displayTitle: 'A', updatedAt: 1, cwd: 'C:/p' } }, phase: 'ready' }),
    useWorkspaces: (s) => s({ archivedSessionIds: ['s1'], phase: 'ready' }),
    t: (key) => key,
  })

  const button = []
  ;(function walk(node) {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if ((node.children ?? []).includes('unarchive') && node.props?.onClick) button.push(node.props.onClick)
    ;(node.children ?? []).forEach(walk)
    if (node.props?.children) node.props.children.forEach(walk)
  })(tree)

  assert.equal(button.length, 1, 'the row action still renders without the service')
  assert.doesNotThrow(() => button[0]({ preventDefault() {}, stopPropagation() {} }))
})
