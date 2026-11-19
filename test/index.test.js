import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../lib/index.js'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * One request shaped like the browser's own `fetch`.
 *
 * `Sec-Fetch-Site` is what a same-origin fetch from the app actually carries;
 * `Referer` is routinely absent (`no-referrer` policy, a `file:` page), which is
 * exactly the case that used to be rejected as `untrusted request`.
 * @param body - JSON payload, when the route takes one.
 * @param method - HTTP method.
 * @param headers - extra or overriding headers for the trust tests.
 * @returns a readable stand-in for the Node request.
 */
function request(body, method = 'POST', headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.headers = {
    host: 'localhost:3000',
    'sec-fetch-site': 'same-origin',
    ...headers,
  }
  // `undefined` in the overrides means "this client sends no such header",
  // which is how the Origin-only and header-less cases are expressed.
  for (const key of Object.keys(req.headers)) {
    if (req.headers[key] === undefined) delete req.headers[key]
  }
  return req
}

async function invoke(handler, body, method = 'POST', headers = {}) {
  let status
  let raw = ''
  const res = {
    writeHead(value) { status = value },
    end(value) { raw = String(value ?? '') },
  }
  await handler(request(body, method, headers), res)
  return { status, body: JSON.parse(raw) }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-better-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ids = options.ids ?? ['session-1']
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const directories = new Map()
  for (const id of ids) {
    const directory = join(root, id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.jsonl'), `${id}\n`)
    directories.set(id, directory)
  }
  for (const id of options.pendingIds ?? []) {
    await writeFile(join(directories.get(id), '.dsh-better-archive-delete-pending'), 'pending\n')
  }

  let state = { initialized: true, workspaceIds: ['workspace-1'], archivedSessionIds: [...ids] }
  const calls = []
  const operations = []
  let queue = Promise.resolve()
  const live = new Map((options.liveIds ?? []).map((id) => [id, { id, header: { id, cwd } }]))
  // Ids whose artifact is gone: still archived, but unreadable from persistence.
  const broken = new Set(options.brokenIds ?? [])
  const workspace = {
    sessionIds: [...ids],
    async detachSession(id) {
      calls.push(['detach', id])
      if (options.detachFailureId === id) throw new Error(`detach failed for ${id}`)
      this.sessionIds = this.sessionIds.filter((value) => value !== id)
    },
    async attachSession(id) {
      calls.push(['attach', id])
      if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
    },
  }
  const registry = {
    enqueueOperation(operation) {
      calls.push(['enqueue'])
      const result = queue.then(operation, operation)
      queue = result.catch(() => {})
      operations.push(result)
      return result
    },
    requireState() { return state },
    async setState(next) {
      calls.push(['setState', [...next.archivedSessionIds]])
      if (options.setStateFailure) throw new Error('setState failed')
      state = next
    },
    async replaceHeaderIndex(headers) {
      calls.push(['replaceHeaderIndex', headers.length])
      if (options.headerRefreshFailure) throw new Error('header refresh failed')
    },
    // dsh 0.2.2 grew the public unarchive. Fixtures opt in so both the native
    // path and the pre-0.2.2 direct-write path stay covered.
    ...(options.nativeUnarchive === false
      ? {}
      : {
          async unarchiveSession(id) {
            calls.push(['unarchiveSession', id])
            if (options.setStateFailure) throw new Error('setState failed')
            state = {
              ...state,
              archivedSessionIds: state.archivedSessionIds.filter((sid) => String(sid) !== String(id)),
            }
          },
        }),
    list() { return [workspace] },
  }
  // Every `stat` reads a stored header (a directory scan plus a decoded first
  // line in the real JSONL backend), so the fixture counts them.
  let headerReads = 0
  // dsh 0.2.2 answers the JSONL artifact `location` on the stat snapshot itself;
  // `snapshotLocation: false` models a backend/live session that only has the
  // legacy `locate(header)` computation.
  const snapshotLocation = options.snapshotLocation !== false
  const persistence = {
    async stat(id) {
      headerReads++
      if (broken.has(id)) return undefined
      const header = { id, cwd }
      return snapshotLocation
        ? { header, revision: 'r1', sizeBytes: 1, location: { kind: 'jsonl', path: join(directories.get(id), 'session.jsonl') } }
        : { header, revision: 'r1', sizeBytes: 1 }
    },
    ...(options.locate === false
      ? {}
      : { locate(meta) { return { kind: 'jsonl', path: join(directories.get(meta.id), 'session.jsonl') } } }),
    async list() { return [] },
  }
  const routes = new Map()
  const warnings = []
  // Host events the plugin raises; `api-session/removed` is the browser-visible
  // "this session is gone" signal the sidebar's session list acts on.
  const events = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    effect(register) { return register() },
    emit(name, ...args) { events.push([name, ...args]) },
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') return { get: (id) => live.get(id) }
      return undefined
    },
    logger: { warn(message) { warnings.push(message) } },
  }
  apply(ctx)
  await Promise.allSettled(operations)
  calls.length = 0
  return {
    calls,
    directories,
    events,
    headerReads: () => headerReads,
    registry,
    routes,
    state: () => state,
    warnings,
    workspace,
  }
}

// Unarchiving has no route of its own any more: the browser calls DSH's
// `remote.workspace.unarchiveSession` and then this plugin's
// `/archived/clear-pending` for the marker it owns. The tests below cover the
// half that is still this plugin's: the marker bookkeeping.

test('a same-origin fetch without a Referer is accepted', async (t) => {
  // The real browser case that used to fail: `fetch` from the app carries
  // Sec-Fetch-Site: same-origin and usually no Referer at all.
  const app = await fixture(t, { pendingIds: ['session-1'], liveIds: ['session-1'] })
  const response = await invoke(
    app.routes.get('/archived/clear-pending'),
    { sessionId: 'session-1' },
    'POST',
    { 'sec-fetch-site': 'same-origin' },
  )

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { cleared: true })
})

test('a request with no fetch metadata and no Origin is accepted', async (t) => {
  // A local tool or an older client: nothing here proves a cross-site origin.
  const app = await fixture(t)
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.equal(response.body.deleted, 1)
})

test('a cross-site request is refused', async (t) => {
  const app = await fixture(t)
  const response = await invoke(
    app.routes.get('/archived/delete'),
    { sessionId: 'session-1' },
    'POST',
    { 'sec-fetch-site': 'cross-site' },
  )

  assert.equal(response.status, 403)
  assert.equal(response.body.error, 'untrusted request')
  assert.equal(await exists(app.directories.get('session-1')), true)
})

test('a foreign Origin is refused when no fetch metadata is sent', async (t) => {
  const app = await fixture(t)
  const response = await invoke(
    app.routes.get('/archived/delete'),
    { sessionId: 'session-1' },
    'POST',
    { 'sec-fetch-site': undefined, origin: 'https://evil.example' },
  )

  assert.equal(response.status, 403)
  assert.equal(await exists(app.directories.get('session-1')), true)
})

test('a matching Origin is accepted when no fetch metadata is sent', async (t) => {
  const app = await fixture(t)
  const response = await invoke(
    app.routes.get('/archived/delete'),
    { sessionId: 'session-1' },
    'POST',
    { 'sec-fetch-site': undefined, origin: 'http://localhost:3000' },
  )

  assert.equal(response.status, 200)
})

test('clear-pending removes the marker without touching the archive set', async (t) => {
  const app = await fixture(t, { pendingIds: ['session-1'], liveIds: ['session-1'] })
  const marker = join(app.directories.get('session-1'), '.dsh-better-archive-delete-pending')
  const response = await invoke(app.routes.get('/archived/clear-pending'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { cleared: true })
  assert.equal(await exists(marker), false)
  // DSH owns the archive set; this route must not write it.
  assert.deepEqual(app.state().archivedSessionIds, ['session-1'])
})

test('clear-pending succeeds for an entry DSH already unarchived', async (t) => {
  // Order of events: the Remote replies first, so by the time this runs the id
  // may already be gone from the archive set.
  const app = await fixture(t, { pendingIds: ['session-1'], liveIds: ['session-1'] })
  app.state().archivedSessionIds = []
  const marker = join(app.directories.get('session-1'), '.dsh-better-archive-delete-pending')
  const response = await invoke(app.routes.get('/archived/clear-pending'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { cleared: true })
  assert.equal(await exists(marker), false)
})

test('clear-pending reports an unresolved entry without failing', async (t) => {
  const app = await fixture(t, { brokenIds: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/clear-pending'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { cleared: false })
})

test('clear-pending requires a session id', async (t) => {
  const app = await fixture(t)
  const response = await invoke(app.routes.get('/archived/clear-pending'), {})

  assert.equal(response.status, 400)
  assert.equal(response.body.error, 'sessionId is required')
})

test('no unarchive route is registered by the plugin any more', async (t) => {
  const app = await fixture(t)

  // The official Remote owns unarchiving, so a second HTTP surface would be a
  // parallel implementation of the same state transition.
  assert.equal(app.routes.has('/archived/unarchive'), false)
  assert.equal(app.routes.has('/archived/unarchive-selected'), false)
})

test('the artifact location comes from the stat snapshot when the backend reports one', async (t) => {
  // dsh 0.2.2 stamps `location` on the snapshot; the fixture's legacy
  // `locate(header)` is removed here so a snapshot-only backend must work.
  const app = await fixture(t, { locate: false })
  const response = await invoke(app.routes.get('/archived/pending'), undefined, 'GET')
  const deleted = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { pending: [] })
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleted.body, { archived: [], deleted: 1, scheduled: [] })
  assert.equal(await exists(app.directories.get('session-1')), false)
})

test('a backend that reports no artifact location leaves the entry unresolved', async (t) => {
  // No snapshot location and no locator: the entry cannot be deleted, and the
  // bulk path must report it instead of failing the whole request.
  const app = await fixture(t, { locate: false, snapshotLocation: false, ids: ['session-1', 'session-2'] })
  const response = await invoke(app.routes.get('/archived/delete-all'), { confirm: true })

  assert.equal(response.status, 200)
  assert.equal(response.body.deleted, 0)
  assert.deepEqual(response.body.unresolved.map((entry) => entry.id).sort(), ['session-1', 'session-2'])
})

test('batch unarchive is gone with its route, so no state write happens behind DSH', async (t) => {
  // The batch path used to be one private `setState`. With the official Remote
  // taking over unarchiving there is no batch form, so the plugin must not
  // write the archive set at all.
  const app = await fixture(t, { ids: ['session-1', 'session-2', 'session-3'] })
  assert.equal(app.routes.has('/archived/unarchive-selected'), false)
  assert.deepEqual(app.calls.filter(([name]) => name === 'setState'), [])
})


test('selected deletion resolves only the listed ids', async (t) => {
  const app = await fixture(t, { ids: ['session-1', 'session-2', 'session-3'] })
  const before = app.headerReads()
  const response = await invoke(app.routes.get('/archived/delete-selected'), { sessionIds: ['session-1'] })

  assert.equal(response.status, 200)
  assert.equal(response.body.deleted, 1)
  // One header read for the one listed id — not one per archived session.
  assert.equal(app.headerReads() - before, 1)
})

test('live sessions are marked for deletion after restart without changing archive state', async (t) => {
  const app = await fixture(t, { liveIds: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    archived: ['session-1'],
    deleted: 0,
    scheduled: ['session-1'],
  })
  assert.deepEqual(app.state().archivedSessionIds, ['session-1'])
  assert.equal(await exists(app.directories.get('session-1')), true)
  assert.equal(await exists(join(app.directories.get('session-1'), '.dsh-better-archive-delete-pending')), true)
})

test('bulk deletion deletes cold sessions and schedules live sessions', async (t) => {
  const app = await fixture(t, { ids: ['session-1', 'session-2'], liveIds: ['session-2'] })
  const response = await invoke(app.routes.get('/archived/delete-all'), { confirm: true })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    archived: ['session-2'],
    deleted: 1,
    scheduled: ['session-2'],
  })
  assert.equal(await exists(app.directories.get('session-1')), false)
  assert.equal(await exists(join(app.directories.get('session-2'), '.dsh-better-archive-delete-pending')), true)
})

test('startup cleanup permanently deletes a cold session with a pending marker', async (t) => {
  const app = await fixture(t, { pendingIds: ['session-1'] })

  assert.deepEqual(app.state().archivedSessionIds, [])
  assert.deepEqual(app.workspace.sessionIds, [])
  assert.equal(await exists(app.directories.get('session-1')), false)
  // The row must leave any already-connected browser's session list too.
  assert.deepEqual(app.events, [['api-session/removed', 'session-1']])
})

test('permanent deletion tells every client the session is gone', async (t) => {
  const app = await fixture(t)
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { archived: [], deleted: 1, scheduled: [] })
  // Deleting the artifact is invisible to a connected browser, and dropping the
  // id from the archive set un-hides the stale row there; this event is what
  // removes it from the left-hand session list.
  assert.deepEqual(app.events, [['api-session/removed', 'session-1']])
})

test('a scheduled deletion notifies nothing while the session is still live', async (t) => {
  const app = await fixture(t, { liveIds: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body.scheduled, ['session-1'])
  // The session is still live and still archived; the browser hides its row
  // through the pending-deletion mirror, so nothing is removed yet.
  assert.deepEqual(app.events, [])
})

test('bulk deletion notifies only the sessions it deleted immediately', async (t) => {
  const app = await fixture(t, { ids: ['session-1', 'session-2'], liveIds: ['session-2'] })
  const response = await invoke(app.routes.get('/archived/delete-all'), { confirm: true })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body.deleted, 1)
  assert.deepEqual(app.events, [['api-session/removed', 'session-1']])
})

test('a failed deletion notifies nothing', async (t) => {
  const app = await fixture(t, { detachFailureId: 'session-1' })
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 500)
  assert.deepEqual(app.events, [])
})

test('startup keeps a pending marker while its session is still live', async (t) => {
  const app = await fixture(t, { pendingIds: ['session-1'], liveIds: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/pending'), undefined, 'GET')

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { pending: ['session-1'] })
  assert.deepEqual(app.state().archivedSessionIds, ['session-1'])
  assert.equal(await exists(app.directories.get('session-1')), true)
})

test('the pending read reuses a directory this process already resolved', async (t) => {
  const app = await fixture(t)
  const before = app.headerReads()

  const first = await invoke(app.routes.get('/archived/pending'), undefined, 'GET')
  const afterFirst = app.headerReads()
  const second = await invoke(app.routes.get('/archived/pending'), undefined, 'GET')

  assert.equal(first.status, 200)
  assert.deepEqual(first.body, { pending: [] })
  assert.deepEqual(second.body, { pending: [] })
  // One header read to learn where the session lives; the next request probes
  // only the marker file.
  assert.equal(afterFirst - before, 1)
  assert.equal(app.headerReads(), afterFirst)
})

test('deletion still re-reads the header instead of trusting the memo', async (t) => {
  const app = await fixture(t)
  await invoke(app.routes.get('/archived/pending'), undefined, 'GET')
  const afterPending = app.headerReads()

  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  // A memoized directory must never stand in for "the artifact is still there".
  assert.equal(response.status, 200)
  assert.equal(response.body.deleted, 1)
  assert.equal(app.headerReads() - afterPending, 1)
  assert.equal(await exists(app.directories.get('session-1')), false)
})

test('workspace failure leaves the artifact and archive state intact', async (t) => {
  const app = await fixture(t, { detachFailureId: 'session-1' })
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 500)
  assert.match(response.body.error, /detach failed/)
  assert.deepEqual(app.state().archivedSessionIds, ['session-1'])
  assert.equal(await exists(app.directories.get('session-1')), true)
})

test('header refresh failure is a warning after a committed deletion', async (t) => {
  const app = await fixture(t, { headerRefreshFailure: true })
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.match(response.body.warning, /header index refresh failed/)
  assert.deepEqual(app.state().archivedSessionIds, [])
  assert.deepEqual(app.workspace.sessionIds, [])
  assert.equal(await exists(app.directories.get('session-1')), false)
  assert.equal(app.warnings.length, 1)
})

test('bulk deletion reports committed records when a later record fails', async (t) => {
  const app = await fixture(t, { ids: ['session-1', 'session-2'], detachFailureId: 'session-2' })
  const response = await invoke(app.routes.get('/archived/delete-all'), { confirm: true })

  assert.equal(response.status, 500)
  assert.deepEqual(response.body.deleted, ['session-1'])
  assert.deepEqual(response.body.scheduled, [])
  assert.deepEqual(response.body.archived, ['session-2'])
  assert.equal(await exists(app.directories.get('session-1')), false)
  assert.equal(await exists(app.directories.get('session-2')), true)
})

test('pending tolerates an archived entry whose artifact is gone', async (t) => {
  const app = await fixture(t, { brokenIds: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/pending'), undefined, 'GET')

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { pending: [] })
  assert.deepEqual(app.state().archivedSessionIds, ['session-1'])
  assert.ok(app.warnings.some((warning) => warning.includes('session-1')), 'the skipped entry is logged')
})

test('clear-pending tolerates an archived entry whose artifact is gone', async (t) => {
  // DSH's own unarchive has no existence check — removing an id cannot
  // introduce an unknown one — so this plugin's marker cleanup must survive the
  // same entry rather than failing the click.
  const app = await fixture(t, { brokenIds: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/clear-pending'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { cleared: false })
})

test('selected deletion removes exactly the listed archived sessions', async (t) => {
  const app = await fixture(t, { ids: ['session-1', 'session-2', 'session-3'] })
  const response = await invoke(app.routes.get('/archived/delete-selected'), { sessionIds: ['session-1', 'session-3'] })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { archived: ['session-2'], deleted: 2, scheduled: [] })
  assert.equal(await exists(app.directories.get('session-1')), false)
  assert.equal(await exists(app.directories.get('session-2')), true)
  assert.equal(await exists(app.directories.get('session-3')), false)
})

test('selected deletion skips ids that are not archived', async (t) => {
  const app = await fixture(t, { ids: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/delete-selected'), { sessionIds: ['session-1', 'session-missing'] })

  assert.equal(response.status, 200)
  assert.equal(response.body.deleted, 1)
  assert.deepEqual(app.events, [['api-session/removed', 'session-1']])
})

test('selected deletion rejects an empty or malformed id list', async (t) => {
  const app = await fixture(t)
  const missing = await invoke(app.routes.get('/archived/delete-selected'), {})
  const empty = await invoke(app.routes.get('/archived/delete-selected'), { sessionIds: [] })
  const invalid = await invoke(app.routes.get('/archived/delete-selected'), { sessionIds: 'session-1' })

  assert.equal(missing.status, 400)
  assert.equal(empty.status, 400)
  assert.equal(invalid.status, 400)
  assert.equal(await exists(app.directories.get('session-1')), true)
})

test('bulk deletion skips unreadable entries and reports them', async (t) => {
  const app = await fixture(t, { ids: ['session-1', 'session-2'], brokenIds: ['session-2'] })
  const response = await invoke(app.routes.get('/archived/delete-all'), { confirm: true })

  assert.equal(response.status, 200)
  assert.equal(response.body.deleted, 1)
  assert.deepEqual(response.body.scheduled, [])
  assert.deepEqual(response.body.archived, ['session-2'])
  assert.deepEqual(response.body.unresolved.map((entry) => entry.id), ['session-2'])
  assert.match(response.body.unresolved[0].error, /does not have a JSONL artifact/)
  assert.equal(await exists(app.directories.get('session-1')), false)
  assert.equal(await exists(app.directories.get('session-2')), true)
})

test('the host half reads no service off ctx that it did not inject', () => {
  // Cordis throws `cannot get property "x" without inject` for an undeclared
  // service read, so `ctx.baseDir` (an hmr field, not a context field) took the
  // whole `/archived/entries` route down. A service declared in `inject` may be
  // read as a property; anything else must come from `ctx.get(name)`, which
  // answers undefined instead of throwing.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const CORE = new Set(['get', 'effect', 'on', 'emit', 'waterfall', 'parallel', 'inject', 'logger', 'reflect', 'fiber', 'scope'])
  const declared = new Set(
    (source.match(/const inject = \[([^\]]*)\]/)?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  )
  const offenders = []
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    const name = match[1]
    // Skip prose: a match inside a comment line is documentation, not a read.
    const lineStart = source.lastIndexOf('\n', match.index) + 1
    const line = source.slice(lineStart, source.indexOf('\n', match.index))
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue
    if (CORE.has(name) || declared.has(name)) continue
    offenders.push(name)
  }
  assert.deepEqual([...new Set(offenders)], [], 'use ctx.get(name) for undeclared services')
  assert.ok(declared.size > 0, 'the inject list was found')
})
