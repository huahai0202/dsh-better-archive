import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

// The browser half is a hand-written zero-build bundle: there is no bundler or
// type checker between an edit and the browser, so a helper whose call sites
// survive its definition (a rename that left references behind) only blows up
// at runtime, in the GUI. `dropPendingDeleteId` shipped exactly that way —
// every unarchive entry point failed with a ReferenceError — and these two
// guards keep that class of mistake from shipping again: the module must
// evaluate under stubs, and every shared helper its call sites name must have
// a definition.

const source = await readFile(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

test('client module factory evaluates under a stubbed browser environment', () => {
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
  const exports = definition.factory(requireStub)
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
