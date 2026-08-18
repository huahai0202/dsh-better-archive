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
      state = next
    },
    async replaceHeaderIndex(headers) {
      calls.push(['replaceHeaderIndex', headers.length])
      if (options.headerRefreshFailure) throw new Error('header refresh failed')
    },
    list() { return [workspace] },
  }
  const persistence = {
    async inspect(id) { return { meta: { id, cwd } } },
    locate(meta) { return { kind: 'jsonl', path: join(directories.get(meta.id), 'session.jsonl') } },
    async list() { return [] },
  }
  const routes = new Map()
  const warnings = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    effect(register) { return register() },
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
  return { calls, directories, registry, routes, state: () => state, warnings, workspace }
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
