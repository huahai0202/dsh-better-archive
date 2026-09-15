import assert from 'node:assert/strict'
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

function request(body, method = 'POST') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.headers = { host: 'localhost:3000', referer: 'http://localhost:3000/settings' }
  return req
}

async function invoke(handler, body, method = 'POST') {
  let status
  let raw = ''
  const res = {
    writeHead(value) { status = value },
    end(value) { raw = String(value ?? '') },
  }
  await handler(request(body, method), res)
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
    list() { return [workspace] },
  }
  // Every `stat` reads a stored header (a directory scan plus a decoded first
  // line in the real JSONL backend), so the fixture counts them.
  let headerReads = 0
  const persistence = {
    async stat(id) {
      headerReads++
      return broken.has(id) ? undefined : { header: { id, cwd } }
    },
    locate(meta) { return { kind: 'jsonl', path: join(directories.get(meta.id), 'session.jsonl') } },
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

test('unarchive uses the registry queue and updates its cached state', async (t) => {
  const app = await fixture(t)
  const response = await invoke(app.routes.get('/archived/unarchive'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { archived: [] })
  assert.deepEqual(app.state().archivedSessionIds, [])
  assert.deepEqual(app.calls.slice(0, 2), [['enqueue'], ['setState', []]])
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

test('unarchive cancels a pending deletion before changing archive state', async (t) => {
  const app = await fixture(t, { pendingIds: ['session-1'], liveIds: ['session-1'] })
  const marker = join(app.directories.get('session-1'), '.dsh-better-archive-delete-pending')
  const response = await invoke(app.routes.get('/archived/unarchive'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { archived: [] })
  assert.equal(await exists(marker), false)
  assert.deepEqual(app.state().archivedSessionIds, [])
})

test('a failed unarchive keeps the session scheduled for deletion', async (t) => {
  const app = await fixture(t, { pendingIds: ['session-1'], liveIds: ['session-1'], setStateFailure: true })
  const marker = join(app.directories.get('session-1'), '.dsh-better-archive-delete-pending')
  const response = await invoke(app.routes.get('/archived/unarchive'), { sessionId: 'session-1' })

  // The archive set never changed, so the one write this call performed first —
  // clearing the marker — has to be undone or the scheduled deletion is lost.
  assert.equal(response.status, 500)
  assert.match(response.body.error, /setState failed/)
  assert.equal(await exists(marker), true)
  assert.deepEqual(app.state().archivedSessionIds, ['session-1'])
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

test('unarchive clears an archived entry whose artifact is gone', async (t) => {
  const app = await fixture(t, { brokenIds: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/unarchive'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { archived: [] })
  assert.deepEqual(app.state().archivedSessionIds, [])
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
