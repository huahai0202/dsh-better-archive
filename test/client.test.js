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

/** Load the bundle factory under a browser-shaped stub and return its exports. */
function loadClient() {
  let definition
  const windowStub = {
    __ModuleLoader__: { load(def) { definition = def } },
    // The client schedules its bounded retries on the page's timer.
    setTimeout(callback) { callback(); return 0 },
  }
  const requireStub = (name) => {
    if (name === 'react') {
      return {
        createElement: () => null,
        useState: (value) => [value, () => {}],
        useEffect: () => {},
        useRef: (value) => ({ current: value }),
      }
    }
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
