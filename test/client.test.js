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
 * against dsh 0.1.7-alpha.2's `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * 0.1.7 replaced the artboard-size export suffixes with size-neutral weights
 * (`IconArchiveOutline20` → `IconArchiveOutlineRegular`/`Medium`, with `size`
 * deciding the rendered pixels). The old names are gone from the module table,
 * and `Icon` renders nothing for an unresolved name, so a stale spelling loses
 * the glyph silently — in the GUI only.
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

/** Load the bundle factory under a browser-shaped stub and return its exports. */
function loadClient() {
  let definition
  const windowStub = {
    __ModuleLoader__: { load(def) { definition = def } },
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

test('apply registers the DSH surfaces the 0.1.7 contracts require', () => {
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
  const ctx = {
    get(name) {
      if (name === 'locale') return locale
      if (name === 'slots') return slots
      return undefined
    },
    effect(callback) { return callback() },
    sidebarRightTabs: { register(definition) { tabs.push(definition); return () => {} } },
    sidebarRight: { openTab() {} },
    uiWorkspace: { openSession() {}, startSession() {} },
  }

  exports.apply(ctx)

  assert.equal(tabs.length, 1, 'the right-Sidebar page type registers exactly once')
  const definition = tabs[0]
  assert.equal(definition.kind, 'archive')
  assert.equal(typeof definition.title, 'function')

  // dsh 0.1.7 gives every guide entry a stable identity: it keys the entry's
  // slot cell and rejects duplicates within one provider, so an entry without
  // an id is a wiring mistake there.
  assert.equal(definition.guide.length, 1)
  assert.equal(typeof definition.guide[0].id, 'string')
  assert.ok(definition.guide[0].id.length > 0, 'the guide entry carries a stable id')
  assert.equal(typeof definition.guide[0].title, 'function', 'guide copy stays thunked for live locale switches')
  assert.equal(typeof definition.guide[0].icon, 'function', 'the guide entry draws the archive glyph, not a placeholder')

  const byName = new Map(slotRegistrations.map((options) => [options.name, options]))
  assert.deepEqual(
    [...byName.keys()].sort(),
    ['settings.section', 'shell.overlay', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'],
  )
  // The keyed seats dispatch by the type id, so both bodies must sit in the
  // cell named after the very definition registered above.
  assert.equal(byName.get('sidebar.right.pane.tab').key, definition.id)
  assert.equal(byName.get('sidebar.right.pane.tab.title').key, definition.id)
})

test('every product glyph the client draws is a 0.1.7 export name', () => {
  const used = new Set([...source.matchAll(/['"](Icon[A-Za-z0-9]+)['"]/g)].map((match) => match[1]))
  assert.ok(used.size > 0, 'expected the client to draw at least one glyph')
  for (const name of used) {
    assert.ok(
      VERIFIED_GLYPHS.has(name),
      `'${name}' is not one of the size-neutral dsh 0.1.7 primitives exports; ` +
        'the artboard-size spellings of 0.1.5/0.1.6 resolve to nothing at runtime',
    )
  }
})
